// Tests for firebase-store.js (Store Manager — Firebase integration).
// The module takes the `firebase` namespace as an argument, so the tests
// inject a fake with an in-memory store. No network, no credentials.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const StoreFB = require(path.join(__dirname, '..', 'firebase-store.js'));

const CONFIG = {
  apiKey: 'test-key', authDomain: 'store-3384c.firebaseapp.com',
  projectId: 'store-3384c', storageBucket: 'store-3384c.firebasestorage.app',
  messagingSenderId: '1', appId: '1:1:web:test'
};

function createFakeFirebase() {
  const store = {}; // 'collection/docId' -> data
  const callableCalls = [];
  const callableHandlers = {};
  let autoId = 0;

  function docRef(coll, id) {
    if (id === undefined || id === null) id = 'auto_' + (++autoId);
    return {
      id,
      path: coll + '/' + id,
      get: async () => {
        const data = store[coll + '/' + id];
        return { exists: data !== undefined, id, data: () => (data ? { ...data } : undefined) };
      },
      set: async (data) => { store[coll + '/' + id] = { ...data }; },
      onSnapshot: (cb) => {
        const data = store[coll + '/' + id];
        cb({ exists: data !== undefined, id, data: () => (data ? { ...data } : undefined) });
        return () => {};
      },
      collection: (sub) => collectionRef(coll + '/' + id + '/' + sub)
    };
  }
  function collectionRef(coll) {
    const q = {
      doc: (id) => docRef(coll, id),
      orderBy: () => q,
      limit: () => q,
      onSnapshot: (cb) => {
        const docs = Object.keys(store)
          .filter((k) => k.startsWith(coll + '/') && !k.slice(coll.length + 1).includes('/'))
          .map((k) => ({ id: k.slice(coll.length + 1), data: () => ({ ...store[k] }) }));
        cb({ forEach: (fn) => docs.forEach(fn), docs, empty: docs.length === 0 });
        return () => {};
      }
    };
    return q;
  }
  const db = {
    collection: (name) => collectionRef(name),
    batch: () => {
      const ops = [];
      return {
        set: (ref, data, opts) => { ops.push({ ref, data, merge: !!(opts && opts.merge) }); },
        commit: async () => {
          for (const op of ops) {
            store[op.ref.path] = op.merge
              ? { ...(store[op.ref.path] || {}), ...op.data }
              : { ...op.data };
          }
        }
      };
    }
  };
  const authState = { user: null, cbs: [] };
  const auth = {
    get currentUser() { return authState.user; },
    signInWithEmailAndPassword: async (email, password) => {
      if (password === 'wrong') {
        const e = new Error('bad password');
        e.code = 'auth/wrong-password';
        throw e;
      }
      authState.user = { uid: 'uid-admin', email };
      authState.cbs.forEach((cb) => cb(authState.user));
      return { user: authState.user };
    },
    signOut: async () => {
      authState.user = null;
      authState.cbs.forEach((cb) => cb(null));
    },
    setPersistence: async (mode) => {
      authState.persistence = mode;
    },
    onAuthStateChanged: (cb) => {
      authState.cbs.push(cb);
      cb(authState.user);
      return () => {};
    }
  };
  const apps = [];
  const fake = {
    apps,
    initializeApp: (cfg) => {
      const app = { options: cfg };
      apps.push(app);
      return app;
    },
    auth: () => auth,
    firestore: Object.assign(() => db, {
      FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true }) }
    }),
    functions: () => ({
      httpsCallable: (name) => async (data) => {
        callableCalls.push({ name, data });
        if (callableHandlers[name]) return callableHandlers[name](data);
        return { data: { ok: true } };
      }
    }),
    _store: store,
    _callableCalls: callableCalls,
    _callableHandlers: callableHandlers,
    _setRole: (uid, role) => { store['admins/' + uid] = { role }; }
  };
  fake.auth.Auth = { Persistence: { LOCAL: 'local', SESSION: 'session' } };
  fake._authState = authState;
  return fake;
}

async function signedInFb() {
  const fake = createFakeFirebase();
  fake._setRole('uid-admin', 'admin');
  const fb = StoreFB.create(fake, CONFIG);
  await fb.init();
  await fb.signIn('admin@store.test', 'correct');
  return { fake, fb };
}

