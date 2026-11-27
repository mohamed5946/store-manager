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
            if (f.op === '>=') return v >= want;
            if (f.op === 'in') return Array.isArray(want) && want.indexOf(v) !== -1;
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


test('validateTemplateDoc: the classic seed is a bundle doc (passes the registry check, fails the v1 gateway)', () => {
  // The seed is the six-field bundle shape (decision 15, Dart
  // _ensureClassicTemplateDoc parity): id, nameAr, nameEn, string
  // version, shellMinVersion, bundleHash (+ status, previewImageUrl).
  // The bundle registry check passes it; the v1-only gateway fails
  // it — by design, the old shell cannot read a bundle registry
  // doc (see the old-shell test in templates.test.js).
  assert.deepEqual(StoreFB.validateRegistryManifest(StoreFB.CLASSIC_TEMPLATE, 'classic'), { passed: true, failedChecks: [] });
  assert.equal(StoreFB.validateRegistryManifest(StoreFB.CLASSIC_TEMPLATE, 'classic').passed, true);
  assert.equal(StoreFB.validateTemplateDoc(StoreFB.CLASSIC_TEMPLATE).passed, false);
  assert.equal(StoreFB.CLASSIC_TEMPLATE.bundleHash, StoreFB.CLASSIC_BUNDLE_HASH);
});

