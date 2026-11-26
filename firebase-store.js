// ════════════════════════════════════════════════════════════════════════
// Store Manager — Firebase integration (project store-3384c).
//
// The store features (live orders, templates, feedback, shipping
// companies, inventory) read Firestore directly. There are NO Cloud
// Functions on this project (Spark, no-functions contract 2026-11-26):
// orders are created by ONE client transaction (runTransaction) that
// reserves stock, claims the discount, writes the order + movements +
// audit atomically, and order-status transitions move stock in a
// transaction too. The ERP sections (sales, purchases, returns,
// customers, suppliers, expenses, local orders) stay on the local
// JSON files; they are NOT migrated here and local accounts are
// NEVER sent to Firebase.
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
    cancelled: ['new'], // reopen only — cancelled -> in_transit stays denied (must go via new)
    expired: []
  };

  // Feedback is one-way cards (no-functions contract §6): a card has
  // name / email / phone / message / createdAt and nothing else —
  // no status, no priority, no replies, no tracking code. There is
  // no feedback state machine any more, and update/reply are gone;
  // an admin can only delete a card (spam).

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

  // ---- Diagnostics (in-memory, newest 200) ----
  // Best-effort background work (the lazy sweep, the inStock refresh)
  // logs here instead of failing silently; the UI reads it through
  // getDiagnostics() and the activity log. Never contains secrets.
  var diagLog = [];
  function logDiag(message) {
    try {
      diagLog.push({ at: new Date().toISOString(), message: String(message) });
      if (diagLog.length > 200) diagLog.shift();
    } catch (e) { /* logging must never break the work */ }
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

  // ---- Template grid geometry (pure) ----
  // columns = products per row (null = auto-fill), rows = rows shown
  // before "show more" (null = show all). The rows cap is rows ×
  // columns, or rows × 4 when auto-fill (the storefront's fallback
  // column count). Null when rows is null (show all).
  function gridCap(grid) {
    var g = grid || {};
    if (g.rows == null) return null;
    return g.rows * (g.columns || 4);
  }

  function computeStoreProfit(orders, products, opts) {
    var o = opts || {};
    var from = o.from || null;
    var to = o.to || null;
    var byProduct = {};
    var revenue = 0;
    var cogs = 0;
    var missing = [];
    var missingCount = 0;
    var prodById = {};
    (products || []).forEach(function (p) { if (p && p.id) prodById[p.id] = p; });
    (orders || []).forEach(function (ord) {
      if (!ord) return;
      // Revenue counts only realised sales: delivered, or paid
      // (cod_paid) even if not yet marked delivered. Cancelled /
      // expired / still-open orders are not revenue.
      var realised = ord.status === 'delivered' || ord.paymentStatus === 'cod_paid';
      if (!realised) return;
      var d = null;
      if (ord.createdAt) {
        if (ord.createdAt.toDate) { try { d = ord.createdAt.toDate(); } catch (e) { d = null; } }
        else if (typeof ord.createdAt === 'object' && typeof ord.createdAt.seconds === 'number') d = new Date(ord.createdAt.seconds * 1000);
        else d = new Date(ord.createdAt);
        if (d && isNaN(d.getTime())) d = null;
      }
      if (from && d && d < new Date(from + 'T00:00:00')) return;
      if (to && d && d > new Date(to + 'T23:59:59')) return;
      revenue += (ord.total || 0);
      (ord.items || []).forEach(function (it) {
        var qty = it.qty || 0;
        var pid = it.productId || '';
        var unitCost = (it.unitCost > 0) ? it.unitCost : ((prodById[pid] && prodById[pid].costPrice) || 0);
        if (!byProduct[pid]) byProduct[pid] = { qty: 0, rev: 0, cost: 0, missingCost: false, name: it.name || (prodById[pid] && prodById[pid].name) || pid };
        byProduct[pid].qty += qty;
        byProduct[pid].rev += (it.subtotal || ((it.price || 0) * qty));
        if (unitCost > 0) {
          byProduct[pid].cost += unitCost * qty;
          cogs += unitCost * qty;
        } else {
          // No cost anywhere for this item: never invent one.
          // Exclude it from the cost total and flag it so the UI
          // shows a dash instead of a number.
          byProduct[pid].missingCost = true;
          missingCount += qty;
          missing.push({ orderId: ord.id || '', productId: pid, name: it.name || pid, qty: qty });
        }
      });
    });
    return { revenue: revenue, cogs: cogs, gross: revenue - cogs, missingCount: missingCount, missing: missing, byProduct: byProduct };
  }

  // ---- No-functions order helpers (pure) ----
  // Dedupe order lines by productId (sums quantities) — the
  // transaction validates the deduped lines, never the raw form rows.
  function dedupeOrderLines(items) {
    var byId = {};
    var order = [];
    (items || []).forEach(function (it) {
      if (!it || !it.productId) return;
      var pid = it.productId;
      var qty = parseInt(it.qty, 10);
      if (isNaN(qty)) qty = 0;
      if (!byId[pid]) { byId[pid] = { productId: pid, qty: 0 }; order.push(byId[pid]); }
      byId[pid].qty += qty;
    });
    return order;
  }

  // Totals from DATABASE prices (never a client-supplied total).
  // discountAmount = round(subtotal * percent / 100), 0 with no code.
  function computeOrderTotals(lines, percent) {
    var subtotal = 0;
    (lines || []).forEach(function (l) { subtotal += (l.price || 0) * (l.qty || 0); });
    subtotal = Math.round(subtotal * 100) / 100;
    var p = percent || 0;
    var discountAmount = p > 0 ? Math.round(subtotal * p / 100) : 0;
    var total = Math.round((subtotal - discountAmount) * 100) / 100;
    return { subtotal: subtotal, discountAmount: discountAmount, total: total };
  }

  function computeInStock(stock, reserved) {
    return ((stock || 0) - (reserved || 0)) > 0;
  }

  // Firestore Timestamp / Date / ISO string / seconds-number -> Date.
  function orderDateValue(v) {
    if (!v) return null;
    if (v.toDate) { try { return v.toDate(); } catch (e) { return null; } }
    if (typeof v === 'object' && typeof v.seconds === 'number') return new Date(v.seconds * 1000);
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  // Low-stock flags (contract §8): available (stock - reserved) at or
  // below the product's own minStock (default 5). products carry
  // {id, name, minStock}; inventoryMap is {productId: {stock, reserved}}.
  function lowStockProducts(products, inventoryMap, defaultMinStock) {
    var defMin = (defaultMinStock == null) ? 5 : defaultMinStock;
    var inv = inventoryMap || {};
    var out = [];
    (products || []).forEach(function (p) {
      if (!p || !p.id) return;
      var entry = inv[p.id] || {};
      var stock = entry.stock || 0;
      var reserved = entry.reserved || 0;
      var minStock = (p.minStock == null) ? defMin : p.minStock;
      var available = stock - reserved;
      if (available <= minStock) {
        out.push({ id: p.id, name: p.name || p.id, stock: stock, reserved: reserved, available: available, minStock: minStock });
      }
    });
    out.sort(function (a, b) { return a.available - b.available; });
    return out;
  }

  // Sales by period (contract §8): totals of non-cancelled orders,
  // bucketed by day (last 14 days), week (last 8 weeks, week starts
  // Monday) or month (last 12 months). Each bucket: {label, total,
  // count}. Labels are ISO dates / week starts / YYYY-MM.
  function salesByPeriod(orders, period) {
    var p = period || 'day';
    var buckets = {};
    var bucketOrder = [];
    function bucketKey(d) {
      if (p === 'month') return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      if (p === 'week') {
        var wd = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        var day = (wd.getDay() + 6) % 7; // Monday = 0
        wd.setDate(wd.getDate() - day);
        return wd.toISOString().slice(0, 10);
      }
      return d.toISOString().slice(0, 10);
    }
    function bucketLabel(key) {
      if (p === 'month') return key;
      if (p === 'week') return 'أسبوع ' + key;
      return key.slice(5); // MM-DD
    }
    var now = new Date();
    // Seed every bucket in the window so empty buckets still draw:
    // 14 days, 8 weeks (Monday starts), 12 months.
    if (p === 'month') {
      for (var mi = 11; mi >= 0; mi--) {
        var md = new Date(now.getFullYear(), now.getMonth() - mi, 1);
        var mk = md.getFullYear() + '-' + String(md.getMonth() + 1).padStart(2, '0');
        if (!buckets[mk]) { buckets[mk] = { label: mk, total: 0, count: 0 }; bucketOrder.push(mk); }
      }
    } else if (p === 'week') {
      for (var wi = 7; wi >= 0; wi--) {
        var wd0 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - wi * 7);
        var wday = (wd0.getDay() + 6) % 7;
        wd0.setDate(wd0.getDate() - wday);
        var wk = wd0.toISOString().slice(0, 10);
        if (!buckets[wk]) { buckets[wk] = { label: 'أسبوع ' + wk, total: 0, count: 0 }; bucketOrder.push(wk); }
      }
    } else {
      for (var di = 13; di >= 0; di--) {
        var dd = new Date(now.getFullYear(), now.getMonth(), now.getDate() - di);
        var dk = dd.toISOString().slice(0, 10);
        if (!buckets[dk]) { buckets[dk] = { label: dk.slice(5), total: 0, count: 0 }; bucketOrder.push(dk); }
      }
    }
    var spanDays = p === 'month' ? 365 : (p === 'week' ? 56 : 14);
    var start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - spanDays + 1);
    (orders || []).forEach(function (o) {
      if (!o || o.status === 'cancelled') return;
      var d = orderDateValue(o.createdAt);
      if (!d || d < start) return;
      var k = bucketKey(d);
      if (!buckets[k]) { buckets[k] = { label: bucketLabel(k), total: 0, count: 0 }; bucketOrder.push(k); }
      buckets[k].total += (o.total || 0);
      buckets[k].count += 1;
    });
    bucketOrder.sort();
    return bucketOrder.map(function (k) { return { key: k, label: buckets[k].label, total: Math.round(buckets[k].total * 100) / 100, count: buckets[k].count }; });
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

  // The audit entry's primary (collection, docId) is the FIRST key
  // of the writes map — order writes must come first so the audit
  // names the order, not an inventory line.
  function primaryFirst(writes, primaryKey) {
    var out = {};
    if (writes[primaryKey] !== undefined) out[primaryKey] = writes[primaryKey];
    Object.keys(writes).forEach(function (k) {
      if (k !== primaryKey) out[k] = writes[k];
    });
    return out;
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

    // Offline restore: a remembered session must enter without
    // network, but the admins/{uid} role read needs it. The last
    // confirmed role is cached locally (uid + role only) and used
    // ONLY when the live read fails — the rules still enforce the
    // role server-side on every read/write, so a stale cache can
    // never grant real access, only the UI session.
    var ROLE_CACHE_KEY = 'sb_store_role';
    function readCachedRole(uid) {
      try {
        if (typeof localStorage === 'undefined') return null;
        var raw = localStorage.getItem(ROLE_CACHE_KEY);
        if (!raw) return null;
        var c = JSON.parse(raw);
        if (c && c.uid === uid && (c.role === 'admin' || c.role === 'manager')) return c.role;
      } catch (e) { /* corrupted cache = no cache */ }
      return null;
    }
    function cacheRole(uid, role) {
      try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(ROLE_CACHE_KEY, JSON.stringify({ uid: uid, role: role }));
      } catch (e) { /* storage unavailable — the online read still works */ }
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
            cacheRole(user.uid, role);
            setState({ connected: true, user: { uid: user.uid, email: user.email || '' }, role: role, error: null });
            settleAuthWaiters(null);
            resolve(true);
          }).catch(function (e) {
            // Offline (or failing) role read: fall back to the last
            // confirmed role for this user so a remembered session
            // still enters. Without a cached role there is nothing
            // to fall back to — the sign-in stays refused.
            var cached = readCachedRole(user.uid);
            if (cached) {
              setState({ connected: true, user: { uid: user.uid, email: user.email || '' }, role: cached, error: null });
              settleAuthWaiters(null);
              resolve(true);
              return;
            }
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

    // Remember-me: LOCAL persistence keeps the session across app
    // restarts (the user is never asked again); SESSION ends it when
    // the app closes. Called before signIn; a failure to set it is
    // non-fatal (the SDK default is LOCAL).
    function setPersistenceMode(remember) {
      if (!app) return Promise.resolve();
      try {
        var authNs = firebaseNs.auth;
        var modes = authNs && authNs.Auth && authNs.Auth.Persistence;
        if (!modes || typeof firebaseNs.auth().setPersistence !== 'function') return Promise.resolve();
        return firebaseNs.auth().setPersistence(remember ? modes.LOCAL : modes.SESSION).catch(function () {});
      } catch (e) {
        return Promise.resolve();
      }
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

    // ---- No-functions order creation (contract §1) ----
    // ONE client transaction: idempotency first (the order doc id IS
    // the clientOrderId — a retry reuses it and returns the existing
    // order, created:false), then read products + inventory + discount,
    // validate, total from DATABASE prices, reserve stock, claim the
    // discount, create the order + movements + audit, atomically.
    // The rules enforce reserved <= stock on the reservation writes,
    // so an over-reservation is denied; the client then re-reads
    // inventory and shows the available count only.
    function _txError(code, message, extra) {
      var e = new Error(message);
      e.code = code;
      if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
      return e;
    }

    function createManualOrder(input) {
      requireAdmin();
      var inp = input || {};
      var clientOrderId = inp.clientOrderId || newUuid();
      var customer = inp.customer || {};
      var custName = (inp.customerName || customer.name || '').trim();
      var custPhone = String(inp.customerPhone || customer.phone || '').replace(/\D/g, '');
      var custAddress = (inp.customerAddress || customer.address || '').trim();
      var discountCode = (inp.discountCode || '').trim() || null;
      var seenPrices = inp.seenPrices || null;
      var seenTotal = (inp.seenTotal == null) ? null : inp.seenTotal;
      var lines = dedupeOrderLines(inp.items || []);
      // Shape validation before any read (client-side, contract §1.3).
      if (!custName) return Promise.reject(_txError('INVALID_INPUT', 'اسم العميل مطلوب'));
      if (custPhone.length < 10) return Promise.reject(_txError('INVALID_INPUT', 'رقم موبايل العميل ناقص — لازم 10 أرقام على الأقل'));
      if (!custAddress) return Promise.reject(_txError('INVALID_INPUT', 'عنوان العميل مطلوب'));
      if (!lines.length || lines.length > 7) return Promise.reject(_txError('ORDER_TOO_LARGE', 'الطلب فيه منتجات أكتر من الحد المسموح (7)'));
      /* Cap is 7 lines (coordinator fix 2026-11-26): the rules
       * allow 10 get()/getAfter() calls per operation, and the
       * order-create rule costs N+3 for a manual order, so an
       * 8-line manual order with a code is denied by the platform
       * (7 lines = 10 calls, the safe max). */
      for (var vi = 0; vi < lines.length; vi++) {
        if (!Number.isInteger(lines[vi].qty) || lines[vi].qty < 1 || lines[vi].qty > 20) {
          return Promise.reject(_txError('INVALID_INPUT', 'الكمية لازم تكون من 1 لـ 20 لكل صنف'));
        }
      }
      var actorUid = state.user.uid;
      var actorName = state.user.email || '';
      var orderRef = db().collection('orders').doc(clientOrderId);
      var committedLines = null; // {productId, qty, stock, newReserved} — for the §13 refresh
      var createdOrder = null;
      return db().runTransaction(function (tx) {
        return tx.get(orderRef).then(function (orderSnap) {
          if (orderSnap.exists) {
            var existing = orderSnap.data() || {};
            existing.id = orderSnap.id;
            createdOrder = existing;
            committedLines = [];
            return { created: false };
          }
          var productRefs = lines.map(function (l) { return db().collection('products').doc(l.productId); });
          var invRefs = lines.map(function (l) { return db().collection('inventory').doc(l.productId); });
          var reads = productRefs.map(function (r) { return tx.get(r); })
            .concat(invRefs.map(function (r) { return tx.get(r); }));
          var discountRef = discountCode ? db().collection('discounts').doc(discountCode) : null;
          if (discountRef) reads.push(tx.get(discountRef));
          return Promise.all(reads).then(function (snaps) {
            var priced = [];
            var currentPrices = {};
            for (var i = 0; i < lines.length; i++) {
              var pSnap = snaps[i];
              var invSnap = snaps[lines.length + i];
              if (!pSnap.exists) throw _txError('NOT_FOUND', 'منتج مش موجود: ' + lines[i].productId, { productId: lines[i].productId });
              var pData = pSnap.data() || {};
              var price = pData.price;
              if (typeof price !== 'number' || !isFinite(price) || price <= 0) {
                throw _txError('PRICE_CHANGED', 'سعر المنتج ' + (pData.name || lines[i].productId) + ' مش صالح', { productId: lines[i].productId });
              }
              currentPrices[lines[i].productId] = price;
              var inv = invSnap.exists ? (invSnap.data() || {}) : {};
              var stock = inv.stock || 0;
              var reserved = inv.reserved || 0;
              var available = stock - reserved;
              if (lines[i].qty > available) {
                throw _txError('INSUFFICIENT_STOCK',
                  'المتاح دلوقتي من ' + (pData.name || lines[i].productId) + ' هو ' + available + ' بس',
                  { productId: lines[i].productId, availableQty: available });
              }
              priced.push({
                productId: lines[i].productId, name: pData.name || lines[i].productId,
                price: price, qty: lines[i].qty, stock: stock, reserved: reserved, newReserved: reserved + lines[i].qty
              });
            }
            if (seenPrices) {
              for (var sp = 0; sp < priced.length; sp++) {
                if (seenPrices[priced[sp].productId] != null && seenPrices[priced[sp].productId] !== priced[sp].price) {
                  throw _txError('PRICE_CHANGED', 'اتغير سعر منتج من اللي شفتهم — راجع الأسعار وحاول تاني', { currentPrices: currentPrices });
                }
              }
            }
            var percent = null;
            var discountSnap = discountRef ? snaps[snaps.length - 1] : null;
            if (discountCode) {
              if (!discountSnap || !discountSnap.exists) throw _txError('DISCOUNT_INVALID', 'كود الخصم مش صحيح');
              var dData = discountSnap.data() || {};
              if (dData.usedBy != null) throw _txError('DISCOUNT_USED', 'كود الخصم ده اتستخدم قبل كده');
              if (dData.active !== true) throw _txError('DISCOUNT_INVALID', 'كود الخصم مش صحيح');
              var exp = orderDateValue(dData.expiresAt);
              if (exp && exp.getTime() <= Date.now()) throw _txError('DISCOUNT_INVALID', 'كود الخصم منتهي');
              percent = dData.percent;
              if (!Number.isInteger(percent) || percent < 1 || percent > 100) throw _txError('DISCOUNT_INVALID', 'كود الخصم مش صحيح');
            }
            var totals = computeOrderTotals(priced, percent);
            if (seenTotal != null && Math.abs(seenTotal - totals.total) > 0.009) {
              throw _txError('TOTAL_CHANGED', 'اتغير الإجمالي — راجع الإجمالي وحاول تاني', { currentPrices: currentPrices, currentTotal: totals.total });
            }
            var auditId = newUuid();
            var auditRef = db().collection('audit').doc(auditId);
            var opId = auditId;
            var now = serverTimestamp();
            var orderData = {
              id: clientOrderId, clientOrderId: clientOrderId,
              customerName: custName, customerPhone: custPhone, customerAddress: custAddress,
              items: priced.map(function (l) { return { productId: l.productId, name: l.name, price: l.price, qty: l.qty }; }),
              subtotal: totals.subtotal, discountCode: discountCode, discountPercent: percent,
              discountAmount: totals.discountAmount, total: totals.total,
              status: 'new', paymentStatus: 'cod_pending', source: 'admin_manual',
              createdBy: actorUid, shippingCompanyId: inp.shippingCompanyId || null,
              trackingNumber: null, notes: inp.notes || null,
              createdAt: now, updatedAt: now,
              acceptedAt: null, deliveredAt: null, cancelledAt: null, cancelReason: null,
              auditId: auditId, operationId: opId
            };
            // Reserve stock (absolute set, merge). The rules deny
            // reserved > stock, so this is the atomic guard.
            var writes = {};
            var sensitive = {};
            priced.forEach(function (l) {
              tx.set(db().collection('inventory').doc(l.productId), { reserved: l.newReserved, operationId: opId, updatedAt: now }, { merge: true });
              writes['inventory/' + l.productId] = { reserved: l.newReserved };
              sensitive['inventory/' + l.productId] = { reserved: l.newReserved };
            });
            if (discountRef) {
              tx.set(discountRef, { usedBy: clientOrderId, usedAt: now, operationId: opId, updatedAt: now }, { merge: true });
              writes['discounts/' + discountCode] = { usedBy: clientOrderId };
              sensitive['discounts/' + discountCode] = {};
            }
            priced.forEach(function (l) {
              var mvRef = db().collection('movements').doc();
              tx.set(mvRef, {
                productId: l.productId, type: 'order_reserve', qty: -l.qty,
                orderId: clientOrderId, source: 'createManualOrder',
                actorUid: actorUid, createdAt: now, operationId: opId, updatedAt: now
              });
              writes['movements/' + mvRef.id] = { type: 'order_reserve', qty: -l.qty };
              sensitive['movements/' + mvRef.id] = {};
            });
            writes['orders/' + clientOrderId] = { status: 'new', total: totals.total };
            sensitive['orders/' + clientOrderId] = { status: 'new', total: totals.total };
            writes = primaryFirst(writes, 'orders/' + clientOrderId);
            var entry = buildAuditEntry({
              opId: opId, actor: actorUid, actorName: actorName, timestamp: now,
              operation: 'manual_order_create', writes: writes, sensitive: sensitive,
              oldValues: {}, topNewValues: { status: 'new', total: totals.total }
            });
            entry.source = 'createManualOrder';
            tx.set(auditRef, entry);
            tx.set(orderRef, orderData);
            committedLines = priced;
            createdOrder = orderData;
            return { created: true };
          });
        });
      }).then(function (res) {
        // §13 second write (best-effort, retry 3x, logged): refresh
        // products.inStock from the inventory values just written.
        // The transaction itself never writes products.inStock (that
        // would push the rules budget over 20 for 10-line orders).
        if (res.created && committedLines && committedLines.length) {
          return refreshInStock(committedLines).then(function () {
            return { order: createdOrder, created: true };
          });
        }
        return { order: createdOrder, created: false };
      });
    }

    // ---- §13: products.inStock refresh (second write) ----
    // Batched, retry up to 3 times, best-effort, logged on failure.
    // A failure leaves a stale availability flag until the next
    // admin sync / lazy sweep corrects it.
    function refreshInStock(lines) {
      var writes = {};
      var sensitive = {};
      (lines || []).forEach(function (l) {
        var stock = (l.stock != null) ? l.stock : 0;
        var reserved = (l.newReserved != null) ? l.newReserved : (l.reserved || 0);
        writes['products/' + l.productId] = { inStock: computeInStock(stock, reserved) };
        sensitive['products/' + l.productId] = { inStock: computeInStock(stock, reserved) };
      });
      if (!Object.keys(writes).length) return Promise.resolve(true);
      var attempt = 0;
      function tryOnce() {
        attempt++;
        return auditedWrite({ writes: writes, sensitive: sensitive, operation: 'stock_instock_refresh' })
          .then(function () { return true; })
          .catch(function (e) {
            logDiag('inStock refresh failed (attempt ' + attempt + '/3): ' + (e.message || e));
            if (attempt < 3) return tryOnce();
            return false;
          });
      }
      return tryOnce();
    }

    // ---- Lazy sweep (contract §5, replaces the scheduled sweep) ----
    // Expires 'new' orders older than 24h, releasing their reservations
    // (same release as cancel). Idempotent: status + TTL are re-checked
    // inside each order's transaction. Run on boot, when the orders
    // page loads, and every 30 minutes while the app is open.
    var SWEEP_TTL_MS = 24 * 60 * 60 * 1000;
    function expireOneOrder(orderId, cutoff) {
      var orderRef = db().collection('orders').doc(orderId);
      var actorUid = state.user ? state.user.uid : 'sweep';
      var actorName = state.user ? (state.user.email || '') : 'sweep';
      return db().runTransaction(function (tx) {
        return tx.get(orderRef).then(function (snap) {
          if (!snap.exists) return false;
          var o = snap.data() || {};
          if ((o.status || 'new') !== 'new') return false;
          var created = orderDateValue(o.createdAt);
          if (!created || created.getTime() >= cutoff.getTime()) return false;
          var items = o.items || [];
          var auditId = newUuid();
          var auditRef = db().collection('audit').doc(auditId);
          var opId = auditId;
          var now = serverTimestamp();
          var writes = {};
          var sensitive = {};
          var invReads = items.map(function (it) { return tx.get(db().collection('inventory').doc(it.productId)); });
          return Promise.all(invReads).then(function (invSnaps) {
            var lines = [];
            items.forEach(function (it, i) {
              var inv = invSnaps[i].exists ? (invSnaps[i].data() || {}) : {};
              var stock = inv.stock || 0;
              var reserved = inv.reserved || 0;
              var newReserved = Math.max(0, reserved - (it.qty || 0));
              lines.push({ productId: it.productId, qty: it.qty || 0, stock: stock, reserved: reserved, newReserved: newReserved });
              tx.set(db().collection('inventory').doc(it.productId), { reserved: newReserved, operationId: opId, updatedAt: now }, { merge: true });
              writes['inventory/' + it.productId] = { reserved: newReserved };
              sensitive['inventory/' + it.productId] = { reserved: newReserved };
              var mvRef = db().collection('movements').doc();
              tx.set(mvRef, {
                productId: it.productId, type: 'reservation_expire', qty: it.qty || 0,
                orderId: orderId, source: 'sweep', actorUid: 'sweep', createdAt: now, operationId: opId, updatedAt: now
              });
              writes['movements/' + mvRef.id] = { type: 'reservation_expire', qty: it.qty || 0 };
              sensitive['movements/' + mvRef.id] = {};
            });
            var orderFields = { status: 'expired', cancelReason: 'reservation_expired', updatedAt: now, operationId: opId };
            tx.set(orderRef, orderFields, { merge: true });
            writes['orders/' + orderId] = { status: 'expired', cancelReason: 'reservation_expired' };
            sensitive['orders/' + orderId] = { status: 'expired' };
            writes = primaryFirst(writes, 'orders/' + orderId);
            var entry = buildAuditEntry({
              opId: opId, actor: actorUid, actorName: actorName, timestamp: now,
              operation: 'order_expire', writes: writes, sensitive: sensitive,
              oldValues: { ['orders/' + orderId]: { status: 'new' } },
              topNewValues: { status: 'expired' }
            });
            entry.source = 'sweep';
            tx.set(auditRef, entry);
            return { expired: true, lines: lines };
          });
        });
      }).then(function (res) {
        if (res && res.expired && res.lines && res.lines.length) {
          return refreshInStock(res.lines).then(function () { return true; });
        }
        return !!(res && res.expired);
      });
    }

    function runLazySweep() {
      requireAdmin();
      var cutoff = new Date(Date.now() - SWEEP_TTL_MS);
      return db().collection('orders')
        .where('status', '==', 'new')
        .where('createdAt', '<', cutoff)
        .get()
        .then(function (snap) {
          var ids = [];
          snap.forEach(function (d) { ids.push(d.id); });
          var swept = 0;
          var failed = [];
          var chain = Promise.resolve();
          ids.forEach(function (id) {
            chain = chain.then(function () {
              return expireOneOrder(id, cutoff).then(function (ok) {
                if (ok) swept++;
              }).catch(function (e) {
                failed.push({ id: id, error: e.message || String(e) });
                logDiag('lazy sweep failed for order ' + id + ': ' + (e.message || e));
              });
            });
          });
          return chain.then(function () {
            if (swept > 0) logDiag('lazy sweep expired ' + swept + ' order(s)');
            return { swept: swept, failed: failed, checked: ids.length };
          });
        })
        .catch(function (e) {
          logDiag('lazy sweep query failed: ' + (e.message || e));
          throw e;
        });
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

    // Order-status transitions (contract §2, mirrors Flutter
    // setOrderStatus). Pure steps (accepted / preparing / ready /
    // in_transit) stay one audited write. Stock-moving transitions
    // run in a transaction that re-reads the order + inventory:
    // - cancel: release the reservation (reserved -= qty, min 0),
    //   movement 'order_cancel', cancelledAt stamped.
    // - deliver: deduct stock AND reserved, movement 'order_deliver',
    //   deliveredAt stamped.
    // - reopen (cancelled -> new): re-reserve (reserved += qty);
    //   if ANY line is short, throw with the product id + available
    //   count and write nothing; movements 'reopen_reserve', and the
    //   cancel stamp is DELETED (cancelledAt + cancelReason via
    //   FieldValue.delete() — both listed in the audit docIds).
    // Every stock-moving transition also refreshes products.inStock
    // for its lines inside the same transaction.
    var STOCK_MOVING_TO = { cancelled: 'cancel', delivered: 'deliver', new: 'reopen' };
    function updateOrderStatus(order, to, opts) {
      var from = (order && order.status) || 'new';
      if (from === to) return Promise.resolve(false);
      if (!isAllowedOrderTransition(from, to)) {
        return Promise.reject(new Error('ماينفعش تنقل الطلب من ' + from + ' لـ ' + to));
      }
      var kind = STOCK_MOVING_TO[to];
      var isStockMove = !!kind && (
        (kind === 'cancel' && from !== 'cancelled' && from !== 'expired') ||
        (kind === 'deliver' && from === 'in_transit') ||
        (kind === 'reopen' && from === 'cancelled')
      );
      if (!isStockMove) {
        var fields = { status: to };
        if (to === 'accepted') fields.acceptedAt = serverTimestamp();
        if (to === 'cancelled') fields.cancelledAt = serverTimestamp();
        return auditedWrite({
          writes: { ['orders/' + order.id]: fields },
          sensitive: { ['orders/' + order.id]: { status: to } },
          operation: 'order_status',
          oldValues: { ['orders/' + order.id]: { status: from } },
          topNewValues: { status: to }
        }).then(function () { return true; });
      }
      requireAdmin();
      var orderRef = db().collection('orders').doc(order.id);
      var actorUid = state.user.uid;
      var actorName = state.user.email || '';
      var cancelReason = (opts && opts.cancelReason) || null;
      return db().runTransaction(function (tx) {
        return tx.get(orderRef).then(function (snap) {
          if (!snap.exists) throw new Error('الطلب مش موجود');
          var o = snap.data() || {};
          var curFrom = o.status || 'new';
          if (curFrom === to) return false;
          if (!isAllowedOrderTransition(curFrom, to)) {
            throw new Error('ماينفعش تنقل الطلب من ' + curFrom + ' لـ ' + to);
          }
          var items = o.items || [];
          var invReads = items.map(function (it) { return tx.get(db().collection('inventory').doc(it.productId)); });
          var prodReads = items.map(function (it) { return tx.get(db().collection('products').doc(it.productId)); });
          return Promise.all(invReads.concat(prodReads)).then(function (snaps) {
            var auditId = newUuid();
            var auditRef = db().collection('audit').doc(auditId);
            var opId = auditId;
            var now = serverTimestamp();
            var writes = {};
            var sensitive = {};
            var oldOrderValues = { status: curFrom };
            var orderFields = { status: to, updatedAt: now, operationId: opId };
            var deleteFields = null;
            if (kind === 'cancel') {
              orderFields.cancelledAt = now;
              if (cancelReason) orderFields.cancelReason = cancelReason;
              oldOrderValues.cancelledAt = o.cancelledAt || null;
            } else if (kind === 'deliver') {
              orderFields.deliveredAt = now;
            } else if (kind === 'reopen') {
              // Deletes must be real FieldValue.delete() sentinels so
              // the fields leave the document (and the audit docIds
              // list them — the hotfix lesson).
              deleteFields = { cancelledAt: firebaseNs.firestore.FieldValue.delete(), cancelReason: firebaseNs.firestore.FieldValue.delete() };
              oldOrderValues.cancelledAt = o.cancelledAt || null;
              oldOrderValues.cancelReason = o.cancelReason || null;
            }
            items.forEach(function (it, i) {
              var invSnap = snaps[i];
              var prodSnap = snaps[items.length + i];
              var inv = invSnap.exists ? (invSnap.data() || {}) : {};
              var stock = inv.stock || 0;
              var reserved = inv.reserved || 0;
              var qty = it.qty || 0;
              var newReserved = reserved;
              var newStock = stock;
              var mvType;
              var mvQty;
              if (kind === 'cancel') {
                newReserved = Math.max(0, reserved - qty);
                mvType = 'order_cancel'; mvQty = qty;
              } else if (kind === 'deliver') {
                newReserved = Math.max(0, reserved - qty);
                newStock = Math.max(0, stock - qty);
                mvType = 'order_deliver'; mvQty = -qty;
              } else { // reopen: re-reserve, throw with the available count when short
                var available = stock - reserved;
                if (qty > available) {
                  var prodData = prodSnap.exists ? (prodSnap.data() || {}) : {};
                  throw _txError('INSUFFICIENT_STOCK',
                    'المتاح دلوقتي من ' + (prodData.name || it.name || it.productId) + ' هو ' + available + ' بس',
                    { productId: it.productId, availableQty: available });
                }
                newReserved = reserved + qty;
                mvType = 'reopen_reserve'; mvQty = -qty;
              }
              tx.set(db().collection('inventory').doc(it.productId), { reserved: newReserved, operationId: opId, updatedAt: now }, { merge: true });
              writes['inventory/' + it.productId] = { reserved: newReserved };
              sensitive['inventory/' + it.productId] = { reserved: newReserved };
              if (kind === 'deliver') {
                tx.set(db().collection('inventory').doc(it.productId), { stock: newStock }, { merge: true });
                writes['inventory/' + it.productId].stock = newStock;
                sensitive['inventory/' + it.productId].stock = newStock;
              }
              var inStock = computeInStock(newStock, newReserved);
              tx.set(db().collection('products').doc(it.productId), { inStock: inStock, operationId: opId, updatedAt: now }, { merge: true });
              writes['products/' + it.productId] = { inStock: inStock };
              sensitive['products/' + it.productId] = { inStock: inStock };
              var mvRef = db().collection('movements').doc();
              tx.set(mvRef, {
                productId: it.productId, type: mvType, qty: mvQty,
                orderId: order.id, source: 'store_manager',
                actorUid: actorUid, createdAt: now, operationId: opId, updatedAt: now
              });
              writes['movements/' + mvRef.id] = { type: mvType, qty: mvQty };
              sensitive['movements/' + mvRef.id] = {};
            });
            // The order write carries the deleted fields as keys so
            // buildAuditEntry lists them in docIds (the hotfix lesson).
            var auditOrderFields = {};
            Object.keys(orderFields).forEach(function (k) { auditOrderFields[k] = orderFields[k]; });
            if (deleteFields) {
              Object.keys(deleteFields).forEach(function (k) { auditOrderFields[k] = deleteFields[k]; });
            }
            writes['orders/' + order.id] = auditOrderFields;
            sensitive['orders/' + order.id] = { status: to };
            writes = primaryFirst(writes, 'orders/' + order.id);
            var entry = buildAuditEntry({
              opId: opId, actor: actorUid, actorName: actorName, timestamp: now,
              operation: 'order_status', writes: writes, sensitive: sensitive,
              oldValues: { ['orders/' + order.id]: oldOrderValues },
              topNewValues: { status: to }
            });
            entry.source = 'store_manager';
            tx.set(auditRef, entry);
            if (deleteFields) {
              var upd = {};
              Object.keys(orderFields).forEach(function (k) { upd[k] = orderFields[k]; });
              Object.keys(deleteFields).forEach(function (k) { upd[k] = deleteFields[k]; });
              tx.update(orderRef, upd);
            } else {
              tx.set(orderRef, orderFields, { merge: true });
            }
            return true;
          });
        });
      });
    }

    // Attach the ERP-side metadata the order transaction does not
    // store (the sale link + the delivery dates the form keeps). One
    // audited update after the order is created.
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

    // Edit a template's grid geometry (columns/rows) from the
    // templates page. Validates the merged doc through the same
    // gateway the activation path uses, then saves it as one audited
    // write (operation 'template_grid'). A bad grid is rejected
    // before anything is written.
    function updateTemplateGrid(templateId, grid) {
      requireAdmin();
      var nextGrid = {
        columns: (grid && grid.columns != null) ? grid.columns : null,
        rows: (grid && grid.rows != null) ? grid.rows : null,
        minColumnWidthPx: (grid && grid.minColumnWidthPx != null) ? grid.minColumnWidthPx : 250
      };
      return db().collection('templates').doc(templateId).get().then(function (snap) {
        if (!snap.exists) throw new Error('القالب مش موجود');
        var data = snap.data() || {};
        var merged = {};
        Object.keys(data).forEach(function (k) { merged[k] = data[k]; });
        merged.grid = nextGrid;
        var report = validateTemplateDoc(merged);
        if (!report.passed) throw new Error('الشبكة مش صالحة: ' + report.failedChecks.join('، '));
        return auditedWrite({
          writes: { ['templates/' + templateId]: { grid: nextGrid } },
          sensitive: {},
          operation: 'template_grid',
          oldValues: { ['templates/' + templateId]: { grid: data.grid || null } },
          topNewValues: { templateId: templateId }
        });
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

    // One audited DELETE: the document is deleted and its audit entry
    // lands in the same batch (the rules allow a delete only with its
    // delete-audit). oldValues lists the fields the audit covers.
    function auditedDelete(collection, docId, operation, oldValues) {
      requireAdmin();
      var batch = db().batch();
      var auditRef = db().collection('audit').doc();
      var opId = auditRef.id;
      var key = collection + '/' + docId;
      var writes = {};
      writes[key] = {};
      var entry = buildAuditEntry({
        opId: opId,
        actor: state.user.uid,
        actorName: state.user.email || '',
        timestamp: serverTimestamp(),
        operation: operation,
        writes: writes,
        sensitive: {},
        oldValues: { [key]: oldValues || {} },
        topNewValues: {}
      });
      // The delete-audit covers the deleted doc's known fields.
      entry.docIds[key] = Object.keys(oldValues || {});
      entry.documents = [{
        collection: collection, docId: docId,
        changedFields: Object.keys(oldValues || {}),
        oldValues: oldValues || {}, newValues: {}
      }];
      batch.delete(db().collection(collection).doc(docId));
      batch.set(auditRef, entry);
      return batch.commit().then(function () { return true; });
    }

    // Feedback is one-way cards (§6): the only admin action is
    // deleting a card (spam).
    function deleteFeedback(feedbackId) {
      return auditedDelete('feedback', feedbackId, 'feedback_delete', {});
    }

    function deleteWebsiteProduct(productId) {
      return auditedDelete('products', productId, 'product_delete', {});
    }

    function deleteCategory(categoryId) {
      return auditedDelete('categories', categoryId, 'category_delete', {});
    }

    function deleteDiscount(code) {
      return auditedDelete('discounts', code, 'discount_delete', {});
    }

    // ---- Website-control subscriptions (contract §8) ----
    function subscribeProducts(cb) {
      return _subscribe(db().collection('products').orderBy('name'), cb);
    }

    function subscribeCategories(cb) {
      return _subscribe(db().collection('categories').orderBy('name'), cb);
    }

    function subscribeDiscounts(cb) {
      return _subscribe(db().collection('discounts').orderBy('code'), cb);
    }

    // The three website-settings docs in one callback:
    // {settings, homepage, design}. Each doc is read live; a missing
    // doc reports as {} so the editors show the defaults.
    function subscribeWebsiteSettings(cb) {
      requireAdmin();
      var current = { settings: {}, homepage: {}, design: {} };
      var unsubs = [];
      [['settings', 'settings'], ['homepage', 'homepage'], ['design', 'design']].forEach(function (pair) {
        var key = pair[0];
        var docId = pair[1];
        unsubs.push(db().collection('storeSettings').doc(docId).onSnapshot(function (snap) {
          current[key] = snap.exists ? (snap.data() || {}) : {};
          cb(current, null);
        }, function (err) {
          cb(null, err);
        }));
      });
      return function () { unsubs.forEach(function (u) { try { u(); } catch (e) {} }); };
    }

    return {
      state: state,
      onStateChange: onStateChange,
      init: init,
      signIn: signIn,
      signOut: signOut,
      setPersistenceMode: setPersistenceMode,
      updateTemplateGrid: updateTemplateGrid,
      subscribeOrders: subscribeOrders,
      subscribeTemplates: subscribeTemplates,
      subscribeFeedback: subscribeFeedback,
      subscribeShippingCompanies: subscribeShippingCompanies,
      subscribeInventory: subscribeInventory,
      subscribeActiveTemplate: subscribeActiveTemplate,
      subscribeProducts: subscribeProducts,
      subscribeCategories: subscribeCategories,
      subscribeDiscounts: subscribeDiscounts,
      subscribeWebsiteSettings: subscribeWebsiteSettings,
      createManualOrder: createManualOrder,
      runLazySweep: runLazySweep,
      refreshInStock: refreshInStock,
      auditedWrite: auditedWrite,
      auditedDelete: auditedDelete,
      updateOrderStatus: updateOrderStatus,
      updateOrderPaymentStatus: updateOrderPaymentStatus,
      attachOrderMeta: attachOrderMeta,
      activateTemplate: activateTemplate,
      deleteFeedback: deleteFeedback,
      deleteWebsiteProduct: deleteWebsiteProduct,
      deleteCategory: deleteCategory,
      deleteDiscount: deleteDiscount,
      getDiagnostics: function () { return diagLog.slice(); },
      // Pure helpers (also exported on the factory for the tests).
      isAllowedOrderTransition: isAllowedOrderTransition,
      validateTemplateDoc: validateTemplateDoc,
      friendlyCallableError: friendlyCallableError,
      newUuid: newUuid
    };
  }

  return {
    create: create,
    ORDER_TRANSITIONS: ORDER_TRANSITIONS,
    SENSITIVE_FIELDS: SENSITIVE_FIELDS,
    CLASSIC_TEMPLATE: CLASSIC_TEMPLATE,
    isAllowedOrderTransition: isAllowedOrderTransition,
    validateTemplateDoc: validateTemplateDoc,
    gridCap: gridCap,
    computeStoreProfit: computeStoreProfit,
    buildAuditEntry: buildAuditEntry,
    dedupeOrderLines: dedupeOrderLines,
    computeOrderTotals: computeOrderTotals,
    computeInStock: computeInStock,
    orderDateValue: orderDateValue,
    lowStockProducts: lowStockProducts,
    salesByPeriod: salesByPeriod,
    friendlyCallableError: friendlyCallableError,
    friendlyAuthError: friendlyAuthError,
    newUuid: newUuid
  };
});