test('order state machine: legal, illegal, same-state', () => {
  assert.equal(StoreFB.isAllowedOrderTransition('new', 'accepted'), true);
  assert.equal(StoreFB.isAllowedOrderTransition('new', 'delivered'), false);
  assert.equal(StoreFB.isAllowedOrderTransition('ready', 'in_transit'), true);
  assert.equal(StoreFB.isAllowedOrderTransition('in_transit', 'cancelled'), false);
  assert.equal(StoreFB.isAllowedOrderTransition('delivered', 'delivered'), true);
  assert.equal(StoreFB.isAllowedOrderTransition('cancelled', 'new'), false);
  assert.equal(StoreFB.isAllowedOrderTransition('new', 'expired'), true);
});

test('feedback state machine: legal, illegal, same-state', () => {
  assert.equal(StoreFB.isAllowedFeedbackTransition('new', 'in_review'), true);
  assert.equal(StoreFB.isAllowedFeedbackTransition('new', 'resolved'), false);
  assert.equal(StoreFB.isAllowedFeedbackTransition('in_review', 'awaiting_customer'), true);
  assert.equal(StoreFB.isAllowedFeedbackTransition('awaiting_customer', 'in_review'), true);
  assert.equal(StoreFB.isAllowedFeedbackTransition('resolved', 'closed'), true);
  assert.equal(StoreFB.isAllowedFeedbackTransition('closed', 'new'), false);
  assert.equal(StoreFB.isAllowedFeedbackTransition('spam', 'spam'), true);
});

test('validateTemplateDoc: the classic doc passes', () => {
  const report = StoreFB.validateTemplateDoc(StoreFB.CLASSIC_TEMPLATE);
  assert.deepEqual(report, { passed: true, failedChecks: [] });
});

test('validateTemplateDoc: bad docs fail with the right checks', () => {
  const base = StoreFB.CLASSIC_TEMPLATE;
  assert.deepEqual(StoreFB.validateTemplateDoc({ ...base, name: '  ' }).failedChecks, ['name']);
  assert.deepEqual(StoreFB.validateTemplateDoc({ ...base, schemaVersion: 2 }).failedChecks, ['schemaVersion']);
  assert.deepEqual(StoreFB.validateTemplateDoc({ ...base, version: 0 }).failedChecks, ['version']);
  assert.deepEqual(StoreFB.validateTemplateDoc({ ...base, status: 'live' }).failedChecks, ['status']);
  assert.deepEqual(
    StoreFB.validateTemplateDoc({ ...base, grid: { columns: 13, rows: null, minColumnWidthPx: 250 } }).failedChecks,
    ['grid.columns']);
  assert.deepEqual(
    StoreFB.validateTemplateDoc({ ...base, tokens: { ...base.tokens, accent: 'url(evil)' } }).failedChecks,
    ['tokens.accent']);
  assert.deepEqual(
    StoreFB.validateTemplateDoc({ ...base, tokens: { ...base.tokens, nope: '#fff' } }).failedChecks,
    ['tokens.nope']);
  assert.deepEqual(
    StoreFB.validateTemplateDoc({ ...base, tokens: { ...base.tokens, radius: '99px' } }).failedChecks,
    ['tokens.radius']);
  assert.deepEqual(
    StoreFB.validateTemplateDoc({ ...base, sections: { ...base.sections, hero: 'yes' } }).failedChecks,
    ['sections.hero']);
  assert.deepEqual(
    StoreFB.validateTemplateDoc({ ...base, bodyPath: 'other.json' }).failedChecks,
    ['bodyPath']);
  assert.equal(StoreFB.validateTemplateDoc(null).passed, false);
});

test('buildAuditEntry: single-doc status change records the sensitive value', () => {
  const entry = StoreFB.buildAuditEntry({
    opId: 'op-1', actor: 'uid-admin', actorName: 'admin@store.test',
    timestamp: { __serverTimestamp: true },
    operation: 'order_status',
    writes: { 'orders/o1': { status: 'accepted' } },
    sensitive: { 'orders/o1': { status: 'accepted' } },
    oldValues: { 'orders/o1': { status: 'new' } },
    topNewValues: { status: 'accepted' }
  });
  assert.equal(entry.operationId, 'op-1');
  assert.equal(entry.actor, 'uid-admin');
  assert.equal(entry.source, 'store_manager');
  assert.equal(entry.collection, 'orders');
  assert.equal(entry.docId, 'o1');
  // docIds covers the written field AND the stamped metadata.
  assert.deepEqual(entry.docIds['orders/o1'].sort(), ['operationId', 'status', 'updatedAt']);
  // The sensitive value is recorded with the value actually written.
  assert.deepEqual(entry.newValuesByDoc['orders/o1'], { status: 'accepted' });
  assert.equal(entry.timestamp.__serverTimestamp, true);
});

