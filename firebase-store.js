// ════════════════════════════════════════════════════════════════════════
// Store Manager — Firebase integration (project store-3384c).
//
// The store features (live orders, templates, feedback, shipping
// companies, inventory) read Firestore and call the same Phase 2
// Cloud Functions the phone app uses — never a second backend.
// The ERP sections (sales, purchases, returns, customers, suppliers,
// expenses, local orders) stay on the local JSON files; they are NOT
// migrated here and local accounts are NEVER sent to Firebase.
//
// How it runs:
// - The Firebase Web SDK (compat builds) is loaded from node_modules
//   via <script> tags in index.html; this module reads the global
//   `firebase` namespace (injected into create() so Node tests can
//   pass a fake). No DOM access here — index.html renders.
// - The web app config is the storefront's public config (the same
//   identifiers any visitor's browser receives). The apiKey is a
//   public identifier, not a secret — the security lives in
//   firestore.rules (admin/manager roles + the audited-write
//   enforcement). No service-account key, no secret, ever.
// - Every admin write goes through auditedWrite(): the changed
//   document(s) + one /audit/{operationId} entry in the same batch,
//   exactly the shape firestore.rules enforces (actor + timestamp +
//   docIds coverage + the recorded new value of every changed
//   SENSITIVE field). A write without its audit entry is denied by
//   the rules, so the app can never silently skip the audit.
// - Auth: the same Firebase Auth accounts as the phone app
//   (admin/manager). The local ERP sign-in stays as the app gate;
//   this sign-in unlocks the store sections only.
// ════════════════════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.StoreFBFactory = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- The unified order state machine (v1.4 Decision 23) ----
  // Mirrors functions/lib/orders.js ORDER_TRANSITIONS and the Flutter
  // Backend.orderTransitions exactly. Same-state is a no-op (allowed).
  var ORDER_TRANSITIONS = {
    'new': ['accepted', 'cancelled', 'expired'],
    accepted: ['preparing', 'cancelled'],
    preparing: ['ready', 'cancelled'],
    ready: ['in_transit', 'cancelled'],
    in_transit: ['delivered'],
    delivered: [],
    cancelled: [],
    expired: []
  };

  // ---- The feedback state machine (v1.4 §8.3, firestore.rules) ----
  var FEEDBACK_TRANSITIONS = {
    'new': ['in_review', 'rejected', 'spam'],
    in_review: ['awaiting_customer', 'resolved', 'rejected', 'spam'],
    awaiting_customer: ['resolved', 'in_review'],
    resolved: ['closed'],
    closed: [],
    rejected: [],
    spam: []
  };

  // Sensitive fields whose new value the audit entry must record
  // correctly (firestore.rules sensitiveValuesOk).
  var SENSITIVE_FIELDS = ['price', 'stock', 'reserved', 'status', 'paymentStatus', 'inStock', 'percent'];

  // ---- Template registry (mirrors lib/services/templates_service.dart) ----
  var TEMPLATE_TOKEN_KEYS = ['bg', 'bg2', 'surface', 'surfaceStrong', 'border', 'text', 'textSoft', 'accent', 'accent2', 'warm', 'radius'];
  var TEMPLATE_SECTION_KEYS = ['hero', 'promos', 'featured', 'delivery', 'contact'];
  var TEMPLATE_STATUSES = ['draft', 'active', 'archived'];

  // The launch template: the current live site, preserved as-is.
  // Same values as storefront/templates/classic.json.
  var CLASSIC_TEMPLATE = {
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
    sections: { hero: true, promos: true, featured: true, delivery: true, contact: true }
  };

  function isAllowedOrderTransition(from, to) {
    if (from === to) return true;
    return (ORDER_TRANSITIONS[from] || []).indexOf(to) !== -1;
  }

  function isAllowedFeedbackTransition(from, to) {
    if (from === to) return true;
    return (FEEDBACK_TRANSITIONS[from] || []).indexOf(to) !== -1;
  }

  function newUuid() {
    try {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) { /* fall through to the Math.random fallback */ }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  // ---- Template validation gateway (pure) ----
  // Mirrors validateTemplateDoc in lib/services/templates_service.dart:
  // a template is a card only when every check passes.
  function _isSafeCssValue(key, value) {
    var v = String(value).trim();
    if (!v) return false;
    if (v.indexOf('url(') !== -1 || v.indexOf('expression') !== -1 ||
        v.indexOf('javascript:') !== -1 || v.indexOf(';') !== -1 ||
        v.indexOf('"') !== -1 || v.indexOf("'") !== -1 ||
        v.indexOf('<') !== -1 || v.indexOf('>') !== -1) return false;
    if (key === 'radius') {
      var m = /^(\d+)px$/.exec(v);
      if (!m) return false;
      var n = parseInt(m[1], 10);
      return n >= 0 && n <= 64;
    }
    if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)) return true;
    var rgba = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.]+)\s*\)$/.exec(v);
    if (rgba) {
      var r = parseInt(rgba[1], 10), g = parseInt(rgba[2], 10), b = parseInt(rgba[3], 10);
      var a = parseFloat(rgba[4]);
      return r <= 255 && g <= 255 && b <= 255 && a >= 0 && a <= 1;
    }
    return false;
  }

  function validateTemplateDoc(doc) {
    var failed = [];
    var d = doc || {};
    var name = d.name;
    if (typeof name !== 'string' || !name.trim()) failed.push('name');
    if (d.schemaVersion !== 1) failed.push('schemaVersion');
    var status = d.status;
    if (typeof status !== 'string' || TEMPLATE_STATUSES.indexOf(status) === -1) failed.push('status');
    var version = d.version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) failed.push('version');
    var grid = d.grid;
    if (grid != null) {
      if (typeof grid !== 'object' || Array.isArray(grid)) {
        failed.push('grid');
      } else {
        var columns = grid.columns;
        if (columns != null && (typeof columns !== 'number' || !Number.isInteger(columns) || columns < 1 || columns > 12)) failed.push('grid.columns');
        var rows = grid.rows;
        if (rows != null && (typeof rows !== 'number' || !Number.isInteger(rows) || rows < 1 || rows > 20)) failed.push('grid.rows');
        var minW = grid.minColumnWidthPx;
        if (minW != null && (typeof minW !== 'number' || !Number.isInteger(minW) || minW < 120 || minW > 600)) failed.push('grid.minColumnWidthPx');
      }
    }
    var tokens = d.tokens;
    if (tokens != null) {
      if (typeof tokens !== 'object' || Array.isArray(tokens)) {
        failed.push('tokens');
      } else {
        Object.keys(tokens).forEach(function (key) {
          if (TEMPLATE_TOKEN_KEYS.indexOf(key) === -1) { failed.push('tokens.' + key); return; }
          if (typeof tokens[key] !== 'string' || !_isSafeCssValue(key, tokens[key])) failed.push('tokens.' + key);
        });
      }
    }
    var sections = d.sections;
    if (sections != null) {
      if (typeof sections !== 'object' || Array.isArray(sections)) {
        failed.push('sections');
      } else {
        Object.keys(sections).forEach(function (key) {
          if (TEMPLATE_SECTION_KEYS.indexOf(key) === -1) { failed.push('sections.' + key); return; }
          if (typeof sections[key] !== 'boolean') failed.push('sections.' + key);
        });
      }
    }
    var bodyPath = d.bodyPath;
    if (bodyPath != null) {
      if (typeof bodyPath !== 'string' || bodyPath.indexOf('templates/') !== 0 || bodyPath.slice(-5) !== '.json') failed.push('bodyPath');
    }
    var thumbnail = d.thumbnailUrl;
    if (thumbnail != null && typeof thumbnail === 'string' && thumbnail !== '' && thumbnail.indexOf('http') !== 0) failed.push('thumbnailUrl');
    return { passed: failed.length === 0, failedChecks: failed };
  }

  // ---- Callable error mapping (mirrors Backend._friendlyCallableError) ----
  // The functions return HttpsError with details.code = the structured
  // code (toHttpsError). The message shown is the Arabic one.
  function friendlyCallableError(e) {
    var details = (e && e.details) || {};
    var code = details.code || (e && e.code) || 'internal';
    switch (code) {
      case 'PRICE_CHANGED': return 'اتغير سعر منتج من اللي شفتهم — راجع الأسعار وحاول تاني';
      case 'TOTAL_CHANGED': return 'اتغير الإجمالي — راجع الإجمالي وحاول تاني';
      case 'INSUFFICIENT_STOCK': return 'الكمية المطلوبة أكبر من المتاح في المخزون';
      case 'DISCOUNT_INVALID': return 'كود الخصم مش صحيح';
      case 'DISCOUNT_USED': return 'كود الخصم ده اتستخدم قبل كده';
      case 'ORDER_TOO_LARGE': return 'الطلب فيه منتجات أكتر من الحد المسموح (10)';
      case 'RATE_LIMITED': return 'محاولات كتير في وقت قصير — استنى شوية وحاول تاني';
      case 'PERMISSION_DENIED': return 'ماعندكش صلاحية تعمل العملية دي';
      case 'NOT_FOUND': return 'البيانات المطلوبة مش موجودة';
      case 'BLOCKED': return 'الإرسال محظور مؤقتاً من الرقم ده';
      case 'INVALID_INPUT': return 'البيانات مش كاملة أو مش صحيحة';
      default: return 'حصل خطأ: ' + code;
    }
  }

  function friendlyAuthError(e) {
    var code = (e && e.code) || '';
    switch (code) {
      case 'auth/user-not-found':
      case 'auth/invalid-credential':
      case 'auth/wrong-password': return 'الإيميل أو كلمة السر غلط';
      case 'auth/invalid-email': return 'الإيميل مش صحيح';
      case 'auth/too-many-requests': return 'محاولات كتير — استنى شوية وحاول تاني';
      case 'auth/network-request-failed': return 'مفيش اتصال بالإنترنت';
      case 'auth/user-disabled': return 'الحساب ده موقوف';
      default: return (e && e.message) || 'تعذر تسجيل الدخول';
    }
  }

  // ---- The audit entry (pure builder — the shape firestore.rules enforces) ----
  // writes: { 'collection/docId': {field: value} } — the fields to set
  //   (merged). sensitive: the same keys → {sensitive field: new value}.
  // The entry's docIds list covers every field the write actually
  // changes (the written fields + operationId + updatedAt, which the
  // write stamps alongside). newValuesByDoc records the new value of
  // every changed SENSITIVE field, so a fake audit that lists the
  // field but records a wrong value is denied by the rules.
  function buildAuditEntry(opts) {
    var docIds = {};
    var newValuesByDoc = {};
    var documents = [];
    var changedAll = [];
    var primaryCollection = '';
    var primaryDocId = '';
    var oldMerged = {};
    Object.keys(opts.writes).forEach(function (key) {
      var slash = key.indexOf('/');
      var collection = key.slice(0, slash);
      var docId = key.slice(slash + 1);
      if (!primaryCollection) { primaryCollection = collection; primaryDocId = docId; }
      var changed = Object.keys(opts.writes[key]).concat(['operationId', 'updatedAt']);
      docIds[key] = changed;
      newValuesByDoc[key] = opts.sensitive[key] || {};
      changed.forEach(function (f) { if (changedAll.indexOf(f) === -1) changedAll.push(f); });
      var oldForDoc = (opts.oldValues && opts.oldValues[key]) || {};
      Object.keys(oldForDoc).forEach(function (k) { oldMerged[k] = oldForDoc[k]; });
      documents.push({
        collection: collection,
        docId: docId,
        changedFields: changed,
        oldValues: oldForDoc,
        newValues: opts.sensitive[key] || {}
      });
    });
    return {
      operationId: opts.opId,
      actor: opts.actor,
      actorName: opts.actorName || '',
      timestamp: opts.timestamp,
      collection: primaryCollection,
      docId: primaryDocId,
      operation: opts.operation,
      changedFields: changedAll,
      oldValues: oldMerged,
      newValues: opts.topNewValues || {},
      docIds: docIds,
      newValuesByDoc: newValuesByDoc,
      documents: documents,
      source: 'store_manager'
    };
  }

  // ---- The instance ----
  function create(firebaseNs, config) {
    var state = { sdk: false, connected: false, user: null, role: null, error: null };
    var stateCbs = [];
    var authWaiters = [];
    var app = null;
    var authReady = false;

    function emit() {
      var snap = { sdk: state.sdk, connected: state.connected, user: state.user, role: state.role, error: state.error };
      stateCbs.slice().forEach(function (cb) { try { cb(snap); } catch (e) { /* a listener must never break the state */ } });
    }

    function setState(patch) {
      Object.keys(patch).forEach(function (k) { state[k] = patch[k]; });
      emit();
    }

    function settleAuthWaiters(err) {
      var waiters = authWaiters;
      authWaiters = [];
      waiters.forEach(function (w) { if (err) w.reject(err); else w.resolve(); });
    }

    function onStateChange(cb) {
      stateCbs.push(cb);
      return function () {
        var i = stateCbs.indexOf(cb);
        if (i !== -1) stateCbs.splice(i, 1);
      };
    }

    function db() {
      if (!app) throw new Error('Firebase مش مهيأ — سجّل دخول المتجر الأول');
      return firebaseNs.firestore();
    }

    function serverTimestamp() {
      return firebaseNs.firestore.FieldValue.serverTimestamp();
    }

    function requireAdmin() {
      if (!state.user || (state.role !== 'admin' && state.role !== 'manager')) {
        throw new Error('سجّل دخول المتجر بحساب أدمن الأول');
      }
    }

    function init() {
      if (!firebaseNs) {
        setState({ error: 'مكتبة Firebase مش متوفرة' });
        return Promise.resolve(false);
      }
      try {
        if (!firebaseNs.apps || !firebaseNs.apps.length) {
          app = firebaseNs.initializeApp(config);
        } else {
          app = firebaseNs.apps[0];
        }
      } catch (e) {
        setState({ error: 'تعذر تهيئة Firebase: ' + (e.message || e) });
        return Promise.resolve(false);
      }
      setState({ sdk: true, error: null });
      return new Promise(function (resolve) {
        firebaseNs.auth().onAuthStateChanged(function (user) {
          authReady = true;
          if (!user) {
            setState({ connected: false, user: null, role: null, error: null });
            settleAuthWaiters(null);
            resolve(true);
            return;
          }
          // The role lives in admins/{uid}; the rules trust it, so the
          // app must read it before treating the user as an admin.
          db().collection('admins').doc(user.uid).get().then(function (snap) {
            var role = snap.exists ? (snap.data() || {}).role : null;
            if (role !== 'admin' && role !== 'manager') {
              firebaseNs.auth().signOut().catch(function () {});
              setState({ connected: false, user: null, role: null, error: 'الحساب ده مش أدمن في المتجر' });
              settleAuthWaiters(new Error('الحساب ده مش أدمن في المتجر'));
              resolve(true);
              return;
            }
            setState({ connected: true, user: { uid: user.uid, email: user.email || '' }, role: role, error: null });
            settleAuthWaiters(null);
            resolve(true);
          }).catch(function (e) {
            setState({ connected: false, user: null, role: null, error: 'تعذر قراءة صلاحيات الحساب: ' + (e.message || e) });
            settleAuthWaiters(new Error('تعذر قراءة صلاحيات الحساب'));
            resolve(true);
          });
        });
      });
    }

    function waitAuthSettled() {
      return new Promise(function (resolve, reject) {
        authWaiters.push({ resolve: resolve, reject: reject });
      });
    }

    function signIn(email, password) {
      if (!app) return Promise.reject(new Error('Firebase مش مهيأ'));
      var p = waitAuthSettled();
      return firebaseNs.auth().signInWithEmailAndPassword(email, password).then(function () {
        return p.then(function () {
          if (!state.connected) throw new Error(state.error || 'تعذر تسجيل الدخول');
          return { uid: state.user.uid, email: state.user.email, role: state.role };
        });
      }).catch(function (e) {
        // The auth listener already set the friendly state error for a
        // non-admin account; a sign-in failure itself maps here.
        if (state.error) throw new Error(state.error);
        throw new Error(friendlyAuthError(e));
      });
    }

    function signOut() {
      if (!app) return Promise.resolve();
      return firebaseNs.auth().signOut();
    }

    function _subscribe(query, cb) {
      requireAdmin();
      return query.onSnapshot(function (snap) {
        var list = [];
        snap.forEach(function (d) {
          var data = d.data() || {};
          data.id = d.id;
          list.push(data);
        });
        cb(list, null);
      }, function (err) {
        cb(null, err);
      });
    }

    function subscribeOrders(cb) {
      return _subscribe(db().collection('orders').orderBy('createdAt', 'desc').limit(100), cb);
    }

    function subscribeTemplates(cb) {
      return _subscribe(db().collection('templates').orderBy('name'), cb);
    }

    function subscribeFeedback(cb) {
      return _subscribe(db().collection('feedback').orderBy('createdAt', 'desc').limit(100), cb);
    }

    function subscribeShippingCompanies(cb) {
      return _subscribe(db().collection('shippingCompanies').orderBy('name'), cb);
    }

    function subscribeInventory(cb) {
      return _subscribe(db().collection('inventory').limit(500), function (list, err) {
        if (err) { cb(null, err); return; }
        var map = {};
        (list || []).forEach(function (inv) { map[inv.id] = { stock: inv.stock || 0, reserved: inv.reserved || 0 }; });
        cb(map, null);
      });
    }

    // Live pointer: which template id the storefront renders right now.
    function subscribeActiveTemplate(cb) {
      requireAdmin();
      return db().collection('storeSettings').doc('activeTemplate').onSnapshot(function (snap) {
        var data = snap.exists ? (snap.data() || {}) : {};
        cb(data.templateId || 'classic', null);
      }, function (err) {
        cb(null, err);
      });
    }

    function callFunction(name, data) {
      requireAdmin();
      var callable = firebaseNs.functions().httpsCallable(name);
      return callable(data).then(function (res) {
        return res.data;
      }).catch(function (e) {
        throw new Error(friendlyCallableError(e));
      });
    }

    function createManualOrder(input) {
      return callFunction('createManualOrder', input);
    }

    // One audited write chunk-set, mirroring Backend._auditedBatch:
    // every admin mutation is a batched write that includes its audit
    // entry. Writes are chunked at 10 document pairs per batch (20
    // documents incl. the audit entry) per the rules' access-call
    // budget. Each chunk gets its own operationId + audit entry.
    function auditedWrite(opts) {
      requireAdmin();
      var keys = Object.keys(opts.writes || {});
      if (!keys.length) return Promise.resolve();
      var chunks = [];
      for (var i = 0; i < keys.length; i += 10) chunks.push(keys.slice(i, i + 10));
      var chain = Promise.resolve();
      chunks.forEach(function (chunkKeys) {
        chain = chain.then(function () {
          var batch = db().batch();
          var auditRef = db().collection('audit').doc();
          var opId = auditRef.id;
          var chunkWrites = {};
          var chunkSensitive = {};
          var chunkOld = {};
          chunkKeys.forEach(function (k) {
            chunkWrites[k] = opts.writes[k];
            chunkSensitive[k] = (opts.sensitive && opts.sensitive[k]) || {};
            if (opts.oldValues && opts.oldValues[k]) chunkOld[k] = opts.oldValues[k];
          });
          var entry = buildAuditEntry({
            opId: opId,
            actor: state.user.uid,
            actorName: state.user.email || '',
            timestamp: serverTimestamp(),
            operation: opts.operation,
            writes: chunkWrites,
            sensitive: chunkSensitive,
            oldValues: chunkOld,
            topNewValues: opts.topNewValues || {}
          });
          chunkKeys.forEach(function (key) {
            var slash = key.indexOf('/');
            var ref = db().collection(key.slice(0, slash)).doc(key.slice(slash + 1));
            var data = {};
            Object.keys(chunkWrites[key]).forEach(function (f) { data[f] = chunkWrites[key][f]; });
            data.operationId = opId;
            data.updatedAt = serverTimestamp();
            batch.set(ref, data, { merge: true });
          });
          batch.set(auditRef, entry);
          return batch.commit();
        });
      });
      return chain;
    }

    function updateOrderStatus(order, to) {
      var from = order.status || 'new';
      if (from === to) return Promise.resolve(false);
      if (!isAllowedOrderTransition(from, to)) {
        return Promise.reject(new Error('ماينفعش تنقل الطلب من ' + from + ' لـ ' + to));
      }
      var fields = { status: to };
      if (to === 'accepted') fields.acceptedAt = serverTimestamp();
      return auditedWrite({
        writes: { ['orders/' + order.id]: fields },
        sensitive: { ['orders/' + order.id]: { status: to } },
        operation: 'order_status',
        oldValues: { ['orders/' + order.id]: { status: from } },
        topNewValues: { status: to }
      }).then(function () { return true; });
    }

    // Attach the ERP-side metadata the callable does not store (the
    // sale link + the delivery dates the form keeps). One audited
    // update after the callable creates the order.
    function attachOrderMeta(orderId, meta) {
      var fields = {};
      if (meta.saleId != null) fields.saleId = meta.saleId;
      if (meta.shipDate) fields.shipDate = meta.shipDate;
      if (meta.dueDate) fields.dueDate = meta.dueDate;
      if (meta.receivedDate) fields.receivedDate = meta.receivedDate;
      if (!Object.keys(fields).length) return Promise.resolve(false);
      return auditedWrite({
        writes: { ['orders/' + orderId]: fields },
        sensitive: {},
        operation: 'order_meta'
      }).then(function () { return true; });
    }

    function updateOrderPaymentStatus(order, paymentStatus) {
      var from = order.paymentStatus || 'cod_pending';
      if (from === paymentStatus) return Promise.resolve(false);
      return auditedWrite({
        writes: { ['orders/' + order.id]: { paymentStatus: paymentStatus } },
        sensitive: { ['orders/' + order.id]: { paymentStatus: paymentStatus } },
        operation: 'order_payment',
        oldValues: { ['orders/' + order.id]: { paymentStatus: from } },
        topNewValues: { paymentStatus: paymentStatus }
      }).then(function () { return true; });
    }

    function ensureClassicTemplateDoc() {
      var ref = db().collection('templates').doc('classic');
      return ref.get().then(function (snap) {
        if (snap.exists) return false;
        var body = {};
        Object.keys(CLASSIC_TEMPLATE).forEach(function (k) { body[k] = CLASSIC_TEMPLATE[k]; });
        return auditedWrite({
          writes: { 'templates/classic': body },
          sensitive: {},
          operation: 'template_seed'
        }).then(function () { return true; });
      });
    }

    // Mirrors TemplatesService.activateTemplate (Flutter): validate the
    // doc, seed classic when missing, set the template active when it
    // is not, then move the pointer (storing the current id as the new
    // previous, so one-tap rollback is a single pointer write).
    function activateTemplate(templateId) {
      requireAdmin();
      return db().collection('templates').doc(templateId).get().then(function (snap) {
        if (!snap.exists) throw new Error('القالب مش موجود');
        var data = snap.data() || {};
        var report = validateTemplateDoc(data);
        if (!report.passed) throw new Error('القالب مش صالح للتفعيل: ' + report.failedChecks.join('، '));
        return ensureClassicTemplateDoc().then(function () {
          return db().collection('storeSettings').doc('activeTemplate').get();
        }).then(function (ptrSnap) {
          var currentId = (ptrSnap.exists && (ptrSnap.data() || {}).templateId) || 'classic';
          if (currentId === templateId) throw new Error('القالب ده مفعّل أصلاً');
          var chain = Promise.resolve();
          if (data.status !== 'active') {
            chain = chain.then(function () {
              return auditedWrite({
                writes: { ['templates/' + templateId]: { status: 'active' } },
                sensitive: { ['templates/' + templateId]: { status: 'active' } },
                operation: 'template_activate',
                oldValues: { ['templates/' + templateId]: { status: data.status } },
                topNewValues: { templateId: templateId, status: 'active' }
              });
            });
          }
          return chain.then(function () {
            return auditedWrite({
              writes: { 'storeSettings/activeTemplate': { templateId: templateId, previousTemplateId: currentId } },
              sensitive: {},
              operation: 'template_activate',
              topNewValues: { templateId: templateId, status: 'active' }
            });
          }).then(function () { return { previousTemplateId: currentId }; });
        });
      });
    }

    function updateFeedbackStatus(feedback, to) {
      var from = feedback.status || 'new';
      if (from === to) return Promise.resolve(false);
      if (!isAllowedFeedbackTransition(from, to)) {
        return Promise.reject(new Error('ماينفعش تنقل الشكوى من ' + from + ' لـ ' + to));
      }
      return auditedWrite({
        writes: { ['feedback/' + feedback.id]: { status: to } },
        sensitive: { ['feedback/' + feedback.id]: { status: to } },
        operation: 'feedback_status',
        oldValues: { ['feedback/' + feedback.id]: { status: from } },
        topNewValues: { status: to }
      }).then(function () { return true; });
    }

    function replyToFeedback(feedbackId, text) {
      requireAdmin();
      var ref = db().collection('feedback').doc(feedbackId).collection('replies').doc();
      return ref.set({
        text: text,
        authorUid: state.user.uid,
        authorName: state.user.email || '',
        createdAt: serverTimestamp()
      }).then(function () { return ref.id; });
    }

    return {
      state: state,
      onStateChange: onStateChange,
      init: init,
      signIn: signIn,
      signOut: signOut,
      subscribeOrders: subscribeOrders,
      subscribeTemplates: subscribeTemplates,
      subscribeFeedback: subscribeFeedback,
      subscribeShippingCompanies: subscribeShippingCompanies,
      subscribeInventory: subscribeInventory,
      subscribeActiveTemplate: subscribeActiveTemplate,
      createManualOrder: createManualOrder,
      auditedWrite: auditedWrite,
      updateOrderStatus: updateOrderStatus,
      updateOrderPaymentStatus: updateOrderPaymentStatus,
      attachOrderMeta: attachOrderMeta,
      activateTemplate: activateTemplate,
      updateFeedbackStatus: updateFeedbackStatus,
      replyToFeedback: replyToFeedback,
      // Pure helpers (also exported on the factory for the tests).
      isAllowedOrderTransition: isAllowedOrderTransition,
      isAllowedFeedbackTransition: isAllowedFeedbackTransition,
      validateTemplateDoc: validateTemplateDoc,
      friendlyCallableError: friendlyCallableError,
      newUuid: newUuid
    };
  }

  return {
    create: create,
    ORDER_TRANSITIONS: ORDER_TRANSITIONS,
    FEEDBACK_TRANSITIONS: FEEDBACK_TRANSITIONS,
    SENSITIVE_FIELDS: SENSITIVE_FIELDS,
    CLASSIC_TEMPLATE: CLASSIC_TEMPLATE,
    isAllowedOrderTransition: isAllowedOrderTransition,
    isAllowedFeedbackTransition: isAllowedFeedbackTransition,
    validateTemplateDoc: validateTemplateDoc,
    buildAuditEntry: buildAuditEntry,
    friendlyCallableError: friendlyCallableError,
    friendlyAuthError: friendlyAuthError,
    newUuid: newUuid
  };
});