test('validateTemplateDoc: bad v1 docs fail with the right checks', () => {
  const base = v1TemplateDoc();
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

test('validateRegistryManifest: bad bundle docs fail with the right checks', () => {
  const base = StoreFB.CLASSIC_TEMPLATE;
  assert.deepEqual(StoreFB.validateRegistryManifest({ ...base, id: 'nope' }, 'nope').failedChecks, ['manifest.id']);
  assert.deepEqual(StoreFB.validateRegistryManifest({ ...base, nameAr: '  ' }, 'classic').failedChecks, ['manifest.nameAr']);
  assert.deepEqual(StoreFB.validateRegistryManifest({ ...base, nameEn: '' }, 'classic').failedChecks, ['manifest.nameEn']);
  assert.deepEqual(StoreFB.validateRegistryManifest({ ...base, version: 1 }, 'classic').failedChecks, ['manifest.version']);
  assert.deepEqual(StoreFB.validateRegistryManifest({ ...base, shellMinVersion: '9.9.9' }, 'classic').failedChecks, ['manifest.shellMinVersion']);
  assert.deepEqual(StoreFB.validateRegistryManifest({ ...base, bundleHash: 'xyz' }, 'classic').failedChecks, ['manifest.bundleHash']);
  assert.deepEqual(StoreFB.validateRegistryManifest({ ...base, status: 'live' }, 'classic').failedChecks, ['manifest.status']);
  assert.deepEqual(StoreFB.validateRegistryManifest({ ...base, previewImageUrl: '/relative.png' }, 'classic').failedChecks, ['manifest.previewImageUrl']);
  assert.equal(StoreFB.validateRegistryManifest(null, 'classic').passed, false);
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
  fake._store['templates/dark'] = { ...v1TemplateDoc(), id: 'dark', name: 'داكن', status: 'draft' };
  const res = await fb.activateTemplate('dark');
  assert.deepEqual(res, { previousTemplateId: 'classic', templateId: 'dark', bundleVersion: '1.0.0', bundleHash: null });
  assert.equal(fake._store['templates/dark'].status, 'active');
  assert.equal(fake._store['templates/classic'].nameAr, 'الكلاسيكي'); // auto-seeded (six-field bundle shape)
  assert.equal(fake._store['templates/classic'].bundleHash, StoreFB.CLASSIC_BUNDLE_HASH);
  const ptr = fake._store['storeSettings/activeTemplate'];
  assert.equal(ptr.templateId, 'dark');
  assert.equal(ptr.previousTemplateId, 'classic');
  assert.equal(ptr.bundleVersion, '1.0.0');
  assert.equal(ptr.bundleHash, null);
  assert.equal(ptr.history.length, 1);
  assert.equal(ptr.history[0].templateId, 'dark');
  assert.equal(ptr.history[0].by, 'admin@store.test');
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
  fake._store['storeSettings/settings'] = { deliveryFee: 30 };
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
  assert.equal(o.saleSavings, 0);
  assert.equal(o.deliveryFee, 30);
  assert.equal(o.amountDue, 210);
  assert.deepEqual(o.items, [{ productId: 'p1', name: 'منتج 1', price: 100, basePrice: null, qty: 2 }]);
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
  fake._store['storeSettings/settings'] = { deliveryFee: 30 };
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
  fake._store['storeSettings/settings'] = { deliveryFee: 30 };
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
  fake._store['products/p1'] = { name: 'منتج 1', price: 100, inStock: false };
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
  // The stale inStock flag is corrected in the same transaction
  // (stock 5, reserved 0 → available 5 → in stock).
  assert.equal(fake._store['products/p1'].inStock, true);
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
  // Deterministic delete audit (rules hasDeleteAudit): the entry id
  // is del_<collection>_<docId> with operation 'delete'.
  assert.deepEqual(auditKeys, ['audit/del_feedback_fb-1']);
  assert.equal(fake._store[auditKeys[0]].operation, 'delete');
  assert.equal(fake._store[auditKeys[0]].collection, 'feedback');
  assert.equal(fake._store[auditKeys[0]].docId, 'fb-1');
});

test('pure helpers: dedupe, totals, low stock, sales by period', () => {
  assert.deepEqual(StoreFB.dedupeOrderLines([{ productId: 'p1', qty: 1 }, { productId: 'p1', qty: 2 }, { productId: 'p2', qty: 1 }]),
    [{ productId: 'p1', qty: 3 }, { productId: 'p2', qty: 1 }]);
  // Pricing (§8): the canonical helper returns every shared figure —
  // feeUnset / feeWaived / amountDue (null while the fee is unset) /
  // savingTotal / insteadOf, identical to the storefront + Flutter.
  assert.deepEqual(StoreFB.computeOrderTotals([{ price: 100, qty: 2 }], 10, { deliveryFee: 30 }), {
    perLine: [{ saving: 0, pct: null }], baseSubtotal: 200, subtotal: 200, saleSavings: 0,
    discountPercent: 10, discountAmount: 20, total: 180, deliveryFee: 30, feeUnset: false,
    feeWaived: false, amountDue: 210, savingTotal: 20, insteadOf: 230
  });
  assert.deepEqual(StoreFB.computeOrderTotals([{ price: 100, qty: 1 }], null), {
    perLine: [{ saving: 0, pct: null }], baseSubtotal: 100, subtotal: 100, saleSavings: 0,
    discountPercent: null, discountAmount: 0, total: 100, deliveryFee: null, feeUnset: true,
    feeWaived: false, amountDue: null, savingTotal: 0, insteadOf: null
  });
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
  fake._store['templates/dark'] = { ...v1TemplateDoc(), id: 'dark', name: 'داكن', grid: { columns: null, rows: null, minColumnWidthPx: 250 } };
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

// ---- Pricing (pricing-bundle.md, Technical Plan §8 + Verification
// Plan matrix cases A–G). The shared numeric matrix is the test
// oracle: the PC path passes only when it reproduces every row
// exactly, with identical expected totals to the storefront and
// Flutter paths. No ±1 EGP tolerance anywhere.

test('pricing matrix A — worked example: 500 → 300 x1, no code, fee 30', () => {
  const t = StoreFB.computeOrderTotals([{ price: 300, basePrice: 500, qty: 1 }], null, { deliveryFee: 30 });
  assert.equal(t.baseSubtotal, 500);
  assert.equal(t.subtotal, 300);
  assert.equal(t.saleSavings, 200);
  assert.equal(t.discountAmount, 0);
  assert.equal(t.total, 300);
  assert.equal(t.deliveryFee, 30);
  assert.equal(t.amountDue, 330);
  assert.deepEqual(t.perLine, [{ saving: 200, pct: 40 }]);
  assert.equal(t.savingTotal, 200);
  assert.equal(t.insteadOf, 530);
});

test('pricing matrix B — fee 0: amountDue == items total', () => {
  const t = StoreFB.computeOrderTotals([{ price: 300, basePrice: 500, qty: 1 }], null, { deliveryFee: 0 });
  assert.equal(t.baseSubtotal, 500);
  assert.equal(t.subtotal, 300);
  assert.equal(t.saleSavings, 200);
  assert.equal(t.discountAmount, 0);
  assert.equal(t.total, 300);
  assert.equal(t.deliveryFee, 0);
  assert.equal(t.amountDue, 300);
  assert.equal(t.insteadOf, 500);
});

test('pricing matrix C — code on sale: 10% on the post-sale subtotal', () => {
  const t = StoreFB.computeOrderTotals([{ price: 300, basePrice: 500, qty: 1 }], 10, { deliveryFee: 30 });
  assert.equal(t.baseSubtotal, 500);
  assert.equal(t.subtotal, 300);
  assert.equal(t.saleSavings, 200);
  assert.equal(t.discountAmount, 30);
  assert.equal(t.total, 270);
  assert.equal(t.deliveryFee, 30);
  assert.equal(t.amountDue, 300);
});

test('pricing matrix D — multi-line: 500 → 300 x2 + 150 x1', () => {
  const t = StoreFB.computeOrderTotals(
    [{ price: 300, basePrice: 500, qty: 2 }, { price: 150, basePrice: null, qty: 1 }],
    null, { deliveryFee: 30 });
  assert.equal(t.baseSubtotal, 1150);
  assert.equal(t.subtotal, 750);
  assert.equal(t.saleSavings, 400);
  assert.equal(t.discountAmount, 0);
  assert.equal(t.total, 750);
  assert.equal(t.deliveryFee, 30);
  assert.equal(t.amountDue, 780);
  assert.equal(t.insteadOf, 1180);
});

test('pricing matrix E — rounding, % display: 199 → 149 saves exactly 50', () => {
  const t = StoreFB.computeOrderTotals([{ price: 149, basePrice: 199, qty: 1 }], null, { deliveryFee: 30 });
  assert.equal(t.baseSubtotal, 199);
  assert.equal(t.subtotal, 149);
  assert.equal(t.saleSavings, 50);
  assert.equal(t.discountAmount, 0);
  assert.equal(t.total, 149);
  assert.equal(t.deliveryFee, 30);
  assert.equal(t.amountDue, 179);
  // The saving is exact, and the % badge is SUPPRESSED for this
  // line (§8: 25% × 199 = 49.75 ≠ 50) — never a displayed 25%.
  assert.equal(t.perLine.length, 1);
  assert.equal(t.perLine[0].saving, 50);
  assert.equal(t.perLine[0].pct, null);
  assert.equal(t.savingTotal, 50);
  assert.equal(t.insteadOf, 229);
});

test('pricing matrix F — rounding, code: round(149 x 10 / 100) = round(14.9) = 15', () => {
  const t = StoreFB.computeOrderTotals([{ price: 149, basePrice: 199, qty: 1 }], 10, { deliveryFee: 30 });
  assert.equal(t.baseSubtotal, 199);
  assert.equal(t.subtotal, 149);
  assert.equal(t.saleSavings, 50);
  assert.equal(t.discountAmount, 15);
  assert.equal(t.total, 134);
  assert.equal(t.deliveryFee, 30);
  assert.equal(t.amountDue, 164);
});

test('pricing matrix G — code halves-up: round(305 x 10 / 100) = round(30.5) = 31', () => {
  const t = StoreFB.computeOrderTotals([{ price: 305, basePrice: null, qty: 1 }], 10, { deliveryFee: 30 });
  assert.equal(t.baseSubtotal, 305);
  assert.equal(t.subtotal, 305);
  assert.equal(t.saleSavings, 0);
  assert.equal(t.discountAmount, 31);
  assert.equal(t.total, 274);
  assert.equal(t.deliveryFee, 30);
  assert.equal(t.amountDue, 304);
});

test('pricing % badge: exact percentages show, inexact ones are suppressed (§8)', () => {
  assert.equal(StoreFB.salePercent({ price: 300, basePrice: 500 }), 40);
  assert.equal(StoreFB.salePercent({ price: 90, basePrice: 100 }), 10);
  assert.equal(StoreFB.salePercent({ price: 150, basePrice: 200 }), 25);
  assert.equal(StoreFB.salePercent({ price: 149, basePrice: 199 }), null);
  assert.equal(StoreFB.salePercent({ price: 100, basePrice: 100 }), null);
  assert.equal(StoreFB.salePercent({ price: 100, basePrice: null }), null);
  assert.equal(StoreFB.salePercent({ price: 100, basePrice: 90 }), null);
  assert.equal(StoreFB.isOnSale({ price: 149, basePrice: 199 }), true);
  assert.equal(StoreFB.isOnSale({ price: 100, basePrice: 100 }), false);
  assert.equal(StoreFB.roundHalfUp(30.5), 31);
  assert.equal(StoreFB.roundHalfUp(14.9), 15);
  assert.equal(StoreFB.roundHalfUp(14.4), 14);
});

test('pricing fee: missing fee blocks with amountDue null; threshold waives the fee (D3)', () => {
  const unset = StoreFB.computeOrderTotals([{ price: 300, qty: 1 }], null, {});
  assert.equal(unset.feeUnset, true);
  assert.equal(unset.deliveryFee, null);
  assert.equal(unset.amountDue, null);
  assert.equal(unset.insteadOf, null);
  const waived = StoreFB.computeOrderTotals([{ price: 300, qty: 1 }], null, { deliveryFee: 30, freeDeliveryThreshold: 300 });
  assert.equal(waived.feeWaived, true);
  assert.equal(waived.deliveryFee, 0);
  assert.equal(waived.amountDue, 300);
  const below = StoreFB.computeOrderTotals([{ price: 299, qty: 1 }], null, { deliveryFee: 30, freeDeliveryThreshold: 300 });
  assert.equal(below.feeWaived, false);
  assert.equal(below.deliveryFee, 30);
  assert.equal(below.amountDue, 329);
  // Threshold 0 (or absent) never waives.
  const zero = StoreFB.computeOrderTotals([{ price: 300, qty: 1 }], null, { deliveryFee: 30, freeDeliveryThreshold: 0 });
  assert.equal(zero.feeWaived, false);
  assert.equal(zero.amountDue, 330);
  // An invalid stored base (base <= price) is no sale.
  const bad = StoreFB.computeOrderTotals([{ price: 100, basePrice: 90, qty: 1 }], null, { deliveryFee: 30 });
  assert.equal(bad.baseSubtotal, 100);
  assert.equal(bad.saleSavings, 0);
});

test('createManualOrder: snapshots per-line basePrice + saleSavings + deliveryFee + amountDue, audit records the money fields', async () => {
  const { fake, fb } = await signedInFb();
  fake._store['products/p1'] = { name: 'منتج 1', price: 300, basePrice: 500 };
  fake._store['products/p2'] = { name: 'منتج 2', price: 150 };
  fake._store['inventory/p1'] = { stock: 10, reserved: 0 };
  fake._store['inventory/p2'] = { stock: 10, reserved: 0 };
  fake._store['storeSettings/settings'] = { deliveryFee: 30 };
  const res = await fb.createManualOrder({
    clientOrderId: 'c-pr1',
    items: [{ productId: 'p1', qty: 2 }, { productId: 'p2', qty: 1 }],
    customer: { name: 'أحمد', phone: '01012345678', address: 'القاهرة' }
  });
  assert.equal(res.created, true);
  const o = fake._store['orders/c-pr1'];
  assert.equal(o.subtotal, 750);
  assert.equal(o.saleSavings, 400);
  assert.equal(o.total, 750);
  assert.equal(o.deliveryFee, 30);
  assert.equal(o.amountDue, 780);
  assert.equal(o.attemptId, undefined); // manual orders have no checkout attempt
  assert.deepEqual(o.items, [
    { productId: 'p1', name: 'منتج 1', price: 300, basePrice: 500, qty: 2 },
    { productId: 'p2', name: 'منتج 2', price: 150, basePrice: null, qty: 1 }
  ]);
  const audit = Object.values(fake._store).find((v) => v.operation === 'manual_order_create');
  // 'items' is covered whenever a line carries a base price
  // (orderAuditOk) — so it is recorded in the audit entry too.
  assert.deepEqual(audit.newValuesByDoc['orders/c-pr1'], {
    status: 'new', total: 750, saleSavings: 400, deliveryFee: 30, amountDue: 780,
    items: [
      { productId: 'p1', name: 'منتج 1', price: 300, basePrice: 500, qty: 2 },
      { productId: 'p2', name: 'منتج 2', price: 150, basePrice: null, qty: 1 }
    ]
  });
  assert.ok(audit.docIds['orders/c-pr1'].includes('items'));
  assert.ok(audit.docIds['orders/c-pr1'].includes('deliveryFee'));
});

test('createManualOrder: missing delivery fee rejects (FEE_NOT_SET) and writes nothing', async () => {
  const { fake, fb } = await signedInFb();
  fake._store['products/p1'] = { name: 'منتج 1', price: 100 };
  fake._store['inventory/p1'] = { stock: 10, reserved: 0 };
  // No storeSettings/settings doc at all.
  await assert.rejects(
    fb.createManualOrder({
      clientOrderId: 'c-nofee',
      items: [{ productId: 'p1', qty: 1 }],
      customer: { name: 'أحمد', phone: '01012345678', address: 'القاهرة' }
    }),
    (e) => { assert.equal(e.code, 'FEE_NOT_SET'); return /رسوم التوصيل غير محددة/.test(e.message); });
  assert.equal(fake._store['orders/c-nofee'], undefined);
  assert.equal(fake._store['inventory/p1'].reserved, 0);
});

test('createManualOrder: free-delivery threshold from settings waives the fee', async () => {
  const { fake, fb } = await signedInFb();
  fake._store['products/p1'] = { name: 'منتج 1', price: 300, basePrice: 500 };
  fake._store['inventory/p1'] = { stock: 10, reserved: 0 };
  fake._store['storeSettings/settings'] = { deliveryFee: 30, freeDeliveryThreshold: 300 };
  const res = await fb.createManualOrder({
    clientOrderId: 'c-thr',
    items: [{ productId: 'p1', qty: 1 }],
    customer: { name: 'أحمد', phone: '01012345678', address: 'القاهرة' }
  });
  assert.equal(res.created, true);
  const o = fake._store['orders/c-thr'];
  assert.equal(o.deliveryFee, 0);
  assert.equal(o.amountDue, 300);
});

test('pricing audit: basePrice and the money fields are sensitive — a missing entry must fail', () => {
  // The 1.1.2 save-bug lesson: any new field written must be
  // recorded in the sensitive map, or the rules deny the write.
  // saveWebProduct lives in index.html (not a module), so the
  // contract is asserted here at the level the tests can reach:
  // the factory's SENSITIVE_FIELDS and the audit entry shape.
  for (const f of ['basePrice', 'deliveryFee', 'saleSavings', 'amountDue']) {
    assert.ok(StoreFB.SENSITIVE_FIELDS.includes(f), f + ' must be a sensitive field');
  }
  const entry = StoreFB.buildAuditEntry({
    opId: 'op-1', actor: 'uid-admin', actorName: 'admin@store.test', timestamp: { __serverTimestamp: true },
    operation: 'product_update',
    writes: { 'products/p1': { name: 'منتج 1', price: 300, basePrice: 500 } },
    sensitive: { 'products/p1': { price: 300, basePrice: 500 } },
    oldValues: {}, topNewValues: { productId: 'p1', basePrice: 500 }
  });
  assert.equal(entry.newValuesByDoc['products/p1'].basePrice, 500);
  assert.ok(entry.docIds['products/p1'].includes('basePrice'));
  // A sensitive map that omits basePrice while the write carries it
  // is exactly the 1.1.2 bug — the audit must expose the gap.
  const bad = StoreFB.buildAuditEntry({
    opId: 'op-2', actor: 'uid-admin', actorName: 'admin@store.test', timestamp: { __serverTimestamp: true },
    operation: 'product_update',
    writes: { 'products/p1': { price: 300, basePrice: 500 } },
    sensitive: { 'products/p1': { price: 300 } },
    oldValues: {}, topNewValues: {}
  });
  assert.equal(bad.newValuesByDoc['products/p1'].basePrice, undefined);
});

test('computePricingCounters: sale share, savings, fees and cash from order docs; rejections from attempt docs', () => {
  const orders = [
    { saleSavings: 200, deliveryFee: 30, amountDue: 330, total: 300 },
    { saleSavings: 0, deliveryFee: 30, amountDue: 180, total: 150 },
    { saleSavings: 50, deliveryFee: 0, amountDue: 149, total: 149 },
    { saleSavings: 0, deliveryFee: 30, total: 100 } // legacy order: no amountDue — falls back to total
  ];
  const attempts = [
    { errorCode: 'PRICE_CHANGED' },
    { errorCode: 'FEE_CHANGED' },
    { errorCode: 'INSUFFICIENT_STOCK' },
    {},
    {}
  ];
  const c = StoreFB.computePricingCounters(orders, attempts);
  assert.equal(c.totalOrders, 4);
  assert.equal(c.saleOrders, 2);
  assert.equal(c.saleOrderShare, 50);
  assert.equal(c.totalSaleSavings, 250);
  assert.equal(c.totalFeeCollected, 90);
  assert.equal(c.cashCollected, 330 + 180 + 149 + 100);
  assert.equal(c.attempts, 5);
  assert.equal(c.failedAttempts, 3);
  assert.equal(c.priceChangeRejections, 2);
  assert.equal(c.rejectionRate, 40);
  assert.deepEqual(c.failuresByCode, { PRICE_CHANGED: 1, FEE_CHANGED: 1, INSUFFICIENT_STOCK: 1 });
  const empty = StoreFB.computePricingCounters([], []);
  assert.equal(empty.saleOrderShare, 0);
  assert.equal(empty.rejectionRate, 0);
});

// ════════════════════════════════════════
// INCOMPLETE ORDERS (checkout drafts)
// ════════════════════════════════════════

function seedConvertDraftBase(fake, overrides) {
  const o = overrides || {};
  fake._store['products/p1'] = { name: 'منتج 1', price: 100 };
  fake._store['inventory/p1'] = { stock: 10, reserved: 0 };
  fake._store['storeSettings/settings'] = { deliveryFee: 30 };
  const now = new Date();
  fake._store['checkoutDrafts/d1'] = {
    sessionId: 'd1', sessionToken: 'tok-1',
    name: 'أحمد', phone: '01012345678',
    cart: [{ productId: 'p1', qty: 2, price: 100, priceAtDraft: 100 }],
    status: 'new', createdAt: new Date(now.getTime() - 10000), lastSyncAt: now,
    ...(o.draft || {})
  };
  return now;
}

function convertDraftInput(overrides) {
  return {
    id: 'd1', customerName: 'أحمد', customerPhone: '01012345678',
    governorate: 'cairo', detailedAddress: 'شارع التحرير 5', customerAddress: 'شارع التحرير 5، القاهرة',
    ...(overrides || {})
  };
}

test('convertDraft: creates one order, reserves stock, marks the draft converted', async () => {
  const { fake, fb } = await signedInFb();
  seedConvertDraftBase(fake);
  const res = await fb.convertDraft(convertDraftInput());
  assert.equal(res.result, 'ok');
  assert.equal(res.created, true);
  assert.equal(res.order.id, 'd1');
  const o = fake._store['orders/d1'];
  assert.equal(o.status, 'new');
  assert.equal(o.source, 'admin_manual');
  assert.equal(o.customerName, 'أحمد');
  assert.equal(o.customerPhone, '01012345678');
  assert.equal(o.governorate, 'cairo');
  assert.equal(o.detailedAddress, 'شارع التحرير 5');
  assert.equal(o.subtotal, 200);
  assert.equal(o.deliveryFee, 30);
  assert.equal(o.amountDue, 230);
  assert.deepEqual(o.items, [{ productId: 'p1', name: 'منتج 1', price: 100, basePrice: null, qty: 2 }]);
  assert.equal(fake._store['inventory/p1'].reserved, 2);
  const d = fake._store['checkoutDrafts/d1'];
  assert.equal(d.status, 'converted');
  assert.equal(d.orderId, 'd1');
  const mvKeys = Object.keys(fake._store).filter((k) => k.startsWith('movements/'));
  assert.equal(mvKeys.length, 1);
  assert.equal(fake._store[mvKeys[0]].source, 'convertDraft');
  const audit = Object.values(fake._store).find((v) => v.operation === 'manual_order_create');
  assert.equal(audit.docId, 'd1');
  assert.ok(audit.docIds['orders/d1'].includes('status'));
});

test('convertDraft: second call returns the existing order without re-reserving', async () => {
  const { fake, fb } = await signedInFb();
  seedConvertDraftBase(fake);
  const first = await fb.convertDraft(convertDraftInput());
  assert.equal(first.result, 'ok');
  assert.equal(fake._store['inventory/p1'].reserved, 2);
  const second = await fb.convertDraft(convertDraftInput());
  assert.equal(second.result, 'ALREADY_CONVERTED');
  assert.equal(second.created, false);
  assert.equal(second.order.id, 'd1');
  assert.equal(fake._store['inventory/p1'].reserved, 2); // no double reserve
  assert.equal(Object.keys(fake._store).filter((k) => k.startsWith('orders/')).length, 1);
});

test('convertDraft: out of stock returns a result and creates nothing', async () => {
  const { fake, fb } = await signedInFb();
  seedConvertDraftBase(fake, { draft: { cart: [{ productId: 'p1', qty: 3, price: 100, priceAtDraft: 100 }] } });
  fake._store['inventory/p1'] = { stock: 2, reserved: 0 };
  const res = await fb.convertDraft(convertDraftInput());
  assert.equal(res.result, 'INSUFFICIENT_STOCK');
  assert.equal(res.productId, 'p1');
  assert.equal(res.availableQty, 2);
  assert.equal(res.created, false);
  assert.equal(fake._store['orders/d1'], undefined);
  assert.equal(fake._store['inventory/p1'].reserved, 0);
  assert.equal(fake._store['checkoutDrafts/d1'].status, 'new'); // still convertible later
});

test('convertDraft: price change returns a result and creates nothing', async () => {
  const { fake, fb } = await signedInFb();
  seedConvertDraftBase(fake);
  fake._store['products/p1'] = { name: 'منتج 1', price: 120 }; // was 100 at draft time
  const res = await fb.convertDraft(convertDraftInput());
  assert.equal(res.result, 'PRICE_CHANGED');
  assert.equal(res.productId, 'p1');
  assert.equal(res.oldPrice, 100);
  assert.equal(res.newPrice, 120);
  assert.equal(fake._store['orders/d1'], undefined);
  assert.equal(fake._store['inventory/p1'].reserved, 0);
});

test('convertDraft: moot — customer already ordered after the draft — marks the draft and returns the existing order', async () => {
  const { fake, fb } = await signedInFb();
  const now = seedConvertDraftBase(fake);
  fake._store['orders/o9'] = {
    customerName: 'أحمد', customerPhone: '01012345678', status: 'new',
    createdAt: new Date(now.getTime() + 5000), total: 230
  };
  const res = await fb.convertDraft(convertDraftInput());
  assert.equal(res.result, 'MOOT');
  assert.equal(res.mootOrderId, 'o9');
  assert.equal(res.order.id, 'o9');
  assert.equal(res.created, false);
  assert.equal(fake._store['checkoutDrafts/d1'].mootOrderId, 'o9');
  assert.equal(fake._store['orders/d1'], undefined); // no duplicate order
  assert.equal(fake._store['inventory/p1'].reserved, 0);
});

test('convertDraft: rejects bad input and a dead draft', async () => {
  const { fake, fb } = await signedInFb();
  seedConvertDraftBase(fake);
  await assert.rejects(
    fb.convertDraft(convertDraftInput({ customerName: '  ' })),
    (e) => e.code === 'INVALID_INPUT');
  await assert.rejects(
    fb.convertDraft(convertDraftInput({ customerPhone: '12345' })),
    (e) => e.code === 'INVALID_INPUT');
  await assert.rejects(
    fb.convertDraft(convertDraftInput({ customerPhone2: '12345' })),
    (e) => e.code === 'INVALID_INPUT');
  await assert.rejects(
    fb.convertDraft(convertDraftInput({ customerAddress: '  ' })),
    (e) => e.code === 'INVALID_INPUT');
  await assert.rejects(
    fb.convertDraft(convertDraftInput({ id: 'missing' })),
    (e) => e.code === 'INVALID_INPUT');
  fake._store['checkoutDrafts/d1'].status = 'dead';
  await assert.rejects(
    fb.convertDraft(convertDraftInput()),
    (e) => e.code === 'INVALID_INPUT');
});

test('convertDraft: throws FEE_NOT_SET when the delivery fee is unset', async () => {
  const { fake, fb } = await signedInFb();
  seedConvertDraftBase(fake);
  delete fake._store['storeSettings/settings'];
  await assert.rejects(
    fb.convertDraft(convertDraftInput()),
    (e) => e.code === 'FEE_NOT_SET');
});

test('updateDraftStatus: valid transitions pass, illegal ones reject; deleteDraft writes the deterministic delete audit', async () => {
  const { fake, fb } = await signedInFb();
  seedConvertDraftBase(fake);
  await fb.updateDraftStatus('d1', 'contacted');
  assert.equal(fake._store['checkoutDrafts/d1'].status, 'contacted');
  await fb.updateDraftStatus('d1', 'no-answer');
  assert.equal(fake._store['checkoutDrafts/d1'].status, 'no-answer');
  await assert.rejects(fb.updateDraftStatus('d1', 'new'), /مينفعش تغير الحالة/); // no-answer -> new is not a legal transition
  await fb.updateDraftStatus('d1', 'dead');
  assert.equal(fake._store['checkoutDrafts/d1'].status, 'dead');
  await assert.rejects(fb.updateDraftStatus('d1', 'contacted'), /مينفعش تغير الحالة/);
  await fb.deleteDraft('d1');
  assert.equal(fake._store['checkoutDrafts/d1'], undefined);
  const audit = fake._store['audit/del_checkoutDrafts_d1'];
  assert.ok(audit);
  assert.equal(audit.operation, 'delete');
  assert.equal(audit.collection, 'checkoutDrafts');
  assert.equal(audit.docId, 'd1');
});

test('saveGovernorates: merge-only — an unrelated field on the doc survives; 28 entries rejected', async () => {
  const { fake, fb } = await signedInFb();
  fake._store['storeSettings/governorates'] = { entries: [], note: 'keep-me' };
  await fb.saveGovernorates([{ id: 'cairo', name: 'القاهرة', active: true }, { id: 'giza', name: 'الجيزة', active: false }]);
  const doc = fake._store['storeSettings/governorates'];
  assert.equal(doc.entries.length, 2);
  assert.equal(doc.entries[0].id, 'cairo');
  assert.equal(doc.note, 'keep-me');
  const tooMany = Array.from({ length: 28 }, (_, i) => ({ id: 'g' + i, name: 'x', active: true }));
  await assert.rejects(fb.saveGovernorates(tooMany), /27/);
});

test('saveDeletionConfig: 0–365 accepted, out of range rejected; getDeletionConfig defaults to 0', async () => {
  const { fake, fb } = await signedInFb();
  assert.deepEqual(await fb.getDeletionConfig(), { autoDeleteDays: 0 });
  await fb.saveDeletionConfig(30);
  assert.equal(fake._store['storeSettings/deletion'].autoDeleteDays, 30);
  assert.deepEqual(await fb.getDeletionConfig(), { autoDeleteDays: 30 });
  await assert.rejects(fb.saveDeletionConfig(400), /365/);
  await assert.rejects(fb.saveDeletionConfig(-1), /365/);
});

test('runDraftDeletion: deletes only drafts older than X days', async () => {
  const { fake, fb } = await signedInFb();
  const now = new Date();
  const day = 24 * 60 * 60 * 1000;
  fake._store['storeSettings/deletion'] = { autoDeleteDays: 30 };
  fake._store['checkoutDrafts/d-old'] = { status: 'new', createdAt: new Date(now.getTime() - 40 * day), lastSyncAt: new Date(now.getTime() - 40 * day) };
  fake._store['checkoutDrafts/d-mid'] = { status: 'new', createdAt: new Date(now.getTime() - 10 * day), lastSyncAt: new Date(now.getTime() - 10 * day) };
  fake._store['checkoutDrafts/d-new'] = { status: 'new', createdAt: now, lastSyncAt: now };
  const res = await fb.runDraftDeletion();
  assert.equal(res.skipped, false);
  assert.equal(res.deleted, 1);
  assert.equal(res.kept, 2);
  assert.equal(fake._store['checkoutDrafts/d-old'], undefined);
  assert.ok(fake._store['checkoutDrafts/d-mid']);
  assert.ok(fake._store['checkoutDrafts/d-new']);
});

test('runDraftDeletion: skips when lastRunAt is today', async () => {
  const { fake, fb } = await signedInFb();
  const now = new Date();
  const day = 24 * 60 * 60 * 1000;
  fake._store['storeSettings/deletion'] = { autoDeleteDays: 30, lastRunAt: now };
  fake._store['checkoutDrafts/d-old'] = { status: 'new', createdAt: new Date(now.getTime() - 40 * day), lastSyncAt: new Date(now.getTime() - 40 * day) };
  const res = await fb.runDraftDeletion();
  assert.equal(res.skipped, true);
  assert.equal(res.deleted, 0);
  assert.ok(fake._store['checkoutDrafts/d-old']); // untouched
});

test('runDraftDeletion: X=0 deletes nothing by age but enforces the newest-100 cap', async () => {
  const { fake, fb } = await signedInFb();
  const now = new Date();
  fake._store['storeSettings/deletion'] = { autoDeleteDays: 0 };
  for (let i = 0; i < 105; i++) {
    fake._store['checkoutDrafts/d' + i] = {
      status: 'new',
      createdAt: new Date(now.getTime() - i * 60000),
      lastSyncAt: new Date(now.getTime() - i * 60000)
    };
  }
  const res = await fb.runDraftDeletion();
  assert.equal(res.skipped, false);
  assert.equal(res.deleted, 5);
  assert.equal(res.kept, 100);
  const remaining = Object.keys(fake._store).filter((k) => k.startsWith('checkoutDrafts/'));
  assert.equal(remaining.length, 100);
  assert.ok(fake._store['checkoutDrafts/d0']); // newest kept
  assert.equal(fake._store['checkoutDrafts/d104'], undefined); // oldest cut
});

test('fetchOrdersByPhones: newest order per phone, chunked by 10', async () => {
  const { fake, fb } = await signedInFb();
  const now = new Date();
  fake._store['orders/o1'] = { customerPhone: '01011111111', createdAt: new Date(now.getTime() - 1000), total: 100 };
  fake._store['orders/o2'] = { customerPhone: '01011111111', createdAt: now, total: 200 };
  fake._store['orders/o3'] = { customerPhone: '01022222222', createdAt: now, total: 300 };
  const byPhone = await fb.fetchOrdersByPhones(['01011111111', '01022222222', '01033333333']);
  assert.equal(byPhone['01011111111'].id, 'o2'); // newest wins
  assert.equal(byPhone['01022222222'].id, 'o3');
  assert.equal(byPhone['01033333333'], undefined);
});

test('dailyWriteEstimate: counts today drafts and journeys, 2 writes each', async () => {
  const { fake, fb } = await signedInFb();
  const now = new Date();
  const day = 24 * 60 * 60 * 1000;
  fake._store['checkoutDrafts/a'] = { createdAt: now };
  fake._store['checkoutDrafts/b'] = { createdAt: now };
  fake._store['checkoutDrafts/old'] = { createdAt: new Date(now.getTime() - 2 * day) };
  fake._store['journeySummaries/s1'] = { startedAt: now };
  const est = await fb.dailyWriteEstimate();
  assert.equal(est.draftsToday, 2);
  assert.equal(est.journeysToday, 1);
  assert.equal(est.estimatedWrites, 6);
});

// ════════════════════════════════════════
// AUDIT FIX PASS (2026-11-27): B2 / B4 / B6 + auditedDelete
// ════════════════════════════════════════

test('draftIsCallable: the triage minimum — name + non-empty cart + full valid phone', () => {
  const callable = StoreFB.draftIsCallable;
  assert.equal(typeof callable, 'function');
  const good = { name: 'أحمد', phone: '01012345678', cart: [{ productId: 'p1' }] };
  assert.equal(callable(good), true);
  assert.equal(callable({ ...good, phone: '+201012345678' }), true); // +20 folds
  assert.equal(callable({ ...good, detailedAddress: 'شارع 5' }), true);
  assert.equal(callable({ ...good, cart: [] }), false); // empty cart
  assert.equal(callable({ ...good, name: '' }), false); // no name
  assert.equal(callable({ ...good, name: '   ' }), false); // blank name
  assert.equal(callable({ ...good, phone: '12345' }), false); // bad phone
  assert.equal(callable({ ...good, phone: '' }), false); // no phone
  assert.equal(callable({ name: 'أحمد', phone: '01012345678' }), false); // no cart
  assert.equal(callable({}), false);
  assert.equal(callable(null), false);
  // Address is NOT required: name + phone + cart already meets the minimum.
  assert.equal(callable({ name: 'أحمد', phone: '01012345678', cart: [{ productId: 'p1' }], address: '' }), true);
});

test('draftIsCallable: address never substitutes for a missing name or an empty cart (B2 re-audit)', () => {
  const callable = StoreFB.draftIsCallable;
  const base = { name: 'أحمد', phone: '01012345678', cart: [{ productId: 'p1' }], detailedAddress: 'شارع 5، القاهرة' };
  assert.equal(callable(base), true);
  // Leaking combination 1 (re-audit 2026-11-27): name + phone +
  // address with an EMPTY cart scored 75 under the old score check.
  assert.equal(callable({ ...base, cart: [] }), false);
  // Leaking combination 2: phone + cart + address with NO name.
  assert.equal(callable({ ...base, name: '' }), false);
  assert.equal(callable({ ...base, name: '   ' }), false);
  // Address is still not required: name + phone + cart lists.
  assert.equal(callable({ name: 'أحمد', phone: '01012345678', cart: [{ productId: 'p1' }] }), true);
  // +20 phone folds the same way.
  assert.equal(callable({ ...base, phone: '+201012345678' }), true);
  // Status is not part of the predicate: a converted/dead draft that
  // meets triage still returns true — the list carves closed records
  // out of triage-hiding, it does not hide them (B2 carve-out).
  assert.equal(callable({ ...base, status: 'converted' }), true);
  assert.equal(callable({ ...base, status: 'dead' }), true);
});

test('setQuotaCutoff: persists the cut-off level; invalid levels reject and write nothing', async () => {
  const { fake, fb } = await signedInFb();
  assert.equal(typeof fb.setQuotaCutoff, 'function');
  await fb.setQuotaCutoff('journeys');
  assert.equal(fake._store['storeSettings/quota'].cutoffLevel, 'journeys');
  assert.ok(fake._store['storeSettings/quota'].operationId);
  const audit = Object.values(fake._store).find((v) => v.operation === 'quota_cutoff_save');
  assert.ok(audit);
  assert.equal(audit.operationId, fake._store['storeSettings/quota'].operationId);
  await fb.setQuotaCutoff('drafts');
  assert.equal(fake._store['storeSettings/quota'].cutoffLevel, 'drafts');
  await fb.setQuotaCutoff('none');
  assert.equal(fake._store['storeSettings/quota'].cutoffLevel, 'none');
  await assert.rejects(fb.setQuotaCutoff('everything'), /مش صالح/);
  await assert.rejects(fb.setQuotaCutoff(''), /مش صالح/);
  assert.equal(fake._store['storeSettings/quota'].cutoffLevel, 'none'); // untouched by the rejects
});

test('createManualOrder: audit covers items when a line is on sale, and only then', async () => {
  // On-sale line (basePrice > price): docIds must cover 'items'
  // or the rules deny the order (orderAuditOk / itemsCovered).
  const { fake, fb } = await signedInFb();
  fake._store['products/p1'] = { name: 'منتج 1', price: 300, basePrice: 500 };
  fake._store['inventory/p1'] = { stock: 10, reserved: 0 };
  fake._store['storeSettings/settings'] = { deliveryFee: 30 };
  const res = await fb.createManualOrder({
    clientOrderId: 'c-sale',
    items: [{ productId: 'p1', qty: 1 }],
    customer: { name: 'أحمد', phone: '01012345678', address: 'القاهرة' }
  });
  assert.equal(res.created, true);
  const audit = Object.values(fake._store).find((v) => v.operation === 'manual_order_create');
  assert.ok(audit.docIds['orders/c-sale'].includes('items'));
  assert.deepEqual(audit.newValuesByDoc['orders/c-sale'].items,
    [{ productId: 'p1', name: 'منتج 1', price: 300, basePrice: 500, qty: 1 }]);

  // No-sale line (basePrice null): no items coverage is required,
  // mirroring convertDraft — the entry stays money-fields only.
  const { fake: fake2, fb: fb2 } = await signedInFb();
  fake2._store['products/p1'] = { name: 'منتج 1', price: 100 };
  fake2._store['inventory/p1'] = { stock: 10, reserved: 0 };
  fake2._store['storeSettings/settings'] = { deliveryFee: 30 };
  const res2 = await fb2.createManualOrder({
    clientOrderId: 'c-plain',
    items: [{ productId: 'p1', qty: 1 }],
    customer: { name: 'أحمد', phone: '01012345678', address: 'القاهرة' }
  });
  assert.equal(res2.created, true);
  const audit2 = Object.values(fake2._store).find((v) => v.operation === 'manual_order_create');
  assert.equal(audit2.docIds['orders/c-plain'].includes('items'), false);
  assert.equal(audit2.newValuesByDoc['orders/c-plain'].items, undefined);
});

test('auditedDelete: deterministic delete audit for products, categories, discounts', async () => {
  const { fake, fb } = await signedInFb();
  fake._store['products/p1'] = { name: 'منتج 1', price: 100 };
  fake._store['categories/c1'] = { name: 'فئة 1' };
  fake._store['discounts/X10'] = { code: 'X10', percent: 10 };
  assert.equal(await fb.deleteWebsiteProduct('p1'), true);
  assert.equal(await fb.deleteCategory('c1'), true);
  assert.equal(await fb.deleteDiscount('X10'), true);
  assert.equal(fake._store['products/p1'], undefined);
  assert.equal(fake._store['categories/c1'], undefined);
  assert.equal(fake._store['discounts/X10'], undefined);
  // One audit entry per delete, at the deterministic id the rules
  // enforce (hasDeleteAudit), all with operation 'delete'.
  assert.deepEqual(
    Object.keys(fake._store).filter((k) => k.startsWith('audit/')).sort(),
    ['audit/del_categories_c1', 'audit/del_discounts_X10', 'audit/del_products_p1']);
  for (const key of ['audit/del_products_p1', 'audit/del_categories_c1', 'audit/del_discounts_X10']) {
    const entry = fake._store[key];
    assert.equal(entry.operation, 'delete');
    assert.equal(entry.operationId, key.slice('audit/'.length));
    assert.equal(entry.actor, 'uid-admin');
    assert.equal(entry.collection, key.split('_')[1]);
  }
  assert.equal(fake._store['audit/del_products_p1'].docId, 'p1');
  assert.equal(fake._store['audit/del_categories_c1'].docId, 'c1');
  assert.equal(fake._store['audit/del_discounts_X10'].docId, 'X10');
});

// ---- Template bundles (entries 16–17): mirror gateway + pointer
// history + approval freeze + rollback + preview slugs + D2 end-date.
// The shared fixtures (entry 22) do not exist yet, so these cases
// validate against gateway-rules.json directly: every rejection reason
// the rules file names has a case here.

function bundleManifest(overrides) {
  return {
    id: 'bazaar', nameAr: 'بازار', nameEn: 'Deal Bazaar', version: '1.0.0',
    shellMinVersion: '1.0.0', bundleHash: 'a'.repeat(64), motion: 'lively', dark: 'light-only',
    behaviours: ['countdown-strip'], sections: ['hero', 'products', 'delivery', 'contact'],
    dataNeeds: ['deliveryFee'], cartLayout: 'drawer', modalLayout: 'default',
    fonts: [{ family: 'Tajawal', weights: [400, 700], origin: 'self' }],
    ...overrides,
  };
}

// The OLD v1 template shape (name / schemaVersion / int version /
// grid / tokens / sections / bodyPath). CLASSIC_TEMPLATE used to be
// this shape; since the decision-15 seed fix it is the six-field
// bundle shape, so tests that need a v1 doc build one explicitly
// here instead of spreading the seed.
function v1TemplateDoc(overrides) {
  return {
    id: 'classic',
    name: 'التصميم الحالي',
    description: 'تصميم المتجر الحالي كما هو — القالب الافتراضي عند الإطلاق.',
    version: 1,
    schemaVersion: 1,
    status: 'active',
    thumbnailUrl: '',
    bodyPath: 'templates/classic.json',
    grid: { columns: null, rows: null, minColumnWidthPx: 250 },
    tokens: {
      bg: '#f4f6f8', bg2: '#eaeff3',
      surface: 'rgba(255, 255, 255, 0.55)',
      surfaceStrong: 'rgba(255, 255, 255, 0.82)',
      border: 'rgba(20, 30, 45, 0.08)',
      text: '#1b2430', textSoft: '#5b6878',
      accent: '#3f7f8c', accent2: '#8fb8b0', warm: '#c9a57a',
      radius: '24px'
    },
    sections: { hero: true, promos: true, featured: true, delivery: true, contact: true },
    ...overrides,
  };
}

// The classic bundle's HOSTED manifest, as validateHostedManifest
// sees it (full-manifest check). Mirrors the real
// storefront/templates/classic/1.0.0/manifest.json field for field,
// except previewImageUrl: the real manifest carries the relative
// '/templates/classic/1.0.0/preview.png', but the PC hosted check
// requires an http(s) preview URL (same rule as the registry
// check), so the stub uses the seed's absolute URL. That
// divergence is pre-existing — the shell and Dart gateways do not
// check previewImageUrl on a hosted manifest, the PC one does —
// and is flagged in the fix report, not fixed here: changing the
// frozen classic manifest would cascade its hash through the Dart
// and PC seed constants.
function classicHostedManifest(overrides) {
  return {
    id: 'classic', nameAr: 'الكلاسيكي', nameEn: 'Classic', version: '1.0.0',
    shellMinVersion: '1.0.0', bundleHash: StoreFB.CLASSIC_BUNDLE_HASH, motion: 'calm', dark: 'variant',
    behaviours: [], sections: ['hero', 'marquee', 'categories', 'featured', 'offers', 'products', 'delivery', 'contact', 'about'],
    dataNeeds: [], cartLayout: 'drawer', modalLayout: 'default',
    fonts: [{ family: 'Tajawal', weights: [300, 400, 500, 700, 800], origin: 'self' }, { family: 'Inter', weights: [300, 400, 500, 600, 700], origin: 'self' }],
    previewImageUrl: 'https://store-3384c.web.app/templates/classic/1.0.0/preview.png',
    ...overrides,
  };
}

function bundleFiles(manifest, overrides) {
  const tokens = { light: { bg: '#ffffff', bg2: '#f5f5f7', surface: '#ffffff', surfaceStrong: '#ffffff', border: '#eeeeee', text: '#111111', textSoft: '#555555', accent: '#F68B1E', accent2: '#141414', warm: '#c9a57a', radius: '24px', font: 'Tajawal' } };
  return {
    'manifest.json': JSON.stringify(manifest),
    'sections/hero.html': '<section data-section="brand"><span data-slot="brand-name"></span></section>',
    'sections/products.html': '<section><div data-slot="product-card"></div><button data-action="add-to-cart">أضف</button></section>',
    'sections/delivery.html': '<section><span data-slot="delivery-fee"></span></section>',
    'sections/contact.html': '<section></section>',
    'styles.css': '.a{color:#fff;transform:translateY(0);transition:transform 300ms}',
    'tokens.json': JSON.stringify(tokens),
    ...overrides,
  };
}

// Files whose manifest.bundleHash is the real hash of the file set.
function hashedBundleFiles(manifest, overrides) {
  const files = bundleFiles(manifest, overrides);
  const hash = StoreFB.computeBundleHash(files);
  const m2 = { ...manifest, bundleHash: hash };
  files['manifest.json'] = JSON.stringify(m2);
  return { manifest: m2, files };
}

function bundleRegistryDoc(manifest, status, approval) {
  const doc = { ...manifest, status };
  if (approval) doc.approval = approval;
  return doc;
}

// Stubs global.fetch so validateHostedManifest serves the given
// hosted manifests (keyed by template id); anything else 404s.
// Returns a restore function — call it in a finally block.
function stubHostedManifests(manifestsById) {
  const origFetch = global.fetch;
  const byUrl = {};
  for (const [id, manifest] of Object.entries(manifestsById)) {
    byUrl['https://store-3384c.web.app/templates/' + id + '/' + (manifest.version || '1.0.0') + '/manifest.json'] = JSON.stringify(manifest);
  }
  global.fetch = async (url) => {
    const text = byUrl[url];
    if (text === undefined) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => text };
  };
  return () => { global.fetch = origFetch; };
}

test('sha256Hex: known vectors', () => {
  assert.equal(StoreFB.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(StoreFB.sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('computeBundleHash: bundleHash field and preview.png excluded; null when a fixed file is missing', () => {
  const { manifest, files } = hashedBundleFiles(bundleManifest());
  const h1 = StoreFB.computeBundleHash(files);
  assert.equal(h1, manifest.bundleHash);
  // Changing only the declared hash does not change the computed hash.
  const files2 = { ...files, 'manifest.json': JSON.stringify({ ...manifest, bundleHash: 'f'.repeat(64) }) };
  assert.equal(StoreFB.computeBundleHash(files2), h1);
  // preview.png is outside the hash.
  const files3 = { ...files, 'preview.png': 'PNG-BYTES-HERE' };
  assert.equal(StoreFB.computeBundleHash(files3), h1);
  // A missing fixed file -> null (the missing file is its own failure).
  const files4 = { ...files };
  delete files4['tokens.json'];
  assert.equal(StoreFB.computeBundleHash(files4), null);
});

test('validateBundleManifest: valid passes; every failure named', () => {
  const good = bundleManifest();
  assert.deepEqual(StoreFB.validateBundleManifest(good, 'bazaar'), { passed: true, failedChecks: [], warnings: [] });
  assert.deepEqual(StoreFB.validateBundleManifest(bundleManifest({ id: 'nope' }), 'nope').failedChecks, ['manifest.id']);
  assert.deepEqual(StoreFB.validateBundleManifest(bundleManifest({ id: 'gallery' }), 'bazaar').failedChecks, ['manifest.id']);
  assert.deepEqual(StoreFB.validateBundleManifest(bundleManifest({ version: '2.0.0' }), 'bazaar').failedChecks, ['manifest.version']);
  assert.deepEqual(StoreFB.validateBundleManifest(bundleManifest({ shellMinVersion: '1.1.0' }), 'bazaar').failedChecks, ['manifest.shellMinVersion']);
  assert.deepEqual(StoreFB.validateBundleManifest(bundleManifest({ shellMinVersion: 'x' }), 'bazaar').failedChecks, ['manifest.shellMinVersion']);
  assert.deepEqual(StoreFB.validateBundleManifest(bundleManifest({ bundleHash: 'zzz' }), 'bazaar').failedChecks, ['manifest.bundleHash']);
  assert.deepEqual(StoreFB.validateBundleManifest(bundleManifest({ motion: 'wild' }), 'bazaar').failedChecks, ['manifest.motion']);
  assert.deepEqual(StoreFB.validateBundleManifest(bundleManifest({ dark: 'maybe' }), 'bazaar').failedChecks, ['manifest.dark']);
  assert.deepEqual(StoreFB.validateBundleManifest(bundleManifest({ behaviours: ['teleport'] }), 'bazaar').failedChecks, ['manifest.behaviours.teleport']);
  assert.deepEqual(StoreFB.validateBundleManifest(bundleManifest({ sections: ['hero', 'products', 'delivery'] }), 'bazaar').failedChecks, ['manifest.sections.contact']);
  assert.deepEqual(StoreFB.validateBundleManifest(bundleManifest({ sections: ['hero', 'products', 'delivery', 'contact', 'nope'] }), 'bazaar').failedChecks, ['manifest.sections.nope']);
  assert.deepEqual(StoreFB.validateBundleManifest(bundleManifest({ dataNeeds: ['stockCount'] }), 'bazaar').failedChecks, ['manifest.dataNeeds.stockCount']);
  assert.deepEqual(StoreFB.validateBundleManifest(bundleManifest({ cartLayout: 'popup' }), 'bazaar').failedChecks, ['manifest.cartLayout']);
  assert.deepEqual(StoreFB.validateBundleManifest(bundleManifest({ fonts: [{ family: 'Evil', origin: 'https://evil.example' }] }), 'bazaar').failedChecks, ['manifest.fonts.Evil']);
  assert.deepEqual(StoreFB.validateBundleManifest(bundleManifest({ nameAr: '  ' }), 'bazaar').failedChecks, ['manifest.nameAr']);
});

test('validateBundleFiles: a valid bundle passes', () => {
  const { manifest, files } = hashedBundleFiles(bundleManifest());
  assert.deepEqual(StoreFB.validateTemplateBundle(manifest, files, 'bazaar'), { passed: true, failedChecks: [], warnings: [] });
});

test('validateBundleFiles: every gateway rejection reason named', () => {
  const base = bundleManifest();
  const check = (overrides) => {
    const { manifest, files } = hashedBundleFiles(base, overrides);
    return StoreFB.validateTemplateBundle(manifest, files, 'bazaar').failedChecks;
  };
  assert.ok(check({ 'sections/products.html': '<section><script>alert(1)</script></section>' }).includes('sections/products.html.tag.script'));
  assert.ok(check({ 'sections/products.html': '<section><img src="x.png" onerror="alert(1)"></section>' }).some((c) => c.includes('.attr.onerror')));
  assert.ok(check({ 'sections/products.html': '<section><a href="javascript:alert(1)">x</a></section>' }).some((c) => c.includes('javascript')));
  assert.ok(check({ 'sections/products.html': '<section><div data-slot="nope"></div></section>' }).includes('sections/products.html.slot.nope'));
  assert.ok(check({ 'sections/products.html': '<section><button data-action="explode">x</button></section>' }).includes('sections/products.html.action.explode'));
  assert.ok(check({ 'sections/products.html': '<section><iframe src="x"></iframe></section>' }).includes('sections/products.html.tag.iframe'));
  assert.ok(check({ 'sections/products.html': '<section><form></form></section>' }).includes('sections/products.html.tag.form'));
  assert.ok(check({ 'sections/products.html': '<section><img src="https://evil.example/x.png"></section>' }).includes('sections/products.html.src.origin'));
  const noDelivery = hashedBundleFiles(base);
  delete noDelivery.files['sections/delivery.html'];
  assert.ok(StoreFB.validateTemplateBundle(noDelivery.manifest, noDelivery.files, 'bazaar').failedChecks.includes('sections.delivery'));
  const noBrand = hashedBundleFiles(base, { 'sections/hero.html': '<section><span data-slot="brand-name"></span></section>' });
  assert.ok(StoreFB.validateTemplateBundle(noBrand.manifest, noBrand.files, 'bazaar').failedChecks.includes('brandSlot'));
  const noTokens = hashedBundleFiles(base);
  delete noTokens.files['tokens.json'];
  assert.ok(StoreFB.validateTemplateBundle(noTokens.manifest, noTokens.files, 'bazaar').failedChecks.includes('tokens.json'));
  assert.ok(check({ 'styles.css': '#cartDrawer{display:block}' }).includes('styles.css.selector.#cartDrawer'));
  assert.ok(check({ 'styles.css': '#modal .price{display:none}' }).includes('styles.css.display-none-transactional'));
  assert.ok(check({ 'styles.css': '.a{filter:blur(2px)}' }).includes('styles.css.blur'));
  assert.ok(check({ 'styles.css': '.a{transition:width 300ms}' }).includes('styles.css.animated-property'));
  assert.ok(check({ 'styles.css': '.a{transition:transform 2000ms}' }).includes('styles.css.motion-duration'));
  assert.ok(check({ 'styles.css': '.a{background:url(https://evil.example/x.png)}' }).includes('styles.css.url-origin'));
  assert.ok(check({ 'styles.css': '@import url(https://evil.example/f.css);' }).includes('styles.css.import-origin'));
  assert.ok(check({ 'styles.css': '.a{background:url(https://res.cloudinary.com/x.png)}' }).length === 0);
  assert.ok(check({ 'tokens.json': JSON.stringify({ light: { bg: '#fff' } }) }).some((c) => c.startsWith('tokens.json.light.')));
  // Hash mismatch: the manifest declares a hash the files do not match.
  const mismatch = hashedBundleFiles(base);
  mismatch.manifest = { ...mismatch.manifest, bundleHash: '0'.repeat(64) };
  mismatch.files['manifest.json'] = JSON.stringify(mismatch.manifest);
  assert.ok(StoreFB.validateTemplateBundle(mismatch.manifest, mismatch.files, 'bazaar').failedChecks.includes('manifest.bundleHash'));
  // RTL physical positioning is a warning, never a failure.
  const rtl = StoreFB.validateTemplateBundle(...(() => { const h = hashedBundleFiles(base, { 'styles.css': '.a{left:0}' }); return [h.manifest, h.files, 'bazaar']; })());
  assert.equal(rtl.passed, true);
  assert.ok(rtl.warnings.includes('styles.css.rtl-physical'));
  // Dark tokens required only when the manifest declares a variant.
  const darkOk = hashedBundleFiles(bundleManifest({ dark: 'variant' }), { 'tokens.json': JSON.stringify({ light: { bg: '#ffffff', bg2: '#f5f5f7', surface: '#ffffff', surfaceStrong: '#ffffff', border: '#eeeeee', text: '#111111', textSoft: '#555555', accent: '#F68B1E', accent2: '#141414', warm: '#c9a57a', radius: '24px', font: 'Tajawal' }, dark: { bg: '#111111', bg2: '#222222', surface: '#222222', surfaceStrong: '#333333', border: '#444444', text: '#ffffff', textSoft: '#cccccc', accent: '#F68B1E', accent2: '#141414', warm: '#c9a57a', radius: '24px', font: 'Tajawal' } }) });
  assert.equal(StoreFB.validateTemplateBundle(darkOk.manifest, darkOk.files, 'bazaar').passed, true);
  const darkMissing = hashedBundleFiles(bundleManifest({ dark: 'variant' }));
  assert.ok(StoreFB.validateTemplateBundle(darkMissing.manifest, darkMissing.files, 'bazaar').failedChecks.includes('tokens.json.dark'));
});

test('validateTemplateBundle: files == null runs manifest checks only', () => {
  const rep = StoreFB.validateTemplateBundle(bundleManifest(), null, 'bazaar');
  assert.equal(rep.passed, true);
  assert.ok(rep.warnings.includes('files-not-checked'));
  const bad = StoreFB.validateTemplateBundle(bundleManifest({ motion: 'wild' }), null, 'bazaar');
  assert.equal(bad.passed, false);
  assert.deepEqual(bad.failedChecks, ['manifest.motion']);
});

test('checkApprovalFreeze: matching approval ok; changed hash / shell / missing approval not ok', () => {
  const doc = bundleRegistryDoc(bundleManifest(), 'approved', { approver: 'a', at: '2026-11-27T00:00:00.000Z', shellVersion: '1.0.0', bundleHash: 'a'.repeat(64) });
  assert.equal(StoreFB.checkApprovalFreeze(doc).ok, true);
  assert.equal(StoreFB.checkApprovalFreeze({ ...doc, bundleHash: 'b'.repeat(64) }).ok, false);
  assert.equal(StoreFB.checkApprovalFreeze({ ...doc, approval: { ...doc.approval, shellVersion: '0.9.0' } }).ok, false);
  assert.equal(StoreFB.checkApprovalFreeze(bundleRegistryDoc(bundleManifest(), 'approved')).ok, false);
});

test('pointer history: append + second-last rollback target; double rollback walks back', () => {
  const h0 = StoreFB.pointerHistoryAppend({}, { templateId: 'classic', bundleVersion: '1.0.0', bundleHash: null, at: 't0', by: 'a' });
  assert.equal(h0.length, 1);
  assert.equal(StoreFB.rollbackTargetFromHistory({ history: h0 }), null);
  const h1 = StoreFB.pointerHistoryAppend({ history: h0 }, { templateId: 'bazaar', bundleVersion: '1.0.0', bundleHash: 'x', at: 't1', by: 'a' });
  assert.equal(StoreFB.rollbackTargetFromHistory({ history: h1 }).templateId, 'classic');
  const h2 = StoreFB.pointerHistoryAppend({ history: h1 }, { templateId: 'classic', bundleVersion: '1.0.0', bundleHash: null, at: 't2', by: 'a' });
  assert.equal(StoreFB.rollbackTargetFromHistory({ history: h2 }).templateId, 'bazaar');
  // Classic pin: classic is the rollback target while live, in the
  // history, or when there is no history at all.
  assert.equal(StoreFB.isRollbackTarget('classic', { templateId: 'classic', history: [] }), true);
  assert.equal(StoreFB.isRollbackTarget('classic', { templateId: 'bazaar', history: h1 }), true);
  assert.equal(StoreFB.isRollbackTarget('classic', { templateId: 'bazaar', history: [{ templateId: 'bazaar' }] }), false);
  assert.equal(StoreFB.isRollbackTarget('classic', {}), true);
});

test('D2 end-date: Cairo offset winter +02:00, summer +03:00; invalid rejected; round-trip', () => {
  assert.equal(StoreFB.promoEndDateToISO('2026-12-01T20:00'), '2026-12-01T20:00:00+02:00');
  assert.equal(StoreFB.promoEndDateToISO('2026-07-01T20:00'), '2026-07-01T20:00:00+03:00');
  assert.equal(StoreFB.promoEndDateToISO('2026-02-30T20:00'), null);
  assert.equal(StoreFB.promoEndDateToISO('not-a-date'), null);
  assert.equal(StoreFB.promoEndDateToISO(''), null);
  assert.equal(StoreFB.isoToLocalInput('2026-07-01T20:00:00+03:00'), '2026-07-01T20:00');
  assert.equal(StoreFB.isoToLocalInput('2026-12-01T20:00:00+02:00'), '2026-12-01T20:00');
  assert.equal(StoreFB.isoToLocalInput('junk'), '');
  assert.equal(StoreFB.isValidISODateTime('2026-12-01T20:00:00+02:00'), true);
  assert.equal(StoreFB.isValidISODateTime('2026-12-01T20:00'), true);
  assert.equal(StoreFB.isValidISODateTime('2026-12-01 20:00'), false);
  assert.equal(StoreFB.isValidISODateTime(''), false);
});

test('activateTemplate (bundle): approval-hash gate + pointer write + history + activation record', async () => {
  const { fake, fb } = await signedInFb();
  const hash = 'b'.repeat(64);
  const approval = { approver: 'admin@store.test', at: '2026-11-27T00:00:00.000Z', shellVersion: '1.0.0', bundleHash: hash };
  fake._store['templates/classic'] = { ...StoreFB.CLASSIC_TEMPLATE, id: 'classic' };
  fake._store['templates/bazaar'] = bundleRegistryDoc(bundleManifest({ bundleHash: hash }), 'approved', approval);
  fake._store['storeSettings/activeTemplate'] = {
    templateId: 'classic', bundleVersion: '1.0.0', bundleHash: null, previousTemplateId: null,
    history: [{ templateId: 'classic', bundleVersion: '1.0.0', bundleHash: null, at: '2026-11-26T00:00:00.000Z', by: 'admin@store.test' }],
  };
  // The hosted-manifest check (decision 2, shape A) fetches the
  // manifest from Hosting; stub it to the matching manifest.
  const restore = stubHostedManifests({ bazaar: bundleManifest({ bundleHash: hash }) });
  try {
    const res = await fb.activateTemplate('bazaar');
    assert.deepEqual(res, { previousTemplateId: 'classic', templateId: 'bazaar', bundleVersion: '1.0.0', bundleHash: hash });
    assert.equal(fake._store['templates/bazaar'].status, 'active');
    assert.equal(fake._store['templates/classic'].status, 'active'); // classic stays active (pinned rollback target)
    const ptr = fake._store['storeSettings/activeTemplate'];
    assert.equal(ptr.templateId, 'bazaar');
    assert.equal(ptr.bundleHash, hash);
    assert.equal(ptr.previousTemplateId, 'classic');
    assert.equal(ptr.history.length, 2);
    assert.equal(ptr.history[1].templateId, 'bazaar');
    assert.equal(ptr.history[1].by, 'admin@store.test');
    const actKeys = Object.keys(fake._store).filter((k) => k.startsWith('templates/bazaar/activations/'));
    assert.equal(actKeys.length, 1);
    assert.equal(fake._store[actKeys[0]].action, 'activate');
    assert.equal(fake._store[actKeys[0]].approver, 'admin@store.test');
    assert.equal(fake._store[actKeys[0]].shellVersion, '1.0.0');
    // Draft / unapproved / changed-hash bundles are refused (rejected
    // before the hosted check, so no fetch is needed for these).
    fake._store['templates/gallery'] = bundleRegistryDoc(bundleManifest({ id: 'gallery', nameAr: 'معرض', nameEn: 'White Gallery' }), 'draft');
    await assert.rejects(fb.activateTemplate('gallery'), /مش معتمد/);
    fake._store['templates/scroll'] = bundleRegistryDoc(bundleManifest({ id: 'scroll', nameAr: 'اسكرول', nameEn: 'Scroll', bundleHash: 'c'.repeat(64) }), 'approved', { ...approval, bundleHash: 'd'.repeat(64) });
    await assert.rejects(fb.activateTemplate('scroll'), /اعتماد جديد/);
  } finally {
    restore();
  }
});

test('rollbackTemplate: restores the second-last history entry; double rollback walks back', async () => {
  const { fake, fb } = await signedInFb();
  fake._store['templates/classic'] = { ...StoreFB.CLASSIC_TEMPLATE, id: 'classic' };
  fake._store['templates/bazaar'] = bundleRegistryDoc(bundleManifest(), 'active');
  fake._store['storeSettings/activeTemplate'] = {
    templateId: 'bazaar', bundleVersion: '1.0.0', bundleHash: 'a'.repeat(64), previousTemplateId: 'classic',
    history: [
      { templateId: 'classic', bundleVersion: '1.0.0', bundleHash: null, at: 't0', by: 'a' },
      { templateId: 'bazaar', bundleVersion: '1.0.0', bundleHash: 'a'.repeat(64), at: 't1', by: 'a' },
    ],
  };
  // The first rollback targets the classic doc — now a bundle doc,
  // so its hosted manifest is fetched too (decision 2, shape A);
  // the second rollback targets a bundle doc, so its hosted
  // manifest is fetched; stub both.
  const restore = stubHostedManifests({ bazaar: bundleManifest(), classic: classicHostedManifest() });
  try {
    const r1 = await fb.rollbackTemplate();
    assert.deepEqual(r1, { templateId: 'classic', previousTemplateId: 'bazaar', fellBack: false, deniedTemplateId: null });
    let ptr = fake._store['storeSettings/activeTemplate'];
    assert.equal(ptr.templateId, 'classic');
    assert.equal(ptr.history.length, 3);
    assert.equal(ptr.history[2].templateId, 'classic');
    assert.equal(fake._store['templates/bazaar'].status, 'approved'); // demoted, keeps approval
    const r2 = await fb.rollbackTemplate();
    assert.equal(r2.templateId, 'bazaar');
    ptr = fake._store['storeSettings/activeTemplate'];
    assert.equal(ptr.templateId, 'bazaar');
    assert.equal(ptr.history.length, 4);
    assert.equal(ptr.history[3].templateId, 'bazaar');
    assert.equal(fake._store['templates/bazaar'].status, 'active');
  } finally {
    restore();
  }
});

test('rollbackTemplate: retired target is denied, classic restored, denial recorded', async () => {
  const { fake, fb } = await signedInFb();
  fake._store['templates/classic'] = { ...StoreFB.CLASSIC_TEMPLATE, id: 'classic' };
  fake._store['templates/gallery'] = bundleRegistryDoc(bundleManifest({ id: 'gallery', nameAr: 'معرض', nameEn: 'White Gallery' }), 'approved');
  fake._store['templates/bazaar'] = bundleRegistryDoc(bundleManifest(), 'active');
  fake._store['storeSettings/activeTemplate'] = {
    templateId: 'bazaar', bundleVersion: '1.0.0', bundleHash: 'a'.repeat(64), previousTemplateId: 'gallery',
    history: [
      { templateId: 'classic', bundleVersion: '1.0.0', bundleHash: null, at: 't0', by: 'a' },
      { templateId: 'gallery', bundleVersion: '1.0.0', bundleHash: 'a'.repeat(64), at: 't1', by: 'a' },
      { templateId: 'bazaar', bundleVersion: '1.0.0', bundleHash: 'a'.repeat(64), at: 't2', by: 'a' },
    ],
  };
  await fb.setTemplateStatus('gallery', 'retired');
  assert.equal(fake._store['templates/gallery'].status, 'retired');
  const r = await fb.rollbackTemplate();
  assert.equal(r.templateId, 'classic');
  assert.equal(r.fellBack, true);
  assert.equal(r.deniedTemplateId, 'gallery');
  const ptr = fake._store['storeSettings/activeTemplate'];
  assert.equal(ptr.templateId, 'classic');
  assert.equal(ptr.history.length, 4);
  assert.ok(ptr.history[3].note && ptr.history[3].note.includes('gallery'));
  assert.equal(fake._store['templates/bazaar'].status, 'approved');
  // No previous template at all -> clear rejection.
  fake._store['storeSettings/activeTemplate'] = { templateId: 'classic', history: [{ templateId: 'classic', at: 't0', by: 'a' }] };
  await assert.rejects(fb.rollbackTemplate(), /مفيش قالب سابق/);
});

test('approveTemplate: preview -> approved with the frozen hash + shell version', async () => {
  const { fake, fb } = await signedInFb();
  fake._store['templates/bazaar'] = bundleRegistryDoc(bundleManifest(), 'preview');
  // The hosted-manifest check (decision 2, shape A) fetches the
  // manifest from Hosting; stub it to the matching manifest.
  const restore = stubHostedManifests({ bazaar: bundleManifest() });
  try {
    assert.equal(await fb.approveTemplate('bazaar'), true);
    const doc = fake._store['templates/bazaar'];
    assert.equal(doc.status, 'approved');
    assert.equal(doc.approval.bundleHash, 'a'.repeat(64));
    assert.equal(doc.approval.shellVersion, '1.0.0');
    assert.equal(doc.approval.approver, 'admin@store.test');
    await assert.rejects(fb.approveTemplate('bazaar'), /مرحلة المعاينة/);
    fake._store['templates/gallery'] = bundleRegistryDoc(bundleManifest({ id: 'gallery', nameAr: 'معرض', nameEn: 'White Gallery' }), 'draft');
    await assert.rejects(fb.approveTemplate('gallery'), /مرحلة المعاينة/);
  } finally {
    restore();
  }
});

test('setTemplateStatus: classic pin + live guard + draft/retired moves', async () => {
  const { fake, fb } = await signedInFb();
  fake._store['templates/classic'] = { ...StoreFB.CLASSIC_TEMPLATE, id: 'classic' };
  fake._store['templates/bazaar'] = bundleRegistryDoc(bundleManifest(), 'active');
  fake._store['templates/scroll'] = bundleRegistryDoc(bundleManifest({ id: 'scroll', nameAr: 'اسكرول', nameEn: 'Scroll' }), 'preview');
  fake._store['templates/gallery'] = bundleRegistryDoc(bundleManifest({ id: 'gallery', nameAr: 'معرض', nameEn: 'White Gallery' }), 'approved');
  fake._store['storeSettings/activeTemplate'] = {
    templateId: 'bazaar', history: [
      { templateId: 'classic', at: 't0', by: 'a' },
      { templateId: 'bazaar', at: 't1', by: 'a' },
    ],
  };
  await assert.rejects(fb.setTemplateStatus('classic', 'retired'), /الكلاسيكي/);
  await assert.rejects(fb.setTemplateStatus('bazaar', 'retired'), /المفعّل/);
  await assert.rejects(fb.setTemplateStatus('gallery', 'active'), /الاعتماد أو التفعيل/);
  assert.equal(await fb.setTemplateStatus('scroll', 'draft'), true);
  assert.equal(fake._store['templates/scroll'].status, 'draft');
  assert.equal(await fb.setTemplateStatus('gallery', 'retired'), true);
  assert.equal(fake._store['templates/gallery'].status, 'retired');
});

test('getOrIssuePreviewSlug: issues a 128-bit slug once, then reuses it', async () => {
  const { fake, fb } = await signedInFb();
  fake._store['templates/bazaar'] = bundleRegistryDoc(bundleManifest(), 'preview');
  const slug = await fb.getOrIssuePreviewSlug('bazaar');
  assert.match(slug, /^[0-9a-f]{32}$/);
  const doc = fake._store['previews/' + slug];
  assert.equal(doc.templateId, 'bazaar');
  assert.equal(doc.status, 'open');
  assert.equal(doc.issuedBy, 'admin@store.test');
  assert.equal(await fb.getOrIssuePreviewSlug('bazaar'), slug);
  await assert.rejects(fb.getOrIssuePreviewSlug('ghost'), /مش موجود/);
});

test('markTemplatePreview: deep gateway pass moves draft -> preview; fail stays draft with the report', async () => {
  const { fake, fb } = await signedInFb();
  const good = hashedBundleFiles(bundleManifest());
  const broken = hashedBundleFiles(bundleManifest(), { 'sections/products.html': '<section><script>alert(1)</script></section>' });
  fake._store['templates/bazaar'] = bundleRegistryDoc(good.manifest, 'draft');
  fake._store['templates/gallery'] = bundleRegistryDoc(broken.manifest, 'draft');
  const origFetch = global.fetch;
  const byUrl = {};
  for (const [p, text] of Object.entries(good.files)) byUrl['https://store-3384c.web.app/templates/bazaar/1.0.0/' + p] = text;
  for (const [p, text] of Object.entries(broken.files)) byUrl['https://store-3384c.web.app/templates/gallery/1.0.0/' + p] = text;
  global.fetch = async (url) => {
    const text = byUrl[url];
    if (text === undefined) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => text };
  };
  try {
    assert.equal(await fb.markTemplatePreview('bazaar'), true);
    assert.equal(fake._store['templates/bazaar'].status, 'preview');
    assert.equal(fake._store['templates/bazaar'].validation.passed, true);
    await assert.rejects(fb.markTemplatePreview('gallery'), /مش صالح للمعاينة/);
    assert.equal(fake._store['templates/gallery'].status, 'draft');
    assert.equal(fake._store['templates/gallery'].validation.passed, false);
    assert.ok(fake._store['templates/gallery'].validation.checks.some((c) => c.includes('tag.script')));
  } finally {
    global.fetch = origFetch;
  }
});

test('index.html wires the template surfaces in: pointer box, cards, preview link, hero note, end-date editor', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  for (const needle of [
    'id="tplPointerBox"', 'id="tplActivateSelect"', 'onclick="rollbackStoreTemplate()"',
    'function approveStoreTemplate(id)', 'function openTemplatePreview(id)',
    'function openSelectedTemplatePreview()', 'id="tplPreviewSelect"',
    'id="hpHeroNote"', 'controlled by the active template',
    'id="hpPromoEndDates"', 'function renderPromoEndDates()', 'function setPromoEndDate(',
    'function validateStoreTemplate(id)', 'function moveTemplateToPreview(id)',
    'subscribeActiveTemplatePointer', 'TPL_D1_CHECKLIST',
  ]) assert.ok(html.includes(needle), 'missing: ' + needle);
});