test('buildAuditEntry: two docs, same sensitive field, different values', () => {
  const entry = StoreFB.buildAuditEntry({
    opId: 'op-2', actor: 'uid-admin', actorName: '',
    timestamp: 0, operation: 'order_status',
    writes: { 'orders/o1': { status: 'accepted' }, 'orders/o2': { status: 'cancelled' } },
    sensitive: { 'orders/o1': { status: 'accepted' }, 'orders/o2': { status: 'cancelled' } },
    oldValues: {}, topNewValues: {}
  });
  // A flat newValues map could not hold both — the per-doc map must.
  assert.deepEqual(entry.newValuesByDoc['orders/o1'], { status: 'accepted' });
  assert.deepEqual(entry.newValuesByDoc['orders/o2'], { status: 'cancelled' });
  assert.deepEqual(entry.changedFields.sort(), ['operationId', 'status', 'updatedAt']);
});

test('auditedWrite: the doc and its audit entry land together', async () => {
  const { fake, fb } = await signedInFb();
  fake._store['orders/o1'] = { status: 'new', total: 100 };
  await fb.auditedWrite({
    writes: { 'orders/o1': { status: 'accepted' } },
    sensitive: { 'orders/o1': { status: 'accepted' } },
    operation: 'order_status',
    oldValues: { 'orders/o1': { status: 'new' } }
  });
  const order = fake._store['orders/o1'];
  assert.equal(order.status, 'accepted');
  assert.equal(order.total, 100); // merge, not replace
  assert.ok(order.operationId);
  assert.equal(order.updatedAt.__serverTimestamp, true);
  const auditKeys = Object.keys(fake._store).filter((k) => k.startsWith('audit/'));
  assert.equal(auditKeys.length, 1);
  const audit = fake._store[auditKeys[0]];
  assert.equal(audit.operationId, order.operationId);
  assert.equal(audit.actor, 'uid-admin');
  assert.deepEqual(audit.newValuesByDoc['orders/o1'], { status: 'accepted' });
  assert.ok(audit.docIds['orders/o1'].includes('status'));
});

test('updateOrderStatus: legal writes, illegal rejects, same-state is a no-op', async () => {
  const { fake, fb } = await signedInFb();
  fake._store['orders/o1'] = { status: 'new' };
  assert.equal(await fb.updateOrderStatus({ id: 'o1', status: 'new' }, 'accepted'), true);
  assert.equal(fake._store['orders/o1'].status, 'accepted');
  assert.equal(fake._store['orders/o1'].acceptedAt.__serverTimestamp, true);
  await assert.rejects(
    fb.updateOrderStatus({ id: 'o1', status: 'accepted' }, 'delivered'),
    /ماينفعش/);
  assert.equal(fake._store['orders/o1'].status, 'accepted'); // untouched
  assert.equal(await fb.updateOrderStatus({ id: 'o1', status: 'accepted' }, 'accepted'), false);
});

test('activateTemplate: validates, seeds classic, moves the pointer', async () => {
  const { fake, fb } = await signedInFb();
  fake._store['templates/dark'] = { ...StoreFB.CLASSIC_TEMPLATE, id: 'dark', name: 'داكن', status: 'draft' };
  const res = await fb.activateTemplate('dark');
  assert.deepEqual(res, { previousTemplateId: 'classic' });
  assert.equal(fake._store['templates/dark'].status, 'active');
  assert.equal(fake._store['templates/classic'].name, 'التصميم الحالي'); // auto-seeded
  const ptr = fake._store['storeSettings/activeTemplate'];
  assert.equal(ptr.templateId, 'dark');
  assert.equal(ptr.previousTemplateId, 'classic');
  await assert.rejects(fb.activateTemplate('dark'), /مفعّل أصلاً/);
  await assert.rejects(fb.activateTemplate('ghost'), /مش موجود/);
  fake._store['templates/broken'] = { name: '', schemaVersion: 2, status: 'draft', version: 0 };
  await assert.rejects(fb.activateTemplate('broken'), /مش صالح للتفعيل/);
});

test('createManualOrder: calls the callable with the exact input, maps errors', async () => {
  const { fake, fb } = await signedInFb();
  fake._callableHandlers.createManualOrder = async (data) => ({ data: { order: { id: 'o9' }, created: true } });
  const input = {
    clientOrderId: 'c-1',
    items: [{ productId: 'p1', qty: 2 }],
    discountCode: 'X10',
    customer: { name: 'أحمد', phone: '01012345678', address: 'القاهرة' },
    shippingCompanyId: 'ship-1',
    notes: 'ملاحظة'
  };
  const res = await fb.createManualOrder(input);
  assert.equal(res.order.id, 'o9');
  assert.equal(fake._callableCalls.length, 1);
  assert.equal(fake._callableCalls[0].name, 'createManualOrder');
  assert.deepEqual(fake._callableCalls[0].data, input);
  fake._callableHandlers.createManualOrder = async () => {
    const e = new Error('failed-precondition');
    e.code = 'failed-precondition';
    e.details = { code: 'INSUFFICIENT_STOCK', availableQty: 1 };
    throw e;
  };
  await assert.rejects(fb.createManualOrder(input), /أكبر من المتاح في المخزون/);
});

