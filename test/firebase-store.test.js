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
        if (fake._failGets) throw new Error('offline');
        const data = store[coll + '/' + id];
        return { exists: data !== undefined, id, data: () => (data ? { ...data } : undefined) };
      },
      set: async (data, opts) => {
        const key = coll + '/' + id;
        const next = (opts && opts.merge) ? { ...(store[key] || {}) } : {};
        Object.keys(data || {}).forEach((k) => {
          if (data[k] && data[k].__delete) delete next[k];
          else next[k] = data[k];
        });
        store[key] = next;
      },
      update: async (data) => {
        const key = coll + '/' + id;
        const next = { ...(store[key] || {}) };
        Object.keys(data || {}).forEach((k) => {
          if (data[k] && data[k].__delete) delete next[k];
          else next[k] = data[k];
        });
        store[key] = next;
      },
      delete: async () => { delete store[coll + '/' + id]; },
      onSnapshot: (cb) => {
        const data = store[coll + '/' + id];
        cb({ exists: data !== undefined, id, data: () => (data ? { ...data } : undefined) });
        return () => {};
      },
      collection: (sub) => collectionRef(coll + '/' + id + '/' + sub)
    };
  }
  function comparable(v) {
    if (v == null) return v;
    if (typeof v === 'object' && typeof v.seconds === 'number') return v.seconds * 1000;
    if (v instanceof Date) return v.getTime();
    if (v && v.__serverTimestamp) return Date.now();
    return v;
  }
  function collectionRef(coll) {
    const filters = [];
    const q = {
      doc: (id) => docRef(coll, id),
      orderBy: () => q,
      limit: () => q,
      where: (field, op, value) => { filters.push({ field, op, value }); return q; },
      get: async () => {
        const docs = Object.keys(store)
          .filter((k) => k.startsWith(coll + '/') && !k.slice(coll.length + 1).includes('/'))
          .map((k) => ({ id: k.slice(coll.length + 1), data: () => ({ ...store[k] }) }))
          .filter((d) => filters.every((f) => {
            const v = comparable(d.data()[f.field]);
            const want = comparable(f.value);
            if (f.op === '==') return v === want;
            if (f.op === '<') return v < want;
            if (f.op === '<=') return v <= want;
            if (f.op === '>') return v > want;
            return true;
          }));
        return { forEach: (fn) => docs.forEach(fn), docs, empty: docs.length === 0 };
      },
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
        delete: (ref) => { ops.push({ ref, del: true }); },
        commit: async () => {
          for (const op of ops) {
            if (op.del) { delete store[op.ref.path]; continue; }
            const next = op.merge ? { ...(store[op.ref.path] || {}) } : {};
            Object.keys(op.data || {}).forEach((k) => {
              if (op.data[k] && op.data[k].__delete) delete next[k];
              else next[k] = op.data[k];
            });
            store[op.ref.path] = next;
          }
        }
      };
    },
    runTransaction: async (fn) => {
      const tx = {
        get: (ref) => ref.get(),
        set: (ref, data, opts) => ref.set(data, opts),
        update: (ref, data) => ref.update(data),
        delete: (ref) => ref.delete()
      };
      return fn(tx);
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
      FieldValue: {
        serverTimestamp: () => ({ __serverTimestamp: true }),
        delete: () => ({ __delete: true })
      }
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
  assert.equal(StoreFB.isAllowedOrderTransition('cancelled', 'new'), true); // reopen
  assert.equal(StoreFB.isAllowedOrderTransition('cancelled', 'in_transit'), false); // must go via new
  assert.equal(StoreFB.isAllowedOrderTransition('cancelled', 'cancelled'), true); // same-state no-op
  assert.equal(StoreFB.isAllowedOrderTransition('new', 'expired'), true);
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

test('createManualOrder: one transaction reserves, claims the discount, writes order + movements + audit, refreshes inStock', async () => {
  const { fake, fb } = await signedInFb();
  fake._store['products/p1'] = { name: 'منتج 1', price: 100, inStock: true };
  fake._store['inventory/p1'] = { stock: 10, reserved: 2 };
  fake._store['discounts/X10'] = { code: 'X10', active: true, usedBy: null, percent: 10, expiresAt: null };
  const input = {
    clientOrderId: 'c-1',
    items: [{ productId: 'p1', qty: 2 }],
    discountCode: 'X10',
    customer: { name: 'أحمد', phone: '01012345678', address: 'القاهرة' },
    shippingCompanyId: 'ship-1',
    notes: 'ملاحظة'
  };
  const res = await fb.createManualOrder(input);
  assert.equal(res.created, true);
  assert.equal(res.order.id, 'c-1');
  const o = fake._store['orders/c-1'];
  assert.equal(o.status, 'new');
  assert.equal(o.paymentStatus, 'cod_pending');
  assert.equal(o.source, 'admin_manual');
  assert.equal(o.createdBy, 'uid-admin');
  assert.equal(o.customerName, 'أحمد');
  assert.equal(o.customerPhone, '01012345678');
  assert.equal(o.customerAddress, 'القاهرة');
  assert.equal(o.subtotal, 200);
  assert.equal(o.discountCode, 'X10');
  assert.equal(o.discountPercent, 10);
  assert.equal(o.discountAmount, 20);
  assert.equal(o.total, 180);
  assert.deepEqual(o.items, [{ productId: 'p1', name: 'منتج 1', price: 100, qty: 2 }]);
  assert.equal(o.acceptedAt, null);
  assert.equal(o.cancelReason, null);
  assert.equal(o.trackingNumber, null);
  assert.ok(o.auditId);
  assert.equal(fake._store['inventory/p1'].reserved, 4); // 2 + 2 reserved
  assert.equal(fake._store['discounts/X10'].usedBy, 'c-1');
  assert.equal(fake._store['products/p1'].inStock, true); // §13 refresh: 10 - 4 > 0
  const mvKeys = Object.keys(fake._store).filter((k) => k.startsWith('movements/'));
  assert.equal(mvKeys.length, 1);
  assert.equal(fake._store[mvKeys[0]].type, 'order_reserve');
  assert.equal(fake._store[mvKeys[0]].qty, -2);
  assert.equal(fake._store[mvKeys[0]].orderId, 'c-1');
  assert.equal(fake._store[mvKeys[0]].source, 'createManualOrder');
  const auditKeys = Object.keys(fake._store).filter((k) => k.startsWith('audit/'));
  assert.equal(auditKeys.length, 2); // the order audit + the §13 inStock-refresh audit
  const audit = Object.values(fake._store).find((v) => v.operation === 'manual_order_create');
  assert.equal(audit.operation, 'manual_order_create');
  assert.equal(audit.docId, 'c-1');
  assert.ok(audit.docIds['orders/c-1'].includes('status'));
  assert.ok(audit.docIds['inventory/p1'].includes('reserved'));
});

test('createManualOrder: idempotent — a retry with the same clientOrderId returns the order without re-reserving', async () => {
  const { fake, fb } = await signedInFb();
  fake._store['products/p1'] = { name: 'منتج 1', price: 100 };
  fake._store['inventory/p1'] = { stock: 10, reserved: 0 };
  const input = {
    clientOrderId: 'c-9',
    items: [{ productId: 'p1', qty: 2 }],
    customer: { name: 'أحمد', phone: '01012345678', address: 'القاهرة' }
  };
  const first = await fb.createManualOrder(input);
  assert.equal(first.created, true);
  assert.equal(fake._store['inventory/p1'].reserved, 2);
  const second = await fb.createManualOrder(input);
  assert.equal(second.created, false);
  assert.equal(second.order.id, 'c-9');
  assert.equal(fake._store['inventory/p1'].reserved, 2); // no double reserve
  assert.equal(Object.keys(fake._store).filter((k) => k.startsWith('orders/')).length, 1);
});

test('createManualOrder: dedupes lines, rejects short stock with the available count, price/total changes, used discount', async () => {
  const { fake, fb } = await signedInFb();
  fake._store['products/p1'] = { name: 'منتج 1', price: 100 };
  fake._store['products/p2'] = { name: 'منتج 2', price: 50 };
  fake._store['inventory/p1'] = { stock: 1, reserved: 0 };
  fake._store['inventory/p2'] = { stock: 10, reserved: 0 };
  fake._store['discounts/USED'] = { code: 'USED', active: true, usedBy: 'other-order', percent: 10 };
  const base = {
    clientOrderId: 'c-x',
    items: [{ productId: 'p2', qty: 1 }, { productId: 'p2', qty: 2 }], // dedupes to 3
    customer: { name: 'أحمد', phone: '01012345678', address: 'القاهرة' }
  };
  const ok = await fb.createManualOrder(base);
  assert.equal(ok.order.total, 150); // 3 x 50, no discount
  assert.equal(fake._store['inventory/p2'].reserved, 3);
  await assert.rejects(
    fb.createManualOrder({ ...base, clientOrderId: 'c-y', items: [{ productId: 'p1', qty: 2 }] }),
    (e) => { assert.equal(e.code, 'INSUFFICIENT_STOCK'); assert.equal(e.availableQty, 1); return /هو 1 بس/.test(e.message); });
  assert.equal(fake._store['inventory/p1'].reserved, 0); // nothing written
  await assert.rejects(
    fb.createManualOrder({ ...base, clientOrderId: 'c-z', seenPrices: { p2: 40 } }),
    (e) => e.code === 'PRICE_CHANGED');
  await assert.rejects(
    fb.createManualOrder({ ...base, clientOrderId: 'c-w', seenTotal: 999 }),
    (e) => e.code === 'TOTAL_CHANGED');
  await assert.rejects(
    fb.createManualOrder({ ...base, clientOrderId: 'c-v', discountCode: 'USED' }),
    (e) => e.code === 'DISCOUNT_USED');
  await assert.rejects(
    fb.createManualOrder({ ...base, clientOrderId: 'c-u', customer: { name: 'أحمد', phone: '010', address: 'القاهرة' } }),
    (e) => e.code === 'INVALID_INPUT');
});

test('updateOrderStatus: cancel releases the reservation, deliver deducts stock, reopen re-reserves and deletes the cancel stamp', async () => {
  const { fake, fb } = await signedInFb();
  fake._store['products/p1'] = { name: 'منتج 1', price: 100, inStock: true };
  fake._store['inventory/p1'] = { stock: 10, reserved: 2 };
  fake._store['orders/o1'] = { status: 'preparing', total: 200, items: [{ productId: 'p1', name: 'منتج 1', price: 100, qty: 2 }] };
  assert.equal(await fb.updateOrderStatus({ id: 'o1', status: 'preparing' }, 'cancelled'), true);
  assert.equal(fake._store['orders/o1'].status, 'cancelled');
  assert.ok(fake._store['orders/o1'].cancelledAt);
  assert.equal(fake._store['inventory/p1'].reserved, 0); // released
  assert.equal(fake._store['inventory/p1'].stock, 10); // stock untouched by a cancel
  const mvCancel = Object.values(fake._store).find((v) => v.type === 'order_cancel');
  assert.equal(mvCancel.qty, 2);
  // Reopen re-reserves and deletes cancelledAt + cancelReason.
  fake._store['orders/o1'].cancelReason = 'customer asked';
  assert.equal(await fb.updateOrderStatus({ id: 'o1', status: 'cancelled' }, 'new'), true);
  assert.equal(fake._store['orders/o1'].status, 'new');
  assert.equal(fake._store['orders/o1'].cancelledAt, undefined);
  assert.equal(fake._store['orders/o1'].cancelReason, undefined);
  assert.equal(fake._store['inventory/p1'].reserved, 2);
  const mvReopen = Object.values(fake._store).find((v) => v.type === 'reopen_reserve');
  assert.equal(mvReopen.qty, -2);
  // Deliver deducts stock and reserved.
  fake._store['orders/o1'].status = 'in_transit';
  assert.equal(await fb.updateOrderStatus({ id: 'o1', status: 'in_transit' }, 'delivered'), true);
  assert.equal(fake._store['inventory/p1'].stock, 8);
  assert.equal(fake._store['inventory/p1'].reserved, 0);
  assert.ok(fake._store['orders/o1'].deliveredAt);
  const mvDel = Object.values(fake._store).find((v) => v.type === 'order_deliver');
  assert.equal(mvDel.qty, -2);
});

test('updateOrderStatus: reopen throws with the available count when stock is short — and writes nothing', async () => {
  const { fake, fb } = await signedInFb();
  fake._store['products/p1'] = { name: 'منتج 1', price: 100 };
  fake._store['inventory/p1'] = { stock: 1, reserved: 0 };
  fake._store['orders/o1'] = { status: 'cancelled', total: 200, cancelledAt: { seconds: 1 }, cancelReason: 'x', items: [{ productId: 'p1', name: 'منتج 1', price: 100, qty: 2 }] };
  await assert.rejects(
    fb.updateOrderStatus({ id: 'o1', status: 'cancelled' }, 'new'),
    (e) => { assert.equal(e.code, 'INSUFFICIENT_STOCK'); assert.equal(e.availableQty, 1); assert.equal(e.productId, 'p1'); return /هو 1 بس/.test(e.message); });
  assert.equal(fake._store['orders/o1'].status, 'cancelled');
  assert.equal(fake._store['inventory/p1'].reserved, 0);
  assert.equal(fake._store['orders/o1'].cancelReason, 'x'); // stamp intact
});

test('runLazySweep: expires only new orders older than 24h and releases their reservations', async () => {
  const { fake, fb } = await signedInFb();
  const nowSec = Math.floor(Date.now() / 1000);
  fake._store['products/p1'] = { name: 'منتج 1', price: 100, inStock: true };
  fake._store['inventory/p1'] = { stock: 5, reserved: 1 };
  fake._store['orders/o-old'] = { status: 'new', total: 100, createdAt: { seconds: nowSec - 25 * 3600 }, items: [{ productId: 'p1', qty: 1 }] };
  fake._store['orders/o-fresh'] = { status: 'new', total: 100, createdAt: { seconds: nowSec - 3600 }, items: [{ productId: 'p1', qty: 1 }] };
  fake._store['orders/o-acc'] = { status: 'accepted', total: 100, createdAt: { seconds: nowSec - 30 * 3600 }, items: [{ productId: 'p1', qty: 1 }] };
  const res = await fb.runLazySweep();
  assert.equal(res.swept, 1);
  assert.equal(res.checked, 1);
  assert.equal(fake._store['orders/o-old'].status, 'expired');
  assert.equal(fake._store['orders/o-old'].cancelReason, 'reservation_expired');
  assert.equal(fake._store['inventory/p1'].reserved, 0);
  assert.equal(fake._store['orders/o-fresh'].status, 'new');
  assert.equal(fake._store['orders/o-acc'].status, 'accepted');
  const mv = Object.values(fake._store).find((v) => v.type === 'reservation_expire');
  assert.equal(mv.orderId, 'o-old');
  // Second run is a no-op (idempotent).
  const res2 = await fb.runLazySweep();
  assert.equal(res2.swept, 0);
});

test('deleteFeedback: deletes the card and writes its delete-audit', async () => {
  const { fake, fb } = await signedInFb();
  fake._store['feedback/fb-1'] = { name: 'أحمد', email: 'a@test.com', address: 'القاهرة', message: 'الطلب اتأخر', createdAt: { seconds: 1 } };
  assert.equal(await fb.deleteFeedback('fb-1'), true);
  assert.equal(fake._store['feedback/fb-1'], undefined);
  const auditKeys = Object.keys(fake._store).filter((k) => k.startsWith('audit/'));
  assert.equal(auditKeys.length, 1);
  assert.equal(fake._store[auditKeys[0]].operation, 'feedback_delete');
  assert.equal(fake._store[auditKeys[0]].docId, 'fb-1');
});

test('pure helpers: dedupe, totals, low stock, sales by period', () => {
  assert.deepEqual(StoreFB.dedupeOrderLines([{ productId: 'p1', qty: 1 }, { productId: 'p1', qty: 2 }, { productId: 'p2', qty: 1 }]),
    [{ productId: 'p1', qty: 3 }, { productId: 'p2', qty: 1 }]);
  assert.deepEqual(StoreFB.computeOrderTotals([{ price: 100, qty: 2 }], 10), { subtotal: 200, discountAmount: 20, total: 180 });
  assert.deepEqual(StoreFB.computeOrderTotals([{ price: 100, qty: 1 }], null), { subtotal: 100, discountAmount: 0, total: 100 });
  assert.equal(StoreFB.computeInStock(10, 4), true);
  assert.equal(StoreFB.computeInStock(2, 2), false);
  const low = StoreFB.lowStockProducts(
    [{ id: 'p1', name: 'منتج 1', minStock: 5 }, { id: 'p2', name: 'منتج 2' }, { id: 'p3', name: 'منتج 3', minStock: 2 }],
    { p1: { stock: 10, reserved: 6 }, p2: { stock: 20, reserved: 0 }, p3: { stock: 3, reserved: 2 } });
  assert.deepEqual(low.map((x) => x.id), ['p3', 'p1']); // available 1, then 4 — sorted ascending
  assert.equal(low[0].available, 1);
  const today = new Date();
  const iso = (d) => d.toISOString();
  const orders = [
    { status: 'new', total: 100, createdAt: iso(today) },
    { status: 'delivered', total: 50, createdAt: iso(new Date(today.getTime() - 86400000)) },
    { status: 'cancelled', total: 999, createdAt: iso(today) }
  ];
  const day = StoreFB.salesByPeriod(orders, 'day');
  assert.equal(day.length, 14);
  const todayBucket = day.find((b) => b.key === today.toISOString().slice(0, 10));
  assert.equal(todayBucket.total, 100); // the cancelled 999 is excluded
  assert.equal(todayBucket.count, 1);
  const month = StoreFB.salesByPeriod(orders, 'month');
  assert.equal(month.length, 12);
});

// In-memory localStorage stand-in (Node has none) for the role-cache tests.
function stubLocalStorage() {
  const store = {};
  const prev = global.localStorage;
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  return () => { if (prev === undefined) delete global.localStorage; else global.localStorage = prev; };
}

test('init: remembered session restores offline from the cached role', async () => {
  const restore = stubLocalStorage();
  try {
    // An online sign-in caches the confirmed role.
    const fake1 = createFakeFirebase();
    fake1._setRole('uid-admin', 'admin');
    const fb1 = StoreFB.create(fake1, CONFIG);
    await fb1.init();
    await fb1.signIn('admin@store.test', 'correct');
    assert.equal(JSON.parse(global.localStorage.getItem('sb_store_role')).role, 'admin');
    assert.equal(JSON.parse(global.localStorage.getItem('sb_store_role')).uid, 'uid-admin');
    // A fresh boot where the role read fails (offline) still restores
    // the session from the cached user + cached role.
    const fake2 = createFakeFirebase();
    fake2._failGets = true;
    const fb2 = StoreFB.create(fake2, CONFIG);
    await fb2.init();
    await fb2.signIn('admin@store.test', 'correct');
    assert.equal(fb2.state.connected, true);
    assert.equal(fb2.state.role, 'admin');
    assert.equal(fb2.state.user.email, 'admin@store.test');
  } finally {
    restore();
  }
});

test('init: offline role read with no cached role stays refused', async () => {
  const restore = stubLocalStorage();
  try {
    const fake = createFakeFirebase();
    fake._failGets = true;
    const fb = StoreFB.create(fake, CONFIG);
    await fb.init();
    await assert.rejects(fb.signIn('admin@store.test', 'correct'), /تعذر قراءة صلاحيات الحساب/);
    assert.equal(fb.state.connected, false);
  } finally {
    restore();
  }
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

test('updateOrderStatus: cancelling is a stock-moving transaction with the audit entry', async () => {
  const { fake, fb } = await signedInFb();
  fake._store['products/p1'] = { name: 'منتج 1', price: 100 };
  fake._store['inventory/p1'] = { stock: 10, reserved: 2 };
  fake._store['orders/o1'] = { status: 'preparing', total: 250, items: [{ productId: 'p1', qty: 2 }] };
  assert.equal(await fb.updateOrderStatus({ id: 'o1', status: 'preparing' }, 'cancelled'), true);
  assert.equal(fake._store['orders/o1'].status, 'cancelled');
  assert.ok(fake._store['orders/o1'].operationId);
  assert.equal(fake._store['inventory/p1'].reserved, 0); // released
  const auditKeys = Object.keys(fake._store).filter((k) => k.startsWith('audit/'));
  assert.equal(auditKeys.length, 1);
  const audit = fake._store[auditKeys[0]];
  assert.equal(audit.operation, 'order_status');
  assert.equal(audit.operationId, fake._store['orders/o1'].operationId);
  assert.deepEqual(audit.newValuesByDoc['orders/o1'], { status: 'cancelled' });
  assert.deepEqual(audit.oldValues, { status: 'preparing', cancelledAt: null });
});

test('updateOrderStatus: reopen cancelled -> new re-reserves; cancelled -> in_transit stays denied', async () => {
  const { fake, fb } = await signedInFb();
  fake._store['products/p1'] = { name: 'منتج 1', price: 100 };
  fake._store['inventory/p1'] = { stock: 10, reserved: 0 };
  fake._store['orders/o1'] = { status: 'cancelled', total: 250, cancelledAt: { seconds: 1 }, cancelReason: 'x', items: [{ productId: 'p1', qty: 2 }] };
  assert.equal(await fb.updateOrderStatus({ id: 'o1', status: 'cancelled' }, 'new'), true);
  assert.equal(fake._store['orders/o1'].status, 'new');
  assert.equal(fake._store['orders/o1'].cancelledAt, undefined);
  assert.equal(fake._store['orders/o1'].cancelReason, undefined);
  assert.equal(fake._store['inventory/p1'].reserved, 2);
  assert.ok(fake._store['orders/o1'].operationId);
  const auditKeys = Object.keys(fake._store).filter((k) => k.startsWith('audit/'));
  assert.equal(auditKeys.length, 1);
  const audit = fake._store[auditKeys[0]];
  assert.equal(audit.operation, 'order_status');
  assert.equal(audit.operationId, fake._store['orders/o1'].operationId);
  assert.deepEqual(audit.newValuesByDoc['orders/o1'], { status: 'new' });
  assert.ok(audit.docIds['orders/o1'].includes('cancelledAt'));
  assert.ok(audit.docIds['orders/o1'].includes('cancelReason'));
  // Direct jump to in_transit is still denied — reopen must go via new.
  fake._store['orders/o2'] = { status: 'cancelled', total: 100 };
  await assert.rejects(
    fb.updateOrderStatus({ id: 'o2', status: 'cancelled' }, 'in_transit'),
    /ماينفعش/);
  assert.equal(fake._store['orders/o2'].status, 'cancelled'); // untouched
  assert.equal(Object.keys(fake._store).filter((k) => k.startsWith('audit/')).length, 1); // no second audit
});

test('subscribeOrders: a website order flows through with every field (placeOrder output shape)', async () => {
  const { fake, fb } = await signedInFb();
  // The exact shape the Phase 2 placeOrder callable writes: customer
  // block, priced items, totals, status + paymentStatus, createdAt.
  // The PC subscription must not drop any of it — the orders table
  // and the detail view render all of these fields.
  fake._store['orders/web-1'] = {
    status: 'new', paymentStatus: 'cod_pending',
    customer: { name: 'أحمد محمد', phone: '01012345678', email: 'ahmed@test.com', address: 'القاهرة — مدينة نصر' },
    items: [
      { productId: 'p1', name: 'منتج 1', price: 150, qty: 2, subtotal: 300 },
      { productId: 'p2', name: 'منتج 2', price: 150, qty: 1, subtotal: 150 }
    ],
    subtotal: 450, shippingFee: 0, discount: null, total: 450,
    shippingCompanyId: 'ship-1', notes: 'ملاحظة', source: 'website',
    createdAt: { seconds: 1795000000, nanoseconds: 0 }
  };
  const list = await new Promise((resolve) => fb.subscribeOrders((l) => resolve(l)));
  assert.equal(list.length, 1);
  const o = list[0];
  assert.equal(o.id, 'web-1');
  assert.equal(o.customer.name, 'أحمد محمد');
  assert.equal(o.customer.phone, '01012345678');
  assert.equal(o.customer.email, 'ahmed@test.com');
  assert.equal(o.customer.address, 'القاهرة — مدينة نصر');
  assert.equal(o.items.length, 2);
  assert.deepEqual(o.items[0], { productId: 'p1', name: 'منتج 1', price: 150, qty: 2, subtotal: 300 });
  assert.equal(o.items[1].productId, 'p2');
  assert.equal(o.total, 450);
  assert.equal(o.status, 'new');
  assert.equal(o.paymentStatus, 'cod_pending');
  assert.equal(o.createdAt.seconds, 1795000000);
});

test('subscribeFeedback: a one-way card flows through with only its five fields', async () => {
  const { fake, fb } = await signedInFb();
  // The no-functions shape (§3/§6): name / email / phone / message /
  // createdAt — no type, category, title, tracking code, status or
  // priority anywhere.
  fake._store['feedback/fb-1'] = {
    name: 'أحمد محمد', email: 'ahmed@test.com', phone: '01012345678',
    message: 'الطلب اتأخر يومين', createdAt: { seconds: 1795000000, nanoseconds: 0 }
  };
  const list = await new Promise((resolve) => fb.subscribeFeedback((l) => resolve(l)));
  assert.equal(list.length, 1);
  const f = list[0];
  assert.equal(f.id, 'fb-1');
  assert.equal(f.message, 'الطلب اتأخر يومين');
  assert.equal(f.name, 'أحمد محمد');
  assert.equal(f.email, 'ahmed@test.com');
  assert.equal(f.phone, '01012345678');
  assert.equal(f.status, undefined);
  assert.equal(f.trackingCode, undefined);
  assert.equal(f.createdAt.seconds, 1795000000);
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