test('signIn: wrong password maps to Arabic; non-admin is refused', async () => {
  const fake = createFakeFirebase();
  fake._setRole('uid-admin', 'admin');
  const fb = StoreFB.create(fake, CONFIG);
  await fb.init();
  await assert.rejects(fb.signIn('admin@store.test', 'wrong'), /الإيميل أو كلمة السر غلط/);
  await fb.signIn('admin@store.test', 'correct');
  assert.equal(fb.state.connected, true);
  assert.equal(fb.state.role, 'admin');

  const fake2 = createFakeFirebase();
  fake2._setRole('uid-admin', 'viewer');
  const fb2 = StoreFB.create(fake2, CONFIG);
  await fb2.init();
  await assert.rejects(fb2.signIn('viewer@store.test', 'correct'), /مش أدمن/);
  assert.equal(fb2.state.connected, false);
});

test('subscribeActiveTemplate: returns the pointer template id', async () => {
  const { fake, fb } = await signedInFb();
  fake._store['storeSettings/activeTemplate'] = { templateId: 'dark', previousTemplateId: 'classic' };
  const id = await new Promise((resolve) => fb.subscribeActiveTemplate((v) => resolve(v)));
  assert.equal(id, 'dark');
});

test('subscribeOrders: returns the seeded orders with ids', async () => {
  const { fake, fb } = await signedInFb();
  fake._store['orders/o1'] = { status: 'new', total: 50, createdAt: 1 };
  fake._store['orders/o2'] = { status: 'accepted', total: 70, createdAt: 2 };
  const list = await new Promise((resolve) => fb.subscribeOrders((l) => resolve(l)));
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((o) => o.id).sort(), ['o1', 'o2']);
});

test('newUuid: UUID-shaped and unique', () => {
  const a = StoreFB.newUuid();
  const b = StoreFB.newUuid();
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a, b);
});

test('friendlyCallableError: maps the structured codes', () => {
  assert.equal(StoreFB.friendlyCallableError({ details: { code: 'PRICE_CHANGED' } }), 'اتغير سعر منتج من اللي شفتهم — راجع الأسعار وحاول تاني');
  assert.equal(StoreFB.friendlyCallableError({ details: { code: 'DISCOUNT_USED' } }), 'كود الخصم ده اتستخدم قبل كده');
  assert.equal(StoreFB.friendlyCallableError({ code: 'not-found' }), 'حصل خطأ: not-found');
});

test('updateOrderStatus: cancelling is an audited write with the audit entry', async () => {
  const { fake, fb } = await signedInFb();
  fake._store['orders/o1'] = { status: 'preparing', total: 250 };
  assert.equal(await fb.updateOrderStatus({ id: 'o1', status: 'preparing' }, 'cancelled'), true);
  assert.equal(fake._store['orders/o1'].status, 'cancelled');
  assert.ok(fake._store['orders/o1'].operationId);
  const auditKeys = Object.keys(fake._store).filter((k) => k.startsWith('audit/'));
  assert.equal(auditKeys.length, 1);
  const audit = fake._store[auditKeys[0]];
  assert.equal(audit.operation, 'order_status');
  assert.equal(audit.operationId, fake._store['orders/o1'].operationId);
  assert.deepEqual(audit.newValuesByDoc['orders/o1'], { status: 'cancelled' });
  assert.deepEqual(audit.oldValues, { status: 'preparing' });
});

test('updateOrderPaymentStatus: paid/unpaid is an audited write', async () => {
  const { fake, fb } = await signedInFb();
  fake._store['orders/o1'] = { status: 'delivered', paymentStatus: 'cod_pending' };
  assert.equal(await fb.updateOrderPaymentStatus({ id: 'o1', paymentStatus: 'cod_pending' }, 'cod_paid'), true);
  assert.equal(fake._store['orders/o1'].paymentStatus, 'cod_paid');
  const auditKeys = Object.keys(fake._store).filter((k) => k.startsWith('audit/'));
  assert.equal(auditKeys.length, 1);
  const audit = fake._store[auditKeys[0]];
  assert.equal(audit.operation, 'order_payment');
  assert.deepEqual(audit.newValuesByDoc['orders/o1'], { paymentStatus: 'cod_paid' });
  assert.equal(await fb.updateOrderPaymentStatus({ id: 'o1', paymentStatus: 'cod_paid' }, 'cod_paid'), false);
  assert.equal(Object.keys(fake._store).filter((k) => k.startsWith('audit/')).length, 1); // no-op wrote nothing
});

test('updateTemplateGrid: validates, then saves one audited write', async () => {
  const { fake, fb } = await signedInFb();
  fake._store['templates/dark'] = { ...StoreFB.CLASSIC_TEMPLATE, id: 'dark', name: 'داكن', grid: { columns: null, rows: null, minColumnWidthPx: 250 } };
  await assert.rejects(fb.updateTemplateGrid('dark', { columns: 13, rows: 2 }), /مش صالحة/);
  await assert.rejects(fb.updateTemplateGrid('dark', { columns: 3, rows: 0 }), /مش صالحة/);
  await assert.rejects(fb.updateTemplateGrid('ghost', { columns: 3, rows: 2 }), /مش موجود/);
  assert.equal(fake._store['templates/dark'].grid.columns, null); // nothing written by the rejects
  assert.equal(await fb.updateTemplateGrid('dark', { columns: 3, rows: 2 }), true);
  assert.deepEqual(fake._store['templates/dark'].grid, { columns: 3, rows: 2, minColumnWidthPx: 250 });
  const auditKeys = Object.keys(fake._store).filter((k) => k.startsWith('audit/'));
  assert.equal(auditKeys.length, 1);
  assert.equal(fake._store[auditKeys[0]].operation, 'template_grid');
  assert.equal(await fb.updateTemplateGrid('dark', { columns: null, rows: null }), true);
  assert.deepEqual(fake._store['templates/dark'].grid, { columns: null, rows: null, minColumnWidthPx: 250 });
});

test('gridCap: rows x columns, rows x 4 when auto-fill, null when show-all', () => {
  assert.equal(StoreFB.gridCap({ columns: 3, rows: 2 }), 6);
  assert.equal(StoreFB.gridCap({ columns: null, rows: 2 }), 8);
  assert.equal(StoreFB.gridCap({ columns: 4, rows: null }), null);
  assert.equal(StoreFB.gridCap(null), null);
});

test('computeStoreProfit: delivered/paid count, cancelled does not, missing cost is excluded and flagged', () => {
  const products = [
    { id: 'p1', name: 'منتج 1', costPrice: 40 },
    { id: 'p2', name: 'منتج 2' } // no cost anywhere
  ];
  const orders = [
    { id: 'o1', status: 'delivered', paymentStatus: 'cod_paid', total: 300, createdAt: '2026-11-20T10:00:00',
      items: [{ productId: 'p1', qty: 2, price: 100, subtotal: 200 }, { productId: 'p2', qty: 1, price: 100, subtotal: 100 }] },
    { id: 'o2', status: 'cancelled', paymentStatus: 'cod_pending', total: 500, createdAt: '2026-11-20T11:00:00',
      items: [{ productId: 'p1', qty: 5, price: 100, subtotal: 500 }] },
    { id: 'o3', status: 'in_transit', paymentStatus: 'cod_paid', total: 150, createdAt: '2026-11-21T10:00:00',
      items: [{ productId: 'p1', qty: 1, price: 150, subtotal: 150, unitCost: 60 }] }
  ];
  const r = StoreFB.computeStoreProfit(orders, products, {});
  assert.equal(r.revenue, 450); // o1 + o3; the cancelled o2 is not revenue
  assert.equal(r.cogs, 140); // p1: 2×40 + 1×60; the p2 item has no cost and is excluded
  assert.equal(r.gross, 310);
  assert.equal(r.missingCount, 1);
  assert.equal(r.missing[0].productId, 'p2');
  assert.equal(r.byProduct.p1.cost, 140);
  assert.equal(r.byProduct.p2.missingCost, true);
  // Date range filters by createdAt.
  const ranged = StoreFB.computeStoreProfit(orders, products, { from: '2026-11-21', to: '2026-11-21' });
  assert.equal(ranged.revenue, 150);
  assert.equal(ranged.cogs, 60);
});

test('setPersistenceMode: remember-me picks LOCAL, otherwise SESSION', async () => {
  const { fake, fb } = await signedInFb();
  await fb.setPersistenceMode(true);
  assert.equal(fake._authState.persistence, 'local');
  await fb.setPersistenceMode(false);
  assert.equal(fake._authState.persistence, 'session');
});
