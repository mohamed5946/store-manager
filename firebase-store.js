// ════════════════════════════════════════════════════════════════════════
// Store Manager — Firebase integration (project store-3384c).
//
// The store features (live orders, templates, feedback, shipping
// companies, inventory) read Firestore directly. There are NO Cloud
// Functions on this project (Spark, no-functions contract 2026-11-26):
// orders are created by ONE client transaction (runTransaction) that
// reserves stock and writes the order; the movements + audit entry
// are written AFTER the commit, best-effort (M1: Option 3 +
// audit-split, 2026-11-27) — an order whose audit entry never
// landed is recovered by the orphan repair. Order-status
// transitions move stock in a transaction too. The ERP sections (sales, purchases, returns,
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
//   the rules, so the app can never silently skip the audit. The
//   order-create path is the one exception: its audit entry is
//   written post-commit, best-effort (see writeOrderPostCommit),
//   and the orphan repair recovers a missing one.
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
  // correctly (firestore.rules sensitiveValuesOk). Pricing adds
  // basePrice, deliveryFee, saleSavings and amountDue (spec NFR).
  var SENSITIVE_FIELDS = ['price', 'basePrice', 'stock', 'reserved', 'status', 'paymentStatus', 'inStock', 'deliveryFee', 'saleSavings', 'amountDue'];

  // ---- Template registry (mirrors lib/services/templates_service.dart) ----
  var TEMPLATE_TOKEN_KEYS = ['bg', 'bg2', 'surface', 'surfaceStrong', 'border', 'text', 'textSoft', 'accent', 'accent2', 'warm', 'radius'];
  var TEMPLATE_SECTION_KEYS = ['hero', 'promos', 'featured', 'delivery', 'contact'];
  var TEMPLATE_STATUSES = ['draft', 'active', 'archived'];

  // ---- Template bundles (store-templates spec, entries 16–17) ----
  // The bundle gateway mirrors the entry-3 check list. The allow-lists
  // below are copied verbatim from storefront/templates/gateway-rules.json
  // (the single source of truth, version 1) — if that JSON changes,
  // these change with it; the parity tests (entry 21) catch drift.
  var SHELL_VERSION = '1.0.0';
  var BUNDLE_VERSION = '1.0.0';
  var BUNDLE_GATEWAY_RULES_VERSION = 1;
  var BUNDLE_TIMEOUT_MS = 10000;
  var BUNDLE_MOTION_MAX_MS = 1500;
  var STOREFRONT_BASE_URL = 'https://store-3384c.web.app';
  var TEMPLATE_IDS = ['bazaar', 'gallery', 'scroll', 'speclab', 'boutique', 'classic'];
  // Canonical lifecycle (spec entry 10): six states only. The v1
  // statuses above stay for the v1 registry docs until the classic
  // bundle lands (entry 7).
  var TEMPLATE_STATUSES_BUNDLE = ['draft', 'preview', 'approved', 'active', 'retired'];
  // Locked display strings (spec + build contract): Arabic name,
  // English gloss, one-sentence identity per template.
  var TEMPLATE_IDENTITY = {
    bazaar: { nameAr: 'بازار', nameEn: 'Deal Bazaar', identity: 'سوق عروض صاخب — السعر أكبر حاجة في الكارت.' },
    gallery: { nameAr: 'معرض', nameEn: 'White Gallery', identity: 'معرض أبيض هادي — صور كبيرة وكلام قليل.' },
    scroll: { nameAr: 'اسكرول', nameEn: 'Scroll', identity: 'فيد منتجات بملء الشاشة — منتج واحد في كل شاشة.' },
    speclab: { nameAr: 'قارن', nameEn: 'Spec Lab', identity: 'مقارنة مواصفات كثيفة — المعلومة أولاً.' },
    boutique: { nameAr: 'الدكان', nameEn: 'Warm Boutique', identity: 'دكان دافي — ألوان كريمي وكلام ودود.' },
    classic: { nameAr: 'الكلاسيكي', nameEn: 'Classic', identity: 'تصميم المتجر الحالي كما هو — قالب الرجوع الآمن.' }
  };
  var BUNDLE_ALLOWED_TAGS = ['section', 'div', 'span', 'h1', 'h2', 'h3', 'p', 'a', 'img', 'button', 'ul', 'li'];
  var BUNDLE_ALLOWED_ATTRIBUTES = ['data-slot', 'data-action', 'data-section', 'href', 'src', 'alt', 'class'];
  var BUNDLE_ALLOWED_SLOTS = ['product-name', 'product-price', 'product-old-price', 'product-image', 'product-card', 'category-name', 'category-image', 'featured-spot', 'promo-banner', 'delivery-fee', 'brand-name', 'brand-logo', 'brand-tagline', 'whatsapp-number', 'cod-message', 'max-discount-pct'];
  var BUNDLE_ALLOWED_ACTIONS = ['add-to-cart', 'open-cart', 'open-product', 'select-category', 'search', 'toggle-grid-list', 'toggle-compare', 'filter-chip'];
  var BUNDLE_BEHAVIOURS = ['countdown-strip', 'feed', 'grid-list-toggle', 'filter-chips', 'comparison-strip', 'hero-crossfade'];
  var BUNDLE_SECTION_FILES = ['hero', 'marquee', 'categories', 'featured', 'offers', 'products', 'delivery', 'contact', 'about'];
  var BUNDLE_REQUIRED_SECTIONS = ['products', 'delivery', 'contact'];
  var BUNDLE_CART_LAYOUTS = ['drawer', 'bottom-sheet'];
  var BUNDLE_MODAL_LAYOUTS = ['default', 'sheet'];
  var BUNDLE_DATA_NEEDS = ['oldPrice', 'specs', 'deliveryFee'];
  var BUNDLE_FONT_ORIGINS = ['self', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'];
  var BUNDLE_IMAGE_ORIGINS = ['self', 'https://res.cloudinary.com'];
  var BUNDLE_FORBIDDEN_SELECTORS = ['#cartDrawer', '#modal', '#journey', '#checkoutBtn', '#cartBtn', '.toast'];
  var BUNDLE_TOKEN_KEYS = ['bg', 'bg2', 'surface', 'surfaceStrong', 'border', 'text', 'textSoft', 'accent', 'accent2', 'warm', 'radius', 'font'];

  // Canonical bundle hash of the classic wrap
  // (storefront/templates/classic/1.0.0/manifest.json). The classic
  // seed below carries it so the seeded registry doc is a valid
  // six-field bundle doc; if the frozen classic bundle ever changes,
  // its manifest hash changes and this constant must follow.
  var CLASSIC_BUNDLE_HASH =
    'cfafbac1d0d584ca388073c18ac8bf8094367f3d1e128b4855df8caaa44137af';

  // The launch template: the current live site, preserved as-is.
  // Six-field bundle shape (spec §2 line 276; the rules'
  // templateShapeOk + validateRegistryManifest): the v1-shaped seed
  // (name / schemaVersion / int version / grid / tokens / sections /
  // bodyPath) is denied by the strict bundle-shape check, so a
  // missing classic doc could never be re-seeded and
  // rollback-to-classic failed. Mirrors the Dart
  // _ensureClassicTemplateDoc seed in
  // lib/services/templates_service.dart — same fields, same hash,
  // same absolute preview URL (the registry check requires an
  // http(s) preview URL; the manifest itself carries the relative
  // '/templates/classic/1.0.0/preview.png').
  var CLASSIC_TEMPLATE = {
    id: 'classic',
    nameAr: 'الكلاسيكي',
    nameEn: 'Classic',
    version: '1.0.0',
    shellMinVersion: '1.0.0',
    bundleHash: CLASSIC_BUNDLE_HASH,
    status: 'active',
    previewImageUrl: 'https://store-3384c.web.app/templates/classic/1.0.0/preview.png'
  };

  function isAllowedOrderTransition(from, to) {
    if (from === to) return true;
    return (ORDER_TRANSITIONS[from] || []).indexOf(to) !== -1;
  }

  // Normalizes an Egyptian phone to the sign-in lookup form: 12 digits
  // starting with '20' (e.g. 01557887719 -> 201557887719). Same rule as
  // the mobile app's lib/core/identifier.dart. Returns null when the
  // input is not a plausible Egyptian mobile number. Pure (module scope)
  // so the factory export and the tests can use it.
  function normalizeEgyptPhone(raw) {
    var digits = String(raw || '').replace(/[\s\-()]/g, '');
    if (digits.charAt(0) === '+') digits = digits.slice(1);
    if (digits.indexOf('00') === 0) digits = digits.slice(2);
    if (digits.length === 11 && digits.indexOf('01') === 0) return '20' + digits.slice(1);
    if (digits.length === 12 && digits.indexOf('20') === 0) return digits;
    if (digits.length === 10 && digits.charAt(0) === '1') return '20' + digits;
    return null;
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

  // ---- Incomplete orders + journey tracking (2026-11-27) ----
  // Pure helpers shared by the PC admin, the Flutter admin and the
  // storefront (same rule, three clients). Canonical schemas:
  // store docs/incomplete-orders-schema.md (the store repo).

  var GOVERNORATES_27 = [
    { id: 'cairo', name: 'القاهرة' }, { id: 'giza', name: 'الجيزة' },
    { id: 'alexandria', name: 'الإسكندرية' }, { id: 'dakahlia', name: 'الدقهلية' },
    { id: 'red-sea', name: 'البحر الأحمر' }, { id: 'beheira', name: 'البحيرة' },
    { id: 'fayoum', name: 'الفيوم' }, { id: 'gharbia', name: 'الغربية' },
    { id: 'ismailia', name: 'الإسماعيلية' }, { id: 'menofia', name: 'المنوفية' },
    { id: 'minya', name: 'المنيا' }, { id: 'qalyubia', name: 'القليوبية' },
    { id: 'new-valley', name: 'الوادي الجديد' }, { id: 'suez', name: 'السويس' },
    { id: 'asyut', name: 'أسيوط' }, { id: 'sohag', name: 'سوهاج' },
    { id: 'qena', name: 'قنا' }, { id: 'luxor', name: 'الأقصر' },
    { id: 'aswan', name: 'أسوان' }, { id: 'sharqia', name: 'الشرقية' },
    { id: 'port-said', name: 'بورسعيد' }, { id: 'damietta', name: 'دمياط' },
    { id: 'kafr-el-sheikh', name: 'كفر الشيخ' }, { id: 'beni-suef', name: 'بني سويف' },
    { id: 'matrouh', name: 'مطروح' }, { id: 'north-sinai', name: 'شمال سيناء' },
    { id: 'south-sinai', name: 'جنوب سيناء' }
  ];

  // Digits only; a leading +20 / 20 country code folds back to the
  // local 01… form, so pasted international numbers validate.
  function normalizeEgyptianMobile(phone) {
    var digits = String(phone || '').replace(/\D/g, '');
    if (digits.length === 12 && digits.indexOf('20') === 0) return '0' + digits.slice(2);
    return digits;
  }
  function isValidEgyptianMobile(phone) {
    return /^01[0125][0-9]{8}$/.test(normalizeEgyptianMobile(phone));
  }

  // Visible seconds -> stored dwell band token (ASCII). 9s -> '<10s';
  // 10s and 60s -> '10-60s'; 61s -> '>60s'. Hidden-tab time is never
  // passed in (the storefront excludes it).
  function dwellBand(visibleSeconds) {
    var s = Number(visibleSeconds) || 0;
    if (s < 10) return '<10s';
    if (s <= 60) return '10-60s';
    return '>60s';
  }

  // One cart line's availability from live inventory: available is
  // (stock - reserved). ok: qty fits; out: nothing available; short:
  // some available, less than qty.
  function lineAvailability(availableQty, qty) {
    var avail = Math.max(0, Math.floor(Number(availableQty) || 0));
    var q = Math.max(0, Math.floor(Number(qty) || 0));
    if (avail <= 0) return { state: 'out', availableQty: 0 };
    if (q <= avail) return { state: 'ok', availableQty: avail };
    return { state: 'short', availableQty: avail };
  }

  // Draft completeness 0–100: 25 points each for name, a valid phone,
  // a non-empty cart, and an address (governorate + detailed, or the
  // combined field).
  function draftTriageScore(parts) {
    var p = parts || {};
    var score = 0;
    if (p.name) score += 25;
    if (p.phone) score += 25;
    if (p.cart) score += 25;
    if (p.address) score += 25;
    return score;
  }

  // The draft state machine. Terminal states (converted, dead) have
  // no outgoing transition.
  var DRAFT_TRANSITIONS = {
    'new': ['contacted', 'no-answer', 'converted', 'dead'],
    'contacted': ['no-answer', 'converted', 'dead'],
    'no-answer': ['contacted', 'converted', 'dead'],
    'converted': [],
    'dead': []
  };
  function draftCanTransition(from, to) {
    return (DRAFT_TRANSITIONS[from] || []).indexOf(to) !== -1;
  }

  // A draft is a callable lead only when it clears the triage
  // minimum: a name, a non-empty cart, and a full valid Egyptian
  // mobile. Address is NOT part of the minimum (it scores 25 points
  // in draftTriageScore but a draft without it still lists) — and it
  // must never substitute for a missing name or an empty cart: the
  // score-based check (>= 75 of name/phone/cart/address) let
  // name+phone+address with an empty cart, and phone+cart+address
  // with no name, through. Explicit three-way AND instead.
  function draftIsCallable(d) {
    if (!d) return false;
    return !!(d.name || '').trim()
      && (d.cart || []).length > 0
      && isValidEgyptianMobile(d.phone || '');
  }

  // Governorate list resolution: a missing/unreadable document falls
  // back to the full hardcoded 27 so checkout never breaks; a
  // document with zero active entries is the "not set up" state, not
  // an empty dropdown.
  function governorateFallback(docData) {
    var entries = docData && Array.isArray(docData.entries) ? docData.entries : null;
    if (!entries) {
      return {
        entries: GOVERNORATES_27.map(function (g) { return { id: g.id, name: g.name }; }),
        fromFallback: true, notSetUp: false
      };
    }
    var active = entries
      .filter(function (e) { return e && e.active === true && typeof e.id === 'string' && e.id && typeof e.name === 'string' && e.name; })
      .map(function (e) { return { id: e.id, name: e.name }; });
    if (active.length === 0) return { entries: [], fromFallback: false, notSetUp: true };
    return { entries: active, fromFallback: false, notSetUp: false };
  }

  // Dedupe drafts by phone (newest first wins): a visitor on two
  // devices is two drafts, but the admin list shows one row per
  // phone. Drafts with no phone are kept as-is.
  function dedupDraftsByPhone(drafts) {
    var seen = {};
    var out = [];
    (drafts || []).forEach(function (d) {
      var phone = (d && d.phone) || '';
      var key = normalizeEgyptianMobile(phone);
      if (!key) { out.push(d); return; }
      if (!seen[key]) { seen[key] = true; out.push(d); }
    });
    return out;
  }

  // Journey summaries carry schemaVersion 1 on every event.
  var JOURNEY_SCHEMA_VERSION = 1;

  // Cap a journey product list at 20 entries (oldest kept — the
  // first 20 win) and count the overflow.
  function capJourneyEntries(entries) {
    var list = entries || [];
    if (list.length <= 20) return { entries: list, overflowCount: 0 };
    return { entries: list.slice(0, 20), overflowCount: list.length - 20 };
  }

  // Human label for a journey action. Unknown action types render
  // as plain text (the schema is append-only — new actions must
  // never break the admin view).
  function journeyActionLabel(action) {
    if (action === 'view') return 'شاف المنتج';
    if (action === 'add') return 'ضاف للسلة';
    if (action === 'checkout_start') return 'بدأ الطلب';
    return action;
  }

  // ---- Pricing (Technical Plan §8) — ONE canonical helper per
  // client, mirroring the storefront `computePricing` exactly (same
  // fields, same rounding, same matrix totals). All money is
  // integer EGP; all savings are exact integer sums, never rounded.
  // `roundHalfUp` is nearest integer, halves up, identically for
  // the displayed %.
  function roundHalfUp(x) { return Math.floor(x + 0.5); }

  function isOnSale(p) {
    return !!p && p.basePrice != null && Number(p.basePrice) > Number(p.price);
  }

  // Rounded display % for one product, or null when there is no
  // sale or when the badge must be suppressed (rounded % x base !=
  // saving, §8/N3 — base 199 → 149 returns null, never 25).
  function salePercent(p) {
    if (!isOnSale(p)) return null;
    var base = Number(p.basePrice);
    var saving = base - Number(p.price);
    var pct = roundHalfUp((saving * 100) / base);
    if (pct * base !== saving * 100) return null;
    return pct;
  }

  // Totals from DATABASE prices (never a client-supplied total).
  // lines: [{ price, basePrice (int|null), qty }].
  // opts: { deliveryFee (int|null — null means the settings doc has
  //   no fee field: unset = free, treated as 0, decision 2026-11-27),
  //   freeDeliveryThreshold
  //   (int|null — admin setting, decision D3: int > 0 waives the fee
  //   once the post-sale total reaches it; absent/null/0 = no waiver) }.
  // Returns every figure the storefront, review, transaction and
  // WhatsApp quote share — one computation, no divergent copies.
  function computeOrderTotals(lines, opts) {
    var o = opts || {};
    var baseSubtotal = 0;
    var subtotal = 0;
    var saleSavings = 0;
    var perLine = [];
    (lines || []).forEach(function (l) {
      var price = Number(l.price) || 0;
      var qty = Number(l.qty) || 0;
      var base = (l.basePrice != null && Number(l.basePrice) > price) ? Number(l.basePrice) : null;
      var lineSaving = base != null ? (base - price) * qty : 0;
      baseSubtotal += (base != null ? base : price) * qty;
      subtotal += price * qty;
      saleSavings += lineSaving;
      perLine.push({ saving: lineSaving, pct: base != null ? salePercent({ price: price, basePrice: base }) : null });
    });
    var total = subtotal;
    var feeUnset = !(Number.isInteger(o.deliveryFee) && o.deliveryFee >= 0);
    var threshold = (Number.isInteger(o.freeDeliveryThreshold) && o.freeDeliveryThreshold > 0)
      ? o.freeDeliveryThreshold : null;
    var feeWaived = !feeUnset && threshold != null && total >= threshold;
    // Unset fee = free (decision 2026-11-27): a missing fee is 0,
    // exactly like an explicit 0. The threshold waiver only applies
    // when a fee IS set.
    var deliveryFee = feeUnset ? 0 : (feeWaived ? 0 : o.deliveryFee);
    var amountDue = total + deliveryFee;
    return {
      perLine: perLine,
      baseSubtotal: baseSubtotal,
      subtotal: subtotal,
      saleSavings: saleSavings,
      total: total,
      deliveryFee: deliveryFee,
      feeUnset: feeUnset,
      feeWaived: feeWaived,
      amountDue: amountDue,
      savingTotal: saleSavings,
      insteadOf: baseSubtotal + deliveryFee
    };
  }

  // Dashboard pricing counters (Technical Plan §11, entry 8) —
  // computed from existing docs, no new writes. Order counters come
  // from order docs (cash collected is Σ amountDue, never Σ total);
  // rejection counters come from attempt docs, not order docs.
  function computePricingCounters(orders, attempts) {
    var list = orders || [];
    var saleOrders = list.filter(function (o) { return (o.saleSavings || 0) > 0; });
    var totalSaleSavings = list.reduce(function (a, o) { return a + (o.saleSavings || 0); }, 0);
    var totalFeeCollected = list.reduce(function (a, o) { return a + (o.deliveryFee || 0); }, 0);
    var cashCollected = list.reduce(function (a, o) { return a + (o.amountDue != null ? o.amountDue : (o.total || 0)); }, 0);
    var att = attempts || [];
    var failed = att.filter(function (a) { return !!a.errorCode; });
    var priceChange = att.filter(function (a) { return a.errorCode === 'PRICE_CHANGED' || a.errorCode === 'FEE_CHANGED'; });
    var byCode = {};
    failed.forEach(function (a) { byCode[a.errorCode] = (byCode[a.errorCode] || 0) + 1; });
    return {
      totalOrders: list.length,
      saleOrders: saleOrders.length,
      saleOrderShare: list.length ? Math.round((saleOrders.length / list.length) * 100) : 0,
      totalSaleSavings: totalSaleSavings,
      totalFeeCollected: totalFeeCollected,
      cashCollected: cashCollected,
      attempts: att.length,
      failedAttempts: failed.length,
      priceChangeRejections: priceChange.length,
      rejectionRate: att.length ? Math.round((priceChange.length / att.length) * 100) : 0,
      failuresByCode: byCode
    };
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

  // ---- Bundle gateway (pure, entry 16) ----
  // Mirrors the entry-3 check list (storefront/bundle-gateway.js) and
  // the Flutter entry-11 gateway: same report shape
  // {passed, failedChecks} plus a warnings list (RTL physical
  // positioning is a warning, never a failure — spec check 8). Every
  // failure is named; a failed bundle can never be previewed as live
  // or activated. The shell fast check is a SUBSET of this list (it
  // skips the approval-freeze check, which needs admin context).

  function _utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') {
      var enc = new TextEncoder().encode(str);
      var out = [];
      for (var i = 0; i < enc.length; i++) out.push(enc[i]);
      return out;
    }
    // Manual UTF-8 fallback (Electron + node both have TextEncoder;
    // this path is only for old runtimes).
    var bytes = [];
    for (var j = 0; j < str.length; j++) {
      var c = str.charCodeAt(j);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c >= 0xd800 && c < 0xdc00) {
        var c2 = str.charCodeAt(++j);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return bytes;
  }

  // Synchronous SHA-256 (no dependency — works in the Electron
  // renderer and in node --test alike). Hex digest.
  function sha256Hex(input) {
    var K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    function rotr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }
    var bytes = _utf8Bytes(String(input));
    var bitLen = bytes.length * 8;
    bytes.push(0x80);
    while ((bytes.length % 64) !== 56) bytes.push(0);
    var hi = Math.floor(bitLen / 0x100000000), lo = bitLen >>> 0;
    bytes.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
      (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);
    var w = new Array(64);
    for (var off = 0; off < bytes.length; off += 64) {
      var i;
      for (i = 0; i < 16; i++) {
        w[i] = ((bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) | (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3]) >>> 0;
      }
      for (i = 16; i < 64; i++) {
        var s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
        var s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
        var ch = ((e & f) ^ (~e & g)) >>> 0;
        var t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        var S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
        var maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        var t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    var out = '';
    for (i = 0; i < 8; i++) out += ('00000000' + H[i].toString(16)).slice(-8);
    return out;
  }

  function _sortedJson(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(_sortedJson).join(',') + ']';
    var keys = Object.keys(value).sort();
    return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + _sortedJson(value[k]); }).join(',') + '}';
  }

  // The manifest as hashed: its own bundleHash field removed, keys
  // sorted recursively, no whitespace. gateway-rules.json pins the
  // file set but not the serialisation — this canonical form is the
  // PC gateway's choice, and the shell gateway (entry 3) must use
  // the same one or the two hashes will disagree.
  function canonicalManifestJson(manifest) {
    var m = {};
    Object.keys(manifest || {}).forEach(function (k) { if (k !== 'bundleHash') m[k] = manifest[k]; });
    return _sortedJson(m);
  }

  // SHA-256 over the canonical file set (gateway-rules.json bundleHash):
  // manifest.json (excluding its own bundleHash field) + every file in
  // sections/ + styles.css + tokens.json, lexicographic path order,
  // each file's bytes concatenated. preview.png is EXCLUDED. The
  // classic wrap's index.html + classic.json ride along when present
  // (same canonical rule — the Dart gateway hashes the wrap's own
  // file set). Canonical serialisation (decision 1): manifest.json
  // AND tokens.json are parsed and re-serialised with sorted keys
  // and no whitespace; sections/*.html, styles.css and the wrap
  // files are raw bytes. Returns the hex digest, or null when a
  // fixed canonical file is missing or the manifest does not parse
  // (the missing file is reported by its own check instead). `files`
  // maps path → raw text content; the manifest entry may also be the
  // parsed object.
  function computeBundleHash(files) {
    var f = files || {};
    if (f['manifest.json'] == null || f['styles.css'] == null || f['tokens.json'] == null) return null;
    if (typeof f['styles.css'] !== 'string' || typeof f['tokens.json'] !== 'string') return null;
    var paths = ['manifest.json', 'styles.css', 'tokens.json'];
    Object.keys(f).forEach(function (p) {
      if (p.indexOf('sections/') === 0) paths.push(p);
      if (p === 'index.html' || p === 'classic.json') paths.push(p);
    });
    paths.sort();
    var parts = [];
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i];
      if (p === 'manifest.json') {
        if (typeof f[p] === 'string') {
          var parsed;
          try { parsed = JSON.parse(f[p]); } catch (e) { return null; }
          parts.push(canonicalManifestJson(parsed));
        } else if (typeof f[p] === 'object') {
          parts.push(canonicalManifestJson(f[p]));
        } else return null;
      } else if (p === 'tokens.json') {
        // Canonical tokens string, like the manifest (decision 1):
        // the hosted tokens.json may be pretty-printed or compact,
        // the hash must not depend on that. An unparsable tokens
        // file falls back to its raw bytes here; the tokens check
        // itself fails the bundle separately.
        if (typeof f[p] !== 'string') return null;
        var tokensParsed;
        try { tokensParsed = JSON.parse(f[p]); } catch (e) { tokensParsed = null; }
        parts.push(tokensParsed == null ? f[p] : _sortedJson(tokensParsed));
      } else {
        if (typeof f[p] !== 'string') return null;
        parts.push(f[p]);
      }
    }
    return sha256Hex(parts.join(''));
  }

  function _parseSemver(v) {
    if (typeof v !== 'string') return null;
    var m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
    if (!m) return null;
    return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
  }

  function _semverLte(a, b) {
    var pa = _parseSemver(a), pb = _parseSemver(b);
    if (!pa || !pb) return false;
    for (var i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i] < pb[i]; }
    return true;
  }

  // Manifest-level checks (gateway checks 1, 2-declared, 4, 5-declared,
  // 6-contract, 7). cartLayout / modalLayout default when absent
  // (drawer / default) — the shell owns the defaults.
  function validateBundleManifest(manifest, registryId) {
    var failed = [];
    var warnings = [];
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      return { passed: false, failedChecks: ['manifest'], warnings: warnings };
    }
    var m = manifest;
    var id = m.id;
    if (typeof id !== 'string' || TEMPLATE_IDS.indexOf(id) === -1) failed.push('manifest.id');
    else if (registryId && id !== registryId) failed.push('manifest.id');
    if (typeof m.nameAr !== 'string' || !m.nameAr.trim()) failed.push('manifest.nameAr');
    if (typeof m.nameEn !== 'string' || !m.nameEn.trim()) failed.push('manifest.nameEn');
    if (m.version !== BUNDLE_VERSION) failed.push('manifest.version');
    if (!_parseSemver(m.shellMinVersion) || !_semverLte(m.shellMinVersion, SHELL_VERSION)) failed.push('manifest.shellMinVersion');
    if (typeof m.bundleHash !== 'string' || !/^[0-9a-f]{64}$/.test(m.bundleHash)) failed.push('manifest.bundleHash');
    if (m.motion !== 'calm' && m.motion !== 'lively') failed.push('manifest.motion');
    if (m.dark !== 'variant' && m.dark !== 'light-only') failed.push('manifest.dark');
    if (m.behaviours != null) {
      if (!Array.isArray(m.behaviours)) failed.push('manifest.behaviours');
      else m.behaviours.forEach(function (b) { if (BUNDLE_BEHAVIOURS.indexOf(b) === -1) failed.push('manifest.behaviours.' + b); });
    }
    if (!Array.isArray(m.sections)) {
      failed.push('manifest.sections');
    } else {
      m.sections.forEach(function (s) { if (BUNDLE_SECTION_FILES.indexOf(s) === -1) failed.push('manifest.sections.' + s); });
      BUNDLE_REQUIRED_SECTIONS.forEach(function (req) { if (m.sections.indexOf(req) === -1) failed.push('manifest.sections.' + req); });
    }
    if (m.dataNeeds != null) {
      if (!Array.isArray(m.dataNeeds)) failed.push('manifest.dataNeeds');
      else m.dataNeeds.forEach(function (d) { if (BUNDLE_DATA_NEEDS.indexOf(d) === -1) failed.push('manifest.dataNeeds.' + d); });
    }
    if (m.cartLayout != null && BUNDLE_CART_LAYOUTS.indexOf(m.cartLayout) === -1) failed.push('manifest.cartLayout');
    if (m.modalLayout != null && BUNDLE_MODAL_LAYOUTS.indexOf(m.modalLayout) === -1) failed.push('manifest.modalLayout');
    if (m.fonts != null) {
      if (!Array.isArray(m.fonts)) failed.push('manifest.fonts');
      else m.fonts.forEach(function (fn) {
        var origin = fn && fn.origin;
        if (typeof origin !== 'string' || BUNDLE_FONT_ORIGINS.indexOf(origin) === -1) failed.push('manifest.fonts.' + (fn && fn.family ? fn.family : 'unknown'));
      });
    }
    if (m.previewImageUrl != null && m.previewImageUrl !== '' && (typeof m.previewImageUrl !== 'string' || m.previewImageUrl.indexOf('http') !== 0)) failed.push('manifest.previewImageUrl');
    return { passed: failed.length === 0, failedChecks: failed, warnings: warnings };
  }

  // One section file: allow-list scan (gateway check 3) + brand slot
  // (check 2). Returns true when a data-section="brand" element was
  // found. Tags/attributes not on the allow-list reject the bundle.
  function _scanHtmlFile(content, fileLabel, failed) {
    var text = String(content).replace(/<!--[\s\S]*?-->/g, '');
    var hasBrandSlot = false;
    var tagRe = /<\/?([A-Za-z][A-Za-z0-9]*)\b([^>]*)>/g;
    var m;
    while ((m = tagRe.exec(text)) !== null) {
      var tag = m[1].toLowerCase();
      if (BUNDLE_ALLOWED_TAGS.indexOf(tag) === -1) { failed.push(fileLabel + '.tag.' + tag); continue; }
      var attrs = m[2] || '';
      var attrRe = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*("[^"]*"|'[^']*')/g;
      var am;
      while ((am = attrRe.exec(attrs)) !== null) {
        var attr = am[1].toLowerCase();
        var val = am[2].slice(1, -1);
        if (attr.indexOf('on') === 0) { failed.push(fileLabel + '.attr.' + attr); continue; }
        if (BUNDLE_ALLOWED_ATTRIBUTES.indexOf(attr) === -1) { failed.push(fileLabel + '.attr.' + attr); continue; }
        if (attr === 'data-slot' && BUNDLE_ALLOWED_SLOTS.indexOf(val) === -1) failed.push(fileLabel + '.slot.' + val);
        if (attr === 'data-action' && BUNDLE_ALLOWED_ACTIONS.indexOf(val) === -1) failed.push(fileLabel + '.action.' + val);
        if (attr === 'data-section' && val === 'brand') hasBrandSlot = true;
        if (attr === 'href' && /^\s*javascript:/i.test(val)) failed.push(fileLabel + '.href.javascript');
        if (attr === 'src') {
          if (/^\s*(javascript|data):/i.test(val)) failed.push(fileLabel + '.src.scheme');
          else if (/^https?:\/\//i.test(val) && !BUNDLE_IMAGE_ORIGINS.some(function (o) { return o !== 'self' && val.indexOf(o) === 0; })) failed.push(fileLabel + '.src.origin');
        }
      }
      if (/\son[a-z]+\s*(\/?>)/i.test(m[0])) failed.push(fileLabel + '.attr.on*');
    }
    if (/javascript:/i.test(text)) failed.push(fileLabel + '.javascript-url');
    return hasBrandSlot;
  }

  // Balanced-brace CSS walker: returns [{selector, body}] for every
  // qualified rule, descending into @media; @keyframes / @font-face
  // blocks come through with their at-rule selector and raw body.
  function _cssBlocks(css) {
    var out = [];
    function parse(text) {
      var i = 0, n = text.length;
      while (i < n) {
        while (i < n && /\s/.test(text[i])) i++;
        if (i >= n) break;
        if (text[i] === '}') { i++; return; }
        var s = i;
        while (i < n && text[i] !== '{' && text[i] !== '}') i++;
        var selector = text.slice(s, i).trim();
        if (i >= n) break;
        if (text[i] === '}') { i++; return; }
        var depth = 0, bstart = i;
        while (i < n) {
          if (text[i] === '{') depth++;
          else if (text[i] === '}') { depth--; if (depth === 0) { i++; break; } }
          i++;
        }
        var body = text.slice(bstart + 1, i - 1);
        if (/^@media/i.test(selector)) parse(body);
        else out.push({ selector: selector, body: body });
      }
    }
    parse(css);
    return out;
  }

  var _DECLARED_URL_ORIGINS = ['https://res.cloudinary.com', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

  function _urlOriginOk(u) {
    // Relative URLs are "self". Absolute URLs must name a declared origin.
    if (!/^(https?:)?\/\//i.test(u)) return true;
    return _DECLARED_URL_ORIGINS.some(function (o) { return u.indexOf(o) === 0; });
  }

  // styles.css: CSS scoping (check 9), url()/@import origins (check 3),
  // motion budget (check 4), property allow-list. RTL physical
  // positioning is a warning (check 8).
  function _scanCssFile(content, failed, warnings) {
    var clean = String(content).replace(/\/\*[\s\S]*?\*\//g, '');
    BUNDLE_FORBIDDEN_SELECTORS.forEach(function (sel) {
      if (clean.indexOf(sel) !== -1) failed.push('styles.css.selector.' + sel);
    });
    // url() / @import origins are scanned on the whole sheet: a
    // top-level @import is not inside any rule body, so the per-rule
    // scan below would never see it.
    var urlRe = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
    var um;
    while ((um = urlRe.exec(clean)) !== null) {
      if (!_urlOriginOk(um[1].trim())) failed.push('styles.css.url-origin');
    }
    var impRe = /@import\s+(?:url\(\s*['"]?([^'")]+)['"]?\s*\)|['"]([^'"]+)['"])/gi;
    var im;
    while ((im = impRe.exec(clean)) !== null) {
      var impUrl = (im[1] || im[2] || '').trim();
      if (!impUrl || !_urlOriginOk(impUrl)) failed.push('styles.css.import-origin');
    }
    var blocks = _cssBlocks(clean);
    blocks.forEach(function (rule) {
      var selector = rule.selector, body = rule.body;
      if (/^@keyframes/i.test(selector)) {
        if (/blur\(/i.test(body) || /backdrop-filter/i.test(body)) failed.push('styles.css.blur');
        if (/(^|[;{}])\s*(width|height)\s*:/i.test(body)) failed.push('styles.css.animated-property');
        var kfPropRe = /(?:^|;|{|})\s*([a-zA-Z-]+)\s*:/g;
        var km;
        while ((km = kfPropRe.exec(body)) !== null) {
          var kprop = km[1].toLowerCase();
          if (kprop !== 'transform' && kprop !== 'opacity') failed.push('styles.css.keyframe-property.' + kprop);
        }
        return;
      }
      if (/^@font-face/i.test(selector)) return;
      if (/display\s*:\s*none/i.test(body) && BUNDLE_FORBIDDEN_SELECTORS.some(function (s) { return selector.indexOf(s) !== -1; })) {
        failed.push('styles.css.display-none-transactional');
      }
      if (/blur\(/i.test(body)) failed.push('styles.css.blur');
      if (/backdrop-filter/i.test(body)) failed.push('styles.css.backdrop-filter');
      body.split(';').forEach(function (decl) {
        var colon = decl.indexOf(':');
        if (colon === -1) return;
        var prop = decl.slice(0, colon).trim().toLowerCase();
        var value = decl.slice(colon + 1);
        if (!prop || prop.charAt(0) === '@') return;
        // left/right are NOT in the CSS allow-list, but the spec's
        // check 8 names them a warning, not a failure — the spec wins
        // over the rules file here, so the RTL warning below covers
        // them instead of a property failure.
        if (prop === 'left' || prop === 'right') return;
        if (BUNDLE_ALLOWED_CSS_PROPERTIES.indexOf(prop) === -1) { failed.push('styles.css.property.' + prop); return; }
        if (prop === 'transition' || prop === 'animation' || prop === 'transition-property') {
          if (/\b(width|height|blur|backdrop-filter)\b/i.test(value)) failed.push('styles.css.animated-property');
          // Duration cap exemption (gateway-rules.json
          // motion.ambientLoopExempt, decision 7): the 1500 ms cap
          // governs entrance/transitions only — an infinite ambient
          // loop (marquee 20s, slow-zoom 10s) is exempt. The
          // animated-property check above still applies to loops.
          if (/\binfinite\b/i.test(value)) return;
          var durRe = /(\d+(?:\.\d+)?)\s*(ms|s)\b/gi;
          var dm;
          while ((dm = durRe.exec(value)) !== null) {
            var ms = dm[2] === 's' ? parseFloat(dm[1]) * 1000 : parseFloat(dm[1]);
            if (ms > BUNDLE_MOTION_MAX_MS) failed.push('styles.css.motion-duration');
          }
        }
      });
      if (/(^|[^\w-])(left|right)\s*:/i.test(body)) warnings.push('styles.css.rtl-physical');
    });
  }

  var BUNDLE_ALLOWED_CSS_PROPERTIES = ['display', 'flex', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'gap', 'align-items', 'justify-content', 'grid-template-columns', 'grid-auto-flow', 'padding', 'padding-inline-start', 'padding-inline-end', 'padding-top', 'padding-bottom', 'margin', 'margin-inline-start', 'margin-inline-end', 'margin-top', 'margin-bottom', 'border', 'border-radius', 'border-start-start-radius', 'border-start-end-radius', 'border-end-start-radius', 'border-end-end-radius', 'background', 'background-color', 'color', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align', 'text-decoration', 'opacity', 'transform', 'transition', 'animation', 'overflow', 'overflow-x', 'overflow-y', 'position', 'inset-inline-start', 'inset-inline-end', 'top', 'bottom', 'width', 'height', 'min-height', 'max-width', 'max-height', 'box-shadow', 'cursor', 'white-space', 'text-overflow', 'object-fit', 'aspect-ratio', 'z-index', 'direction', 'scroll-snap-type', 'scroll-snap-align', 'scroll-behavior'];

  function _isSafeFontValue(v) {
    var s = String(v).trim();
    if (!s) return false;
    if (s.indexOf('url(') !== -1 || s.indexOf('javascript:') !== -1 || s.indexOf(';') !== -1 || s.indexOf('<') !== -1 || s.indexOf('>') !== -1) return false;
    return /^[A-Za-z0-9\s,'"\-]+$/.test(s);
  }

  function _validateTokensJson(text, dark, failed) {
    var parsed;
    try { parsed = JSON.parse(text); } catch (e) { failed.push('tokens.json.parse'); return; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { failed.push('tokens.json'); return; }
    function checkSide(side, label) {
      var obj = parsed[side];
      if (!obj || typeof obj !== 'object') { failed.push('tokens.json.' + label); return; }
      BUNDLE_TOKEN_KEYS.forEach(function (k) {
        var v = obj[k];
        if (v === undefined) { failed.push('tokens.json.' + label + '.' + k); return; }
        if (k === 'radius') { if (typeof v !== 'string' || !_isSafeCssValue('radius', v)) failed.push('tokens.json.' + label + '.' + k); }
        else if (k === 'font') { if (typeof v !== 'string' || !_isSafeFontValue(v)) failed.push('tokens.json.' + label + '.' + k); }
        else if (typeof v !== 'string' || !_isSafeCssValue(k, v)) failed.push('tokens.json.' + label + '.' + k);
      });
    }
    checkSide('light', 'light');
    // tokens.json is REQUIRED; the dark side only when the manifest
    // declares a dark variant (D10 — light-only is allowed).
    if (dark === 'variant') checkSide('dark', 'dark');
  }

  // File-content checks (gateway checks 2, 3, 4, 5, 9). `files` maps
  // path → raw text. The manifest's dark rule decides whether dark
  // tokens are required.
  function validateBundleFiles(files, manifest) {
    var failed = [];
    var warnings = [];
    var f = files || {};
    var m = manifest || {};
    ['manifest.json', 'styles.css', 'tokens.json'].forEach(function (p) {
      if (typeof f[p] !== 'string') failed.push(p);
    });
    BUNDLE_REQUIRED_SECTIONS.forEach(function (s) {
      if (typeof f['sections/' + s + '.html'] !== 'string') failed.push('sections.' + s);
    });
    var hasBrandSlot = false;
    Object.keys(f).forEach(function (p) {
      if (p.indexOf('sections/') === 0 && p.slice(-5) === '.html' && typeof f[p] === 'string') {
        // Section FILE names are checked against the allow-list, not
        // just the manifest's section list (decision 13): a
        // sections/checkout.html file is rejected even when the
        // manifest lists it — same name the Dart gateway reports
        // (sections.unknown.<name>).
        var sectionName = p.slice('sections/'.length, -'.html'.length);
        if (BUNDLE_SECTION_FILES.indexOf(sectionName) === -1) {
          failed.push('sections.unknown.' + sectionName);
        }
        if (_scanHtmlFile(f[p], p, failed)) hasBrandSlot = true;
      }
    });
    if (!hasBrandSlot) failed.push('brandSlot');
    if (typeof f['styles.css'] === 'string') _scanCssFile(f['styles.css'], failed, warnings);
    if (typeof f['tokens.json'] === 'string') _validateTokensJson(f['tokens.json'], m.dark, failed);
    return { passed: failed.length === 0, failedChecks: failed, warnings: warnings };
  }

  // Full bundle gateway: manifest checks + (when files are supplied)
  // content checks + the bundle-hash recomputation. With files == null
  // only the manifest-level checks run — the report says so in
  // warnings ('files-not-checked').
  function validateTemplateBundle(manifest, files, registryId) {
    var rep = validateBundleManifest(manifest, registryId);
    var failed = rep.failedChecks.slice();
    var warnings = rep.warnings.slice();
    if (files == null) {
      warnings.push('files-not-checked');
    } else {
      var frep = validateBundleFiles(files, manifest);
      failed = failed.concat(frep.failedChecks);
      warnings = warnings.concat(frep.warnings);
      var hash = computeBundleHash(files);
      if (hash !== null && manifest && typeof manifest.bundleHash === 'string' && hash !== manifest.bundleHash) {
        failed.push('manifest.bundleHash');
      }
    }
    var seen = {};
    var unique = failed.filter(function (c) { if (seen[c]) return false; seen[c] = true; return true; });
    var wseen = {};
    var uwarnings = warnings.filter(function (w) { if (wseen[w]) return false; wseen[w] = true; return true; });
    return { passed: unique.length === 0, failedChecks: unique, warnings: uwarnings };
  }

  // A registry doc is a bundle doc when it carries bundle fields, or
  // when its status is a bundle-only state on a doc that is not
  // v1-shaped (v1 docs carry schemaVersion / grid / bodyPath).
  function isBundleDoc(doc) {
    var d = doc || {};
    if (d.bundleHash != null || d.shellMinVersion != null) return true;
    if (typeof d.status === 'string' && TEMPLATE_STATUSES_BUNDLE.indexOf(d.status) !== -1
      && d.schemaVersion == null && d.grid == null && d.bodyPath == null) return true;
    return false;
  }

  // The manifest copy out of a registry doc (the doc IS the manifest
  // copy + status + approval record).
  function manifestFromRegistryDoc(doc) {
    var d = doc || {};
    return {
      id: d.id, nameAr: d.nameAr, nameEn: d.nameEn, version: d.version,
      shellMinVersion: d.shellMinVersion, bundleHash: d.bundleHash,
      motion: d.motion, dark: d.dark, behaviours: d.behaviours,
      sections: d.sections, dataNeeds: d.dataNeeds,
      cartLayout: d.cartLayout, modalLayout: d.modalLayout,
      fonts: d.fonts, previewImageUrl: d.previewImageUrl || d.thumbnailUrl
    };
  }

  // Registry-shape (A, decision 2): validates a REGISTRY doc with
  // the bundle-rules-only six-field check — id, nameAr, nameEn,
  // version, shellMinVersion, bundleHash (+ status) — mirroring
  // validateTemplateDoc's bundle branch in Flutter. The
  // full-manifest validator (validateBundleManifest) NEVER runs on
  // registry data: a spec-shaped doc carries no motion / dark /
  // sections, and requiring them here rejects every real bundle
  // before the approval / status checks ever run. Extra fields on
  // the doc (a full-manifest copy) are tolerated — only the six
  // fields are checked.
  function validateRegistryManifest(doc, registryId) {
    var failed = [];
    var d = doc || {};
    var id = d.id;
    if (typeof id !== 'string' || TEMPLATE_IDS.indexOf(id) === -1) failed.push('manifest.id');
    else if (registryId && id !== registryId) failed.push('manifest.id');
    if (typeof d.nameAr !== 'string' || !d.nameAr.trim()) failed.push('manifest.nameAr');
    if (typeof d.nameEn !== 'string' || !d.nameEn.trim()) failed.push('manifest.nameEn');
    if (typeof d.version !== 'string' || !_parseSemver(d.version)) failed.push('manifest.version');
    if (typeof d.shellMinVersion !== 'string' || !_parseSemver(d.shellMinVersion)) failed.push('manifest.shellMinVersion');
    else if (!_semverLte(d.shellMinVersion, SHELL_VERSION)) failed.push('manifest.shellMinVersion');
    if (typeof d.bundleHash !== 'string' || !/^[0-9a-f]{64}$/.test(d.bundleHash)) failed.push('manifest.bundleHash');
    var status = d.status;
    if (typeof status !== 'string' || (TEMPLATE_STATUSES_BUNDLE.indexOf(status) === -1 && status !== 'archived')) failed.push('manifest.status');
    var preview = d.previewImageUrl;
    if (preview != null && preview !== '' && (typeof preview !== 'string' || preview.indexOf('http') !== 0)) failed.push('manifest.previewImageUrl');
    return { passed: failed.length === 0, failedChecks: failed };
  }

  // Approval-freeze check (gateway check 5 — admin context only):
  // approval records template id + bundle hash + shell version +
  // approver + timestamp; a changed hash requires re-approval.
  function checkApprovalFreeze(doc) {
    var d = doc || {};
    var ap = d.approval;
    if (!ap || typeof ap !== 'object') return { ok: false, reason: 'مفيش سجل اعتماد للقالب ده — لازم اعتماد محمد الأول' };
    if (ap.bundleHash !== d.bundleHash) return { ok: false, reason: 'القالب اتغير بعد الاعتماد (الهاش مختلف) — لازم اعتماد جديد' };
    if (ap.shellVersion !== SHELL_VERSION) return { ok: false, reason: 'القالب اعتُمد على إصدار شل مختلف — لازم اعتماد جديد' };
    return { ok: true, reason: '' };
  }

  // ---- Pointer history stack (pure, spec B5) ----
  // The pointer keeps previousTemplateId ONLY as a display convenience;
  // rollback restores the second-last entry of `history`. Rolling back
  // twice walks the stack backwards one step at a time.
  function pointerHistoryAppend(pointer, entry) {
    var h = ((pointer || {}).history && Array.isArray(pointer.history)) ? pointer.history.slice() : [];
    h.push(entry);
    return h;
  }

  function rollbackTargetFromHistory(pointer) {
    var h = ((pointer || {}).history && Array.isArray(pointer.history)) ? pointer.history : [];
    if (h.length < 2) return null;
    return h[h.length - 2];
  }

  // Classic pin: classic can never be archived or deleted while it is
  // the rollback target. With the append-only history it stays in the
  // stack once it was ever live; with no history at all it is the
  // default rollback target (the built-in fallback).
  function isRollbackTarget(templateId, pointer) {
    var p = pointer || {};
    if (p.templateId === templateId) return true;
    if (p.previousTemplateId === templateId) return true;
    var h = Array.isArray(p.history) ? p.history : [];
    for (var i = 0; i < h.length; i++) { if (h[i] && h[i].templateId === templateId) return true; }
    if (templateId === 'classic' && h.length === 0) return true;
    return false;
  }

  // ---- D2: promoBanners[].endDate (pure) ----
  // ISO 8601 date-time, Africa/Cairo, set per promotion. The admin
  // types a wall-clock time (datetime-local); it is stored with the
  // Cairo UTC offset that applied on that date (+02:00 winter,
  // +03:00 summer DST). The countdown itself never uses the device
  // clock — the shell pins it to serverTimestamp-derived time.
  function cairoOffsetMinutesAt(date) {
    try {
      var fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Cairo', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      var parts = fmt.formatToParts(date);
      var get = function (t) { for (var i = 0; i < parts.length; i++) if (parts[i].type === t) return parts[i].value; return '0'; };
      var asUTC = Date.UTC(parseInt(get('year'), 10), parseInt(get('month'), 10) - 1, parseInt(get('day'), 10), parseInt(get('hour'), 10), parseInt(get('minute'), 10), parseInt(get('second'), 10));
      return Math.round((asUTC - date.getTime()) / 60000);
    } catch (e) { return 120; }
  }

  function cairoOffsetStringAt(date) {
    var off = cairoOffsetMinutesAt(date);
    var sign = off < 0 ? '-' : '+';
    var abs = Math.abs(off);
    return sign + ('0' + Math.floor(abs / 60)).slice(-2) + ':' + ('0' + (abs % 60)).slice(-2);
  }

  // 'YYYY-MM-DDTHH:mm' (or with seconds) as Cairo wall time → ISO 8601
  // with the Cairo offset. Returns null for an unparseable value.
  function promoEndDateToISO(localValue) {
    if (typeof localValue !== 'string') return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(localValue.trim());
    if (!m) return null;
    var y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
    var h = parseInt(m[4], 10), mi = parseInt(m[5], 10), s = m[6] ? parseInt(m[6], 10) : 0;
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
    var guess = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
    if (guess.getUTCDate() !== d || guess.getUTCMonth() !== mo - 1) return null;
    var off = cairoOffsetMinutesAt(guess);
    var instant = new Date(guess.getTime() - off * 60000);
    var off2 = cairoOffsetMinutesAt(instant);
    if (off2 !== off) { instant = new Date(guess.getTime() - off2 * 60000); off = off2; }
    var p2 = function (n) { return ('0' + n).slice(-2); };
    return y + '-' + p2(mo) + '-' + p2(d) + 'T' + p2(h) + ':' + p2(mi) + ':' + p2(s) + cairoOffsetStringAt(instant);
  }

  // ISO 8601 (with offset) → 'YYYY-MM-DDTHH:mm' Cairo wall time for a
  // datetime-local input. Returns '' for an unparseable value.
  function isoToLocalInput(iso) {
    if (typeof iso !== 'string') return '';
    var t = Date.parse(iso);
    if (isNaN(t)) return '';
    try {
      var fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      var parts = fmt.formatToParts(new Date(t));
      var get = function (ty) { for (var i = 0; i < parts.length; i++) if (parts[i].type === ty) return parts[i].value; return ''; };
      return get('year') + '-' + get('month') + '-' + get('day') + 'T' + get('hour') + ':' + get('minute');
    } catch (e) { return ''; }
  }

  function isValidISODateTime(s) {
    if (typeof s !== 'string' || !s.trim()) return false;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)?$/.test(s.trim())) return false;
    return !isNaN(Date.parse(s));
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
      // No server-side ordering: bundle registry docs carry nameAr /
      // nameEn, not `name` — orderBy('name') would drop them from the
      // results. The UI sorts client-side by display name.
      return _subscribe(db().collection('templates'), cb);
    }

    function subscribeFeedback(cb) {
      return _subscribe(db().collection('feedback').orderBy('createdAt', 'desc').limit(100), cb);
    }

    // Team (1.1.5): the admins collection — one doc per member (doc id =
    // the Auth uid; fields email, phone, role, createdAt, plus name once
    // the account panel writes it). The rules allow list only to
    // isAdmin(); a manager login gets permission-denied on the snapshot,
    // delivered to the callback as err.
    function subscribeTeam(cb) {
      return _subscribe(db().collection('admins'), cb);
    }

    // Checkout attempts for the dashboard pricing counters
    // (Technical Plan §11): PRICE_CHANGED / FEE_CHANGED rejection
    // rate and failure rate by code come from attempt docs, not
    // order docs. Latest 200 attempts is plenty for a rate.
    function subscribeAttempts(cb) {
      return _subscribe(db().collection('analytics').doc('attempts').collection('items').orderBy('createdAt', 'desc').limit(200), cb);
    }

    // ---- Incomplete orders (2026-11-27) ----
    // Checkout drafts are LEADS, not orders: the storefront autosaves
    // them while the visitor types, and the admin converts one only
    // after the customer confirms verbally. Live list (newest sync
    // first) + a paginated one-shot read for manual refresh.

    function subscribeDrafts(cb) {
      return _subscribe(db().collection('checkoutDrafts').orderBy('lastSyncAt', 'desc').limit(100), cb);
    }

    // One page of drafts, newest sync first. Returns {docs, lastDoc}
    // (lastDoc null when there is no next page). startAfter is a
    // document snapshot from a previous page.
    function fetchDraftsPage(opts) {
      requireAdmin();
      var o = opts || {};
      var pageSize = o.pageSize || 20;
      var q = db().collection('checkoutDrafts').orderBy('lastSyncAt', 'desc').limit(pageSize);
      if (o.startAfter) q = q.startAfter(o.startAfter);
      return q.get().then(function (snap) {
        var docs = [];
        snap.forEach(function (d) {
          var data = d.data() || {};
          data.id = d.id;
          docs.push(data);
        });
        return { docs: docs, lastDoc: docs.length < pageSize ? null : snap.docs[snap.docs.length - 1] };
      });
    }

    // The journey summary for one session (doc id == session id).
    // Returns the data or null when the visitor has no journey.
    function getJourneySummary(sessionId) {
      requireAdmin();
      return db().collection('journeySummaries').doc(sessionId).get().then(function (snap) {
        return snap.exists ? (snap.data() || null) : null;
      });
    }

    // Live governorate list (one doc, all 27, stable ids + active
    // flags). The UI resolves it with governorateFallback (missing
    // doc -> full 27; zero active -> "not set up").
    function subscribeGovernorates(cb) {
      requireAdmin();
      return db().collection('storeSettings').doc('governorates').onSnapshot(function (snap) {
        cb(snap.exists ? (snap.data() || {}) : {}, null);
      }, function (err) { cb(null, err); });
    }

    // Live deletion config (autoDeleteDays, 0 = manual only).
    function subscribeDeletionConfig(cb) {
      requireAdmin();
      return db().collection('storeSettings').doc('deletion').onSnapshot(function (snap) {
        cb(snap.exists ? (snap.data() || {}) : {}, null);
      }, function (err) { cb(null, err); });
    }

    // Live quota doc (cutoffLevel + dailyEstimate).
    function subscribeQuota(cb) {
      requireAdmin();
      return db().collection('storeSettings').doc('quota').onSnapshot(function (snap) {
        cb(snap.exists ? (snap.data() || {}) : {}, null);
      }, function (err) { cb(null, err); });
    }

    // The newest real order per phone (for the list-time "already
    // ordered" badge). One `in` query per chunk of 10 phones — the
    // visible page is 20 drafts, so at most two queries. Returns
    // {phone: order-with-id}.
    function fetchOrdersByPhones(phones) {
      requireAdmin();
      var unique = [];
      (phones || []).forEach(function (p) {
        var t = String(p || '').trim();
        if (t && unique.indexOf(t) === -1) unique.push(t);
      });
      var out = {};
      var chain = Promise.resolve();
      for (var start = 0; start < unique.length; start += 10) {
        (function (chunk) {
          chain = chain.then(function () {
            return db().collection('orders').where('customerPhone', 'in', chunk).limit(50).get();
          }).then(function (snap) {
            snap.forEach(function (d) {
              var data = d.data() || {};
              var phone = data.customerPhone || '';
              var createdAt = orderDateValue(data.createdAt);
              var prev = out[phone];
              var prevAt = prev ? orderDateValue(prev.createdAt) : null;
              if (!prev || (createdAt && (!prevAt || createdAt.getTime() > prevAt.getTime()))) {
                out[phone] = Object.assign({ id: d.id }, data);
              }
            });
          });
        })(unique.slice(start, start + 10));
      }
      return chain.then(function () { return out; });
    }

    // Rough daily write estimate (drafts + journey summaries created
    // today, ~2 writes each: create + one update). Count queries
    // only, no invented visits — visits come from GA4, not Firestore.
    function dailyWriteEstimate() {
      requireAdmin();
      var now = new Date();
      var startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return Promise.all([
        db().collection('checkoutDrafts').where('createdAt', '>=', startOfDay).get(),
        db().collection('journeySummaries').where('startedAt', '>=', startOfDay).get()
      ]).then(function (snaps) {
        var draftsToday = snaps[0].docs.length;
        var journeysToday = snaps[1].docs.length;
        return {
          draftsToday: draftsToday,
          journeysToday: journeysToday,
          estimatedWrites: draftsToday * 2 + journeysToday * 2
        };
      });
    }

    function subscribeShippingCompanies(cb) {
      return _subscribe(db().collection('shippingCompanies').orderBy('name'), cb);
    }

    function subscribeInventory(cb) {
      return _subscribe(db().collection('inventory').limit(500), function (list, err) {
        if (err) { cb(null, err); return; }
        var map = {};
        (list || []).forEach(function (inv) { map[inv.id] = { stock: inv.stock || 0, reserved: inv.reserved || 0, costPrice: inv.costPrice || 0 }; });
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

    // The full pointer document (templateId + bundleVersion +
    // bundleHash + previousTemplateId + history stack) — the minimal
    // activation surface displays it, and the card UI reads the
    // activation history from it.
    function subscribeActiveTemplatePointer(cb) {
      requireAdmin();
      return db().collection('storeSettings').doc('activeTemplate').onSnapshot(function (snap) {
        cb(snap.exists ? (snap.data() || {}) : {}, null);
      }, function (err) {
        cb(null, err);
      });
    }

    function getActiveTemplatePointer() {
      requireAdmin();
      return db().collection('storeSettings').doc('activeTemplate').get().then(function (snap) {
        return (snap.exists && snap.data()) || {};
      });
    }

    // ---- No-functions order creation (contract §1) ----
    // ONE client transaction: idempotency first (the order doc id IS
    // the clientOrderId — a retry reuses it and returns the existing
    // order, created:false), then read products + inventory,
    // validate, total from DATABASE prices, reserve stock,
    // create the order, atomically. Movements + audit leave the
    // transaction — written AFTER the commit, best-effort
    // (M1: Option 3 + audit-split, 2026-11-27).
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
      var seenPrices = inp.seenPrices || null;
      var seenTotal = (inp.seenTotal == null) ? null : inp.seenTotal;
      var lines = dedupeOrderLines(inp.items || []);
      // Shape validation before any read (client-side, contract §1.3).
      if (!custName) return Promise.reject(_txError('INVALID_INPUT', 'اسم العميل مطلوب'));
      if (custPhone.length < 10) return Promise.reject(_txError('INVALID_INPUT', 'رقم موبايل العميل ناقص — لازم 10 أرقام على الأقل'));
      if (!custAddress) return Promise.reject(_txError('INVALID_INPUT', 'عنوان العميل مطلوب'));
      if (!lines.length || lines.length > 7) return Promise.reject(_txError('ORDER_TOO_LARGE', 'الطلب فيه منتجات أكتر من الحد المسموح (7)'));
      /* Cap is 7 lines (coordinator fix 2026-11-26): the rules
       * allow 10 get()/getAfter() calls per operation. The cap
       * stays at 7 — the discount-code read that used to cost an
       * extra call is gone, but the cap is NOT raised here. */
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
      var pendingPostCommit = null; // M1: movements + audit, written after the commit
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
          // The fixed delivery fee rides the settings doc (Technical
          // Plan §2/§5): missing ≠ 0 — a manual order cannot be
          // created while the fee is unset. Client-asserted on the
          // manual path (decision D2: the fee split is kept).
          var settingsRef = db().collection('storeSettings').doc('settings');
          reads.push(tx.get(settingsRef));
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
              // Pricing (Model P): the per-line base price is
              // snapshotted onto the order. Null, or equal to the
              // price, means no sale; a stored base below the price
              // is invalid data and is treated as no sale.
              var basePrice = (pData.basePrice != null && Number(pData.basePrice) > price) ? Number(pData.basePrice) : null;
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
                price: price, basePrice: basePrice, qty: lines[i].qty, stock: stock, reserved: reserved, newReserved: reserved + lines[i].qty
              });
            }
            if (seenPrices) {
              for (var sp = 0; sp < priced.length; sp++) {
                if (seenPrices[priced[sp].productId] != null && seenPrices[priced[sp].productId] !== priced[sp].price) {
                  throw _txError('PRICE_CHANGED', 'اتغير سعر منتج من اللي شفتهم — راجع الأسعار وحاول تاني', { currentPrices: currentPrices });
                }
              }
            }
            var settingsSnap = snaps[snaps.length - 1];
            var settings = settingsSnap.exists ? (settingsSnap.data() || {}) : {};
            var fee = settings.deliveryFee;
            var threshold = settings.freeDeliveryThreshold;
            // Unset fee = free (decision 2026-11-27): no FEE_NOT_SET
            // throw — computeOrderTotals treats a missing fee as 0.
            var totals = computeOrderTotals(priced, { deliveryFee: fee, freeDeliveryThreshold: threshold });
            if (seenTotal != null && Math.abs(seenTotal - totals.total) > 0.009) {
              throw _txError('TOTAL_CHANGED', 'اتغير الإجمالي — راجع الإجمالي وحاول تاني', { currentPrices: currentPrices, currentTotal: totals.total });
            }
            var auditId = newUuid();
            var opId = auditId;
            var now = serverTimestamp();
            var orderData = {
              id: clientOrderId, clientOrderId: clientOrderId,
              customerName: custName, customerPhone: custPhone, customerAddress: custAddress,
              items: priced.map(function (l) { return { productId: l.productId, name: l.name, price: l.price, basePrice: l.basePrice, qty: l.qty }; }),
              subtotal: totals.subtotal,
              total: totals.total,
              saleSavings: totals.saleSavings, deliveryFee: totals.deliveryFee, amountDue: totals.amountDue,
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
            // M1 (Option 3): movements leave the transaction — the
            // doc ids are reserved here so the post-commit batch
            // writes the exact docs the audit entry covers, but no
            // movement is written until the order commits.
            var movementDocs = [];
            priced.forEach(function (l) {
              var mvRef = db().collection('movements').doc();
              movementDocs.push({ id: mvRef.id, productId: l.productId, qty: l.qty });
              writes['movements/' + mvRef.id] = { type: 'order_reserve', qty: -l.qty };
              sensitive['movements/' + mvRef.id] = {};
            });
            writes['orders/' + clientOrderId] = { status: 'new', total: totals.total, saleSavings: totals.saleSavings, deliveryFee: totals.deliveryFee, amountDue: totals.amountDue };
            sensitive['orders/' + clientOrderId] = { status: 'new', total: totals.total, saleSavings: totals.saleSavings, deliveryFee: totals.deliveryFee, amountDue: totals.amountDue };
            // The audit entry must cover 'items' whenever any line
            // carries a base price — the log still records the full
            // order (the rules no longer CHECK coverage since the
            // audit-split, M1). Same shape as convertDraft.
            var hasBasePrice = priced.some(function (l) { return l.basePrice != null; });
            if (hasBasePrice) {
              var orderItems = priced.map(function (l) { return { productId: l.productId, name: l.name, price: l.price, basePrice: l.basePrice, qty: l.qty }; });
              writes['orders/' + clientOrderId].items = orderItems;
              sensitive['orders/' + clientOrderId].items = orderItems;
            }
            writes = primaryFirst(writes, 'orders/' + clientOrderId);
            // M1 (audit-split): the audit entry leaves the
            // transaction too — it is written post-commit (below)
            // with a fresh timestamp; the order doc is the only
            // order write left in the transaction besides the
            // reserves.
            tx.set(orderRef, orderData);
            committedLines = priced;
            createdOrder = orderData;
            pendingPostCommit = {
              lines: priced, movementDocs: movementDocs,
              orderId: clientOrderId, auditId: auditId, opId: opId,
              source: 'createManualOrder', operation: 'manual_order_create',
              actorUid: actorUid, actorName: actorName,
              writes: writes, sensitive: sensitive,
              topNewValues: { status: 'new', total: totals.total, saleSavings: totals.saleSavings, deliveryFee: totals.deliveryFee, amountDue: totals.amountDue }
            };
            return { created: true };
          });
        });
      }).then(function (res) {
        // M1 post-commit (best-effort, retry 3x, never throws):
        // movements + audit entry, ONLY for a newly created order
        // (never on an idempotent retry, never when the transaction
        // threw). The order is already committed, so a failure here
        // cannot fail the call — it is logged, and the orphan
        // repair recovers a missing audit entry.
        var chain = Promise.resolve();
        if (res.created && pendingPostCommit) {
          chain = chain.then(function () { return writeOrderPostCommit(pendingPostCommit); });
        }
        // §13 second write (best-effort, retry 3x, logged): refresh
        // products.inStock from the inventory values just written.
        // The transaction itself never writes products.inStock (that
        // would push the rules budget over 20 for 10-line orders).
        if (res.created && committedLines && committedLines.length) {
          chain = chain.then(function () { return refreshInStock(committedLines); });
        }
        return chain.then(function () {
          return { order: createdOrder, created: res.created };
        });
      });
    }

    // ---- Incomplete orders: convert a draft into a real order ----
    // ONE transaction: (1) read the draft; converted returns the
    // existing order, dead refuses; (2) moot check (same phone
    // ordered at/after the draft was created — the draft is then
    // marked moot, no order); (3) re-read products + inventory; a
    // price change or a stock shortage returns a result, never an
    // order; (4) reserve + create the order (doc id = draft id,
    // source admin_manual) + mark the draft converted. Double-tap
    // returns the existing order.
    //
    // Returns {result: 'ok' | 'PRICE_CHANGED' | 'INSUFFICIENT_STOCK'
    // | 'MOOT' | 'ALREADY_CONVERTED', order, created, mootOrderId?}.
    // Hard errors (missing draft, dead draft, unset fee, no
    // permission) reject with a coded error. The moot check runs
    // BEFORE the transaction: a transaction cannot run a query in
    // this client, so the phone lookup is a one-shot query (limit 10,
    // client-side date filter — no composite index); the transaction
    // below still re-checks the draft status, so a draft converted
    // by another admin in between returns the existing order.
    function convertDraft(input) {
      requireAdmin();
      var inp = input || {};
      var draftId = inp.draftId || inp.id || '';
      var custName = (inp.customerName || '').trim();
      var custPhone = String(inp.customerPhone || '').replace(/\D/g, '');
      var custPhone2 = (inp.customerPhone2 || '').trim() || null;
      var governorate = (inp.governorate || '').trim() || null;
      var detailedAddress = (inp.detailedAddress || '').trim() || null;
      var custAddress = (inp.customerAddress || inp.address || '').trim();
      if (!draftId) return Promise.reject(_txError('INVALID_INPUT', 'المسودة مش موجودة'));
      if (!custName) return Promise.reject(_txError('INVALID_INPUT', 'اسم العميل مطلوب'));
      if (!isValidEgyptianMobile(custPhone)) return Promise.reject(_txError('INVALID_INPUT', 'اكتب رقم موبايل صحيح (01xxxxxxxxx)'));
      if (custPhone2 && !isValidEgyptianMobile(custPhone2)) return Promise.reject(_txError('INVALID_INPUT', 'رقم الموبايل الاحتياطي مش صحيح'));
      if (!custAddress) return Promise.reject(_txError('INVALID_INPUT', 'عنوان العميل مطلوب'));
      var actorUid = state.user.uid;
      var actorName = state.user.email || '';
      var draftRef = db().collection('checkoutDrafts').doc(draftId);
      var orderRef = db().collection('orders').doc(draftId);
      // (2) Moot check, before the transaction.
      return draftRef.get().then(function (preSnap) {
        if (!preSnap.exists) throw _txError('INVALID_INPUT', 'المسودة مش موجودة');
        var pre = preSnap.data() || {};
        if ((pre.status || 'new') === 'dead') throw _txError('INVALID_INPUT', 'المسودة دي اتقفلت ومينفعش تتحول لطلب');
        var preCreatedAt = orderDateValue(pre.createdAt);
        if (!preCreatedAt) return null;
        return db().collection('orders').where('customerPhone', '==', custPhone).limit(10).get().then(function (snap) {
          var moot = null;
          snap.forEach(function (d) {
            if (moot) return;
            var data = d.data() || {};
            var createdAt = orderDateValue(data.createdAt);
            if (createdAt && createdAt.getTime() >= preCreatedAt.getTime()) {
              moot = Object.assign({ id: d.id }, data);
            }
          });
          if (!moot) return null;
          return auditedWrite({
            writes: { ['checkoutDrafts/' + draftId]: { mootOrderId: moot.id } },
            sensitive: {},
            operation: 'draft_moot'
          }).then(function () { return moot; });
        });
      }).then(function (moot) {
        if (moot) {
          return { result: 'MOOT', mootOrderId: moot.id, order: moot, created: false };
        }
        var committedLines = null;
        var createdOrder = null;
        var convertResult = null;
        var pendingPostCommit = null; // M1: movements + audit, written after the commit
        return db().runTransaction(function (tx) {
          return tx.get(draftRef).then(function (draftSnap) {
            if (!draftSnap.exists) throw _txError('INVALID_INPUT', 'المسودة مش موجودة');
            var draft = draftSnap.data() || {};
            var status = draft.status || 'new';
            if (status === 'converted') {
              return tx.get(orderRef).then(function (existingSnap) {
                if (existingSnap.exists) {
                  var existing = existingSnap.data() || {};
                  existing.id = existingSnap.id;
                  createdOrder = existing;
                  convertResult = { result: 'ALREADY_CONVERTED', order: existing, created: false };
                  return convertResult;
                }
                throw _txError('INVALID_INPUT', 'المسودة دي اتحولت قبل كده بس الطلب مش موجود');
              });
            }
            if (status === 'dead') throw _txError('INVALID_INPUT', 'المسودة دي اتقفلت ومينفعش تتحول لطلب');
            var cart = (draft.cart || []).filter(function (l) { return l && l.productId; });
            if (!cart.length) throw _txError('INVALID_INPUT', 'المسودة دي مفيهاش منتجات');
            var lines = dedupeOrderLines(cart.map(function (l) { return { productId: l.productId, qty: l.qty }; }));
            if (lines.length > 7) throw _txError('ORDER_TOO_LARGE', 'الطلب فيه منتجات أكتر من الحد المسموح (7)');
            for (var vi = 0; vi < lines.length; vi++) {
              if (!Number.isInteger(lines[vi].qty) || lines[vi].qty < 1 || lines[vi].qty > 20) {
                throw _txError('INVALID_INPUT', 'الكمية لازم تكون من 1 لـ 20 لكل صنف');
              }
            }
            var productRefs = lines.map(function (l) { return db().collection('products').doc(l.productId); });
            var invRefs = lines.map(function (l) { return db().collection('inventory').doc(l.productId); });
            var reads = productRefs.map(function (r) { return tx.get(r); })
              .concat(invRefs.map(function (r) { return tx.get(r); }));
            var settingsRef = db().collection('storeSettings').doc('settings');
            reads.push(tx.get(settingsRef));
            return Promise.all(reads).then(function (snaps) {
              var priced = [];
              for (var i = 0; i < lines.length; i++) {
                var pSnap = snaps[i];
                var invSnap = snaps[lines.length + i];
                if (!pSnap.exists) throw _txError('NOT_FOUND', 'منتج مش موجود: ' + lines[i].productId, { productId: lines[i].productId });
                var pData = pSnap.data() || {};
                var price = pData.price;
                if (typeof price !== 'number' || !isFinite(price) || price <= 0) {
                  throw _txError('PRICE_CHANGED', 'سعر المنتج ' + (pData.name || lines[i].productId) + ' مش صالح', { productId: lines[i].productId });
                }
                var basePrice = (pData.basePrice != null && Number(pData.basePrice) > price) ? Number(pData.basePrice) : null;
                var inv = invSnap.exists ? (invSnap.data() || {}) : {};
                var stock = inv.stock || 0;
                var reserved = inv.reserved || 0;
                var available = stock - reserved;
                if (lines[i].qty > available) {
                  // Stock-out returns a result, never an order.
                  convertResult = {
                    result: 'INSUFFICIENT_STOCK', productId: lines[i].productId,
                    productName: pData.name || lines[i].productId,
                    availableQty: Math.max(available, 0), created: false
                  };
                  return convertResult;
                }
                var draftLine = null;
                cart.forEach(function (l) { if (!draftLine && l.productId === lines[i].productId) draftLine = l; });
                var priceAtDraft = draftLine && draftLine.priceAtDraft != null ? Number(draftLine.priceAtDraft) : null;
                if (priceAtDraft != null && price !== priceAtDraft) {
                  // Price change returns a result, never an order.
                  convertResult = {
                    result: 'PRICE_CHANGED', productId: lines[i].productId,
                    productName: pData.name || lines[i].productId,
                    oldPrice: priceAtDraft, newPrice: price, created: false
                  };
                  return convertResult;
                }
                priced.push({
                  productId: lines[i].productId, name: pData.name || lines[i].productId,
                  price: price, basePrice: basePrice, qty: lines[i].qty,
                  stock: stock, reserved: reserved, newReserved: reserved + lines[i].qty
                });
              }
              var settingsSnap = snaps[snaps.length - 1];
              var settings = settingsSnap.exists ? (settingsSnap.data() || {}) : {};
              var fee = settings.deliveryFee;
              var threshold = settings.freeDeliveryThreshold;
              // Unset fee = free (decision 2026-11-27): no FEE_NOT_SET
              // throw — computeOrderTotals treats a missing fee as 0.
              var totals = computeOrderTotals(priced, { deliveryFee: fee, freeDeliveryThreshold: threshold });
              var auditId = newUuid();
              var opId = auditId;
              var now = serverTimestamp();
              var hasBasePrice = priced.some(function (l) { return l.basePrice != null; });
              var orderItems = priced.map(function (l) { return { productId: l.productId, name: l.name, price: l.price, basePrice: l.basePrice, qty: l.qty }; });
              var orderData = {
                id: draftId, clientOrderId: draftId,
                customerName: custName, customerPhone: custPhone, customerPhone2: custPhone2,
                governorate: governorate, detailedAddress: detailedAddress,
                customerAddress: custAddress,
                items: orderItems,
                subtotal: totals.subtotal,
                total: totals.total,
                saleSavings: totals.saleSavings, deliveryFee: totals.deliveryFee, amountDue: totals.amountDue,
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
              // M1 (Option 3): movements leave the transaction — the
              // doc ids are reserved here so the post-commit batch
              // writes the exact docs the audit entry covers, but no
              // movement is written until the order commits.
              var movementDocs = [];
              priced.forEach(function (l) {
                var mvRef = db().collection('movements').doc();
                movementDocs.push({ id: mvRef.id, productId: l.productId, qty: l.qty });
                writes['movements/' + mvRef.id] = { type: 'order_reserve', qty: -l.qty };
                sensitive['movements/' + mvRef.id] = {};
              });
              // The audit entry must cover 'items' whenever any line
              // carries a base price — the log still records the full
              // order (the rules no longer CHECK coverage since the
              // audit-split, M1). Same for the money fields.
              var orderWrite = { status: 'new', total: totals.total, saleSavings: totals.saleSavings, deliveryFee: totals.deliveryFee, amountDue: totals.amountDue };
              var orderSensitive = { status: 'new', total: totals.total, saleSavings: totals.saleSavings, deliveryFee: totals.deliveryFee, amountDue: totals.amountDue };
              if (hasBasePrice) { orderWrite.items = orderItems; orderSensitive.items = orderItems; }
              writes['orders/' + draftId] = orderWrite;
              sensitive['orders/' + draftId] = orderSensitive;
              writes = primaryFirst(writes, 'orders/' + draftId);
              // M1 (audit-split): the audit entry leaves the
              // transaction too — written post-commit (below) with a
              // fresh timestamp. The order doc + draft-converted
              // mark are the only order writes left in the
              // transaction besides the reserves.
              tx.set(orderRef, orderData);
              // Mark the draft converted (orderId = the new order id).
              tx.set(draftRef, { status: 'converted', orderId: draftId, operationId: opId, updatedAt: now }, { merge: true });
              committedLines = priced;
              createdOrder = orderData;
              pendingPostCommit = {
                lines: priced, movementDocs: movementDocs,
                orderId: draftId, auditId: auditId, opId: opId,
                source: 'convertDraft', operation: 'manual_order_create',
                actorUid: actorUid, actorName: actorName,
                writes: writes, sensitive: sensitive,
                topNewValues: { status: 'new', total: totals.total, saleSavings: totals.saleSavings, deliveryFee: totals.deliveryFee, amountDue: totals.amountDue }
              };
              convertResult = { result: 'ok', order: orderData, created: true };
              return convertResult;
            });
          });
        }).then(function () {
          // M1 post-commit (best-effort, retry 3x, never throws):
          // movements + audit entry, ONLY when a new order was
          // created (never on ALREADY_CONVERTED, never when the
          // transaction threw). The order is already committed, so
          // a failure here cannot fail the call — it is logged,
          // and the orphan repair recovers a missing audit entry.
          var chain = Promise.resolve();
          if (convertResult && convertResult.created && pendingPostCommit) {
            chain = chain.then(function () { return writeOrderPostCommit(pendingPostCommit); });
          }
          // §13 second write (best-effort, retry 3x, logged): refresh
          // products.inStock from the inventory values just written.
          if (convertResult && convertResult.created && committedLines && committedLines.length) {
            chain = chain.then(function () { return refreshInStock(committedLines); });
          }
          return chain.then(function () { return convertResult; });
        });
      });
    }

    // Change a draft's status (merge-only, audited). The transition
    // is validated here; the rules let any admin/manager write a
    // draft, so this is the guard that stops e.g. resurrecting a
    // converted draft.
    function updateDraftStatus(draftId, status) {
      requireAdmin();
      return db().collection('checkoutDrafts').doc(draftId).get().then(function (snap) {
        if (!snap.exists) throw new Error('المسودة مش موجودة');
        var from = (snap.data() || {}).status || 'new';
        if (from !== status && !draftCanTransition(from, status)) {
          throw new Error('مينفعش تغير الحالة من ' + from + ' لـ ' + status);
        }
        return auditedWrite({
          writes: { ['checkoutDrafts/' + draftId]: { status: status } },
          sensitive: { ['checkoutDrafts/' + draftId]: { status: status } },
          operation: 'draft_status'
        });
      });
    }

    // Delete a draft manually. NOTE: this does NOT use auditedDelete —
    // the rules' delete-audit lives at the deterministic id
    // `del_<collection>_<docId>` with operation 'delete', while
    // auditedDelete writes a random audit id (pre-existing gap in
    // the PC's other deletes — flagged, not changed here). The
    // deterministic entry below is what the rules enforce.
    function deleteDraft(draftId) {
      requireAdmin();
      var auditId = 'del_checkoutDrafts_' + draftId;
      var batch = db().batch();
      batch.delete(db().collection('checkoutDrafts').doc(draftId));
      batch.set(db().collection('audit').doc(auditId), {
        operationId: auditId,
        actor: state.user.uid,
        actorName: state.user.email || '',
        timestamp: serverTimestamp(),
        collection: 'checkoutDrafts',
        docId: draftId,
        operation: 'delete',
        changedFields: ['sessionId', 'sessionToken', 'name', 'phone', 'cart', 'status'],
        oldValues: {},
        newValues: {},
        docIds: { ['checkoutDrafts/' + draftId]: ['sessionId', 'sessionToken', 'name', 'phone', 'cart', 'status'] },
        newValuesByDoc: { ['checkoutDrafts/' + draftId]: {} },
        documents: [],
        source: 'store_manager'
      });
      return batch.commit().then(function () { return true; });
    }

    // Save the governorate activation list (merge-only, audited).
    function saveGovernorates(entries) {
      requireAdmin();
      var list = entries || [];
      if (list.length > 27) return Promise.reject(new Error('المحافظات 27 بس'));
      return auditedWrite({
        writes: { 'storeSettings/governorates': { entries: list } },
        sensitive: {},
        operation: 'governorates_save'
      });
    }

    // One-shot read of the deletion config (autoDeleteDays, 0 = manual only).
    function getDeletionConfig() {
      requireAdmin();
      return db().collection('storeSettings').doc('deletion').get().then(function (snap) {
        var data = snap.exists ? (snap.data() || {}) : {};
        var days = Number(data.autoDeleteDays);
        return { autoDeleteDays: (Number.isInteger(days) && days >= 0) ? days : 0 };
      });
    }

    // Save the scheduled auto-delete (X days, 0 = manual only).
    function saveDeletionConfig(autoDeleteDays) {
      requireAdmin();
      var days = Number(autoDeleteDays);
      if (!Number.isInteger(days) || days < 0 || days > 365) {
        return Promise.reject(new Error('عدد الأيام لازم يكون بين 0 و 365'));
      }
      return auditedWrite({
        writes: { 'storeSettings/deletion': { autoDeleteDays: days } },
        sensitive: {},
        operation: 'deletion_config_save'
      });
    }

    // Save the daily-write quota cut-off (none / journeys / drafts).
    // Mirrors saveDeletionConfig: one audited merge-only write to
    // the storeSettings/quota doc. The Settings UI calls this as
    // fb.setQuotaCutoff — without it the Save button throws.
    function setQuotaCutoff(cutoffLevel) {
      requireAdmin();
      var level = String(cutoffLevel);
      if (['none', 'journeys', 'drafts'].indexOf(level) === -1) {
        return Promise.reject(new Error('مستوى الإيقاف مش صالح'));
      }
      return auditedWrite({
        writes: { 'storeSettings/quota': { cutoffLevel: level } },
        sensitive: {},
        operation: 'quota_cutoff_save'
      });
    }

    // Scheduled draft deletion (runs from the PC admin on start):
    // reads storeSettings/deletion, skips when lastRunAt is today,
    // deletes drafts older than X days, and enforces the newest-100
    // cap. Idempotent: a second run the same day deletes nothing.
    // X = 0 only enforces the cap. Writes a {at, deleted, kept} run
    // record and returns {deleted, kept, skipped}.
    function runDraftDeletion() {
      requireAdmin();
      var now = new Date();
      var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return db().collection('storeSettings').doc('deletion').get().then(function (cfgSnap) {
        var cfg = cfgSnap.exists ? (cfgSnap.data() || {}) : {};
        var days = Number(cfg.autoDeleteDays);
        if (!Number.isInteger(days) || days < 0) days = 0;
        var lastRunAt = orderDateValue(cfg.lastRunAt);
        if (lastRunAt && lastRunAt.getTime() >= todayStart.getTime()) {
          return { deleted: 0, kept: 0, skipped: true };
        }
        var cutoff = days > 0 ? new Date(now.getTime() - days * 24 * 60 * 60 * 1000) : null;
        return db().collection('checkoutDrafts').orderBy('lastSyncAt', 'desc').limit(500).get().then(function (snap) {
          var all = [];
          snap.forEach(function (d) {
            var data = d.data() || {};
            data.id = d.id;
            all.push(data);
          });
          // Newest first (the query order); the fake returns insertion
          // order, so sort client-side by lastSyncAt desc.
          all.sort(function (a, b) {
            var ta = orderDateValue(a.lastSyncAt);
            var tb = orderDateValue(b.lastSyncAt);
            return (tb ? tb.getTime() : 0) - (ta ? ta.getTime() : 0);
          });
          var toDelete = [];
          var kept = 0;
          all.forEach(function (d, i) {
            var createdAt = orderDateValue(d.createdAt);
            var tooOld = cutoff && createdAt && createdAt.getTime() < cutoff.getTime();
            var overCap = i >= 100;
            if (tooOld || overCap) toDelete.push(d);
            else kept++;
          });
          var chain = Promise.resolve();
          var deleted = 0;
          toDelete.forEach(function (d) {
            chain = chain.then(function () {
              return deleteDraft(d.id).then(function () { deleted++; });
            });
          });
          return chain.then(function () {
            var run = { at: serverTimestamp(), deleted: deleted, kept: kept };
            return auditedWrite({
              writes: { 'storeSettings/deletion': { lastRunAt: serverTimestamp(), lastRun: run } },
              sensitive: {},
              operation: 'draft_deletion_run'
            }).then(function () {
              return { deleted: deleted, kept: kept, skipped: false };
            });
          });
        });
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

    // ---- Post-commit order side-effects (M1: Option 3 + audit-split) ----
    // The order transaction writes ONLY order + inventory reserves.
    // Movements and the audit entry are written AFTER the order
    // commits, in ONE batch (atomic together), best-effort with up
    // to 3 attempts — the same retry pattern as refreshInStock. A
    // failure is logged and never throws: the order is already
    // committed, so failing the call would lie about it, and a
    // missing audit entry is recovered later by repairOrphanOrder.
    // The movement docs reuse the ids reserved inside the
    // transaction, so the audit entry's docIds covers the exact docs
    // written; createdAt/updatedAt and the audit timestamp are
    // FRESH serverTimestamp() sentinels — the audit-create rule
    // requires timestamp == request.time (firestore.rules match
    // /audit).
    function writeOrderPostCommit(post) {
      var attempt = 0;
      function tryOnce() {
        attempt++;
        var batch = db().batch();
        (post.movementDocs || []).forEach(function (m) {
          batch.set(db().collection('movements').doc(m.id), {
            productId: m.productId, type: 'order_reserve', qty: -m.qty,
            orderId: post.orderId, source: post.source,
            actorUid: post.actorUid, createdAt: serverTimestamp(), operationId: post.opId, updatedAt: serverTimestamp()
          });
        });
        var entry = buildAuditEntry({
          opId: post.opId, actor: post.actorUid, actorName: post.actorName, timestamp: serverTimestamp(),
          operation: post.operation, writes: post.writes, sensitive: post.sensitive,
          oldValues: {}, topNewValues: post.topNewValues || {}
        });
        entry.source = post.source;
        batch.set(db().collection('audit').doc(post.auditId), entry);
        return batch.commit().then(function () { return true; }).catch(function (e) {
          logDiag('order post-commit write failed (attempt ' + attempt + '/3): ' + (e.message || e));
          if (attempt < 3) return tryOnce();
          return false;
        });
      }
      return tryOnce();
    }

    // ---- Orphan-order check + repair (M1: audit-split recovery) ----
    // With the audit entry written post-commit, a crash between the
    // order commit and the audit write leaves an order with no
    // matching audit entry. findOrphanOrders runs a BOUNDED check
    // over the 100 most recent orders (newest first) and returns the
    // ones whose audit/<order.auditId> is missing — a missing/empty
    // auditId counts as orphan.
    function findOrphanOrders() {
      requireAdmin();
      return db().collection('orders').orderBy('createdAt', 'desc').limit(100).get().then(function (snap) {
        var orders = [];
        snap.forEach(function (d) {
          var data = d.data() || {};
          data.id = d.id;
          orders.push(data);
        });
        var checks = orders.map(function (o) {
          if (!o.auditId) return Promise.resolve(o);
          return db().collection('audit').doc(o.auditId).get().then(function (aSnap) {
            return aSnap.exists ? null : o;
          });
        });
        return Promise.all(checks).then(function (found) {
          return found.filter(function (o) { return !!o; });
        });
      });
    }

    // Repair writes the missing audit entry with the same
    // money-field coverage as the original order audit entry
    // (status, total, saleSavings, deliveryFee, amountDue, plus
    // 'items' when any line has a non-null basePrice), plus the
    // markers repaired: true and originalCreatedAt (the order's
    // createdAt). The audit-create rule has no hasOnly, so the extra
    // fields are allowed; buildAuditEntry returns a fixed shape, so
    // the markers are set on the entry after building it.
    //
    // DESIGN CORRECTION (vs the design doc §2, which says
    // "actor = the order's creator, timestamp = the order's
    // createdAt"): that literal spec cannot pass the audit-create
    // rule (firestore.rules match /audit) — the admin branch
    // requires timestamp == request.time (a past createdAt would be
    // denied) and actor == request.auth.uid (a storefront order's
    // creator is anonymous — there is no uid). So the repair uses
    // the REPAIRING admin (actor = request.auth.uid, actorName =
    // their email) and a FRESH serverTimestamp() at repair time;
    // the original values are preserved in the
    // repaired/originalCreatedAt markers instead.
    // Retries 3x; throws only after the third failure so the UI can
    // report it. An order with no auditId at all gets a fresh one,
    // stamped onto the order in the same batch (the entry covers
    // the stamp: auditId is in its writes map, operationId and
    // updatedAt are auto-covered by buildAuditEntry).
    function repairOrphanOrder(order) {
      requireAdmin();
      var o = order || {};
      if (!o.id) return Promise.reject(new Error('الطلب مش موجود'));
      var auditId = o.auditId || newUuid();
      var operation = (o.source === 'storefront') ? 'create' : 'manual_order_create';
      var orderWrite = {
        status: o.status || 'new', total: o.total, saleSavings: o.saleSavings,
        deliveryFee: o.deliveryFee, amountDue: o.amountDue
      };
      var hasBasePrice = (o.items || []).some(function (it) { return it && it.basePrice != null; });
      if (hasBasePrice) orderWrite.items = o.items;
      if (!o.auditId) orderWrite.auditId = auditId;
      var writes = {};
      writes['orders/' + o.id] = orderWrite;
      var sensitive = {};
      sensitive['orders/' + o.id] = Object.assign({}, orderWrite);
      var topNewValues = { status: orderWrite.status, total: o.total, saleSavings: o.saleSavings, deliveryFee: o.deliveryFee, amountDue: o.amountDue };
      var attempt = 0;
      function tryOnce() {
        attempt++;
        var batch = db().batch();
        var entry = buildAuditEntry({
          opId: auditId, actor: state.user.uid, actorName: state.user.email || '',
          timestamp: serverTimestamp(), operation: operation,
          writes: writes, sensitive: sensitive, oldValues: {}, topNewValues: topNewValues
        });
        entry.source = 'repairOrphanOrder';
        entry.repaired = true;
        entry.originalCreatedAt = o.createdAt || null;
        batch.set(db().collection('audit').doc(auditId), entry);
        if (!o.auditId) {
          batch.set(db().collection('orders').doc(o.id), { auditId: auditId, operationId: auditId, updatedAt: serverTimestamp() }, { merge: true });
        }
        return batch.commit().then(function () { return { repaired: true, auditId: auditId }; }).catch(function (e) {
          logDiag('orphan repair failed for order ' + o.id + ' (attempt ' + attempt + '/3): ' + (e.message || e));
          if (attempt < 3) return tryOnce();
          throw e;
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
              // Refresh products.inStock in the SAME transaction (the
              // flag is (stock - reserved) > 0 after the release, so an
              // expired order can never leave a stale flag behind).
              // Budget: order hasAudit (1) + one hasAudit per product
              // write (same audit doc) + the admin-role get — at most
              // 7 lines, so this stays under the 10-call budget even
              // without getAfter dedup.
              var inStock = computeInStock(stock, newReserved);
              tx.set(db().collection('products').doc(it.productId), { inStock: inStock, operationId: opId, updatedAt: now }, { merge: true });
              writes['products/' + it.productId] = { inStock: inStock };
              sensitive['products/' + it.productId] = { inStock: inStock };
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

    // Activation history lives in the subcollection
    // templates/{id}/activations/{operationId} (spec §Firestore
    // documents). The rules for that subcollection land with entry 10;
    // until they deploy the write is denied, so it is best-effort: a
    // denied history write is logged, never a failed activation. The
    // pointer history stack is the rollback source and is always
    // written (it rides the audited pointer write).
    function recordTemplateActivation(templateId, entry) {
      var opId = newUuid();
      var doc = {
        templateId: entry.templateId, bundleVersion: entry.bundleVersion || null,
        bundleHash: entry.bundleHash || null, shellVersion: entry.shellVersion || SHELL_VERSION,
        approver: entry.approver || '', at: serverTimestamp(), action: entry.action,
        previousTemplateId: entry.previousTemplateId || null
      };
      if (entry.note) doc.note = entry.note;
      if (entry.deniedTemplateId) doc.deniedTemplateId = entry.deniedTemplateId;
      try {
        return db().collection('templates').doc(templateId).collection('activations').doc(opId).set(doc).then(function () { return true; }).catch(function (e) {
          logDiag('template activation history not recorded (' + templateId + '): ' + (e && e.message ? e.message : e));
          return false;
        });
      } catch (e) {
        logDiag('template activation history not recorded (' + templateId + '): ' + (e && e.message ? e.message : e));
        return Promise.resolve(false);
      }
    }

    // Demotes the template that stops being live. An approved template
    // goes back to 'approved' (it keeps its approval); a template that
    // went live directly, without approval (2026-11-27 direct
    // activation), goes back to 'preview' — never 'approved', so the
    // UI never shows an approval that never happened. Classic stays
    // 'active': it is the pinned rollback target.
    function _demotePreviousLive(currentId, operation) {
      if (currentId === 'classic') return Promise.resolve();
      return db().collection('templates').doc(currentId).get().then(function (prevSnap) {
        if (!prevSnap.exists) return;
        var prev = prevSnap.data() || {};
        if (prev.status !== 'active') return;
        var demoted = (prev.approval && typeof prev.approval === 'object') ? 'approved' : 'preview';
        return auditedWrite({
          writes: { ['templates/' + currentId]: { status: demoted } },
          sensitive: { ['templates/' + currentId]: { status: demoted } },
          operation: operation,
          oldValues: { ['templates/' + currentId]: { status: 'active' } },
          topNewValues: { templateId: currentId, status: demoted }
        });
      });
    }

    // Entry 16: bundle activation. Same shape as Flutter entry 11 —
    // one pointer write (templateId + bundleVersion + bundleHash +
    // approver + timestamp) + pointer history-stack append + activation
    // record. A bundle doc is validated through the bundle gateway
    // (registry + hosted-manifest checks); since 2026-11-27 activation
    // is DIRECT — no approval / preview gate (Mohamed's decision).
    // A v1 doc goes through the old gateway as before.
    function activateTemplate(templateId) {
      requireAdmin();
      var actor = (state.user && (state.user.email || state.user.uid)) || '';
      return db().collection('templates').doc(templateId).get().then(function (snap) {
        if (!snap.exists) throw new Error('القالب مش موجود');
        var data = snap.data() || {};
        var bundle = isBundleDoc(data);
        if (bundle) {
          // Registry-shape (A): the registry doc gets the six-field
          // check only; the HOSTED manifest (fetch + hash check) is
          // validated next — the full-manifest validator never runs
          // on registry data.
          var registryReport = validateRegistryManifest(data, templateId);
          if (!registryReport.passed) throw new Error('القالب مش صالح للتفعيل: ' + registryReport.failedChecks.join('، '));
          // Direct activation (2026-11-27, Mohamed's decision): no
          // approval / preview gate — any draft, preview, approved or
          // active template activates once its bundle is valid
          // (registry + hosted-manifest checks above). The D1 approval
          // stays as an optional action; an approved template keeps
          // its approval record, an unapproved one simply has none.
          return validateHostedManifest(templateId).then(function (hosted) {
            if (!hosted.passed) throw new Error('القالب المستضاف مش صالح للتفعيل: ' + hosted.failedChecks.join('، '));
            return { data: data, bundle: bundle };
          });
        }
        var v1report = validateTemplateDoc(data);
        if (!v1report.passed) throw new Error('القالب مش صالح للتفعيل: ' + v1report.failedChecks.join('، '));
        return { data: data, bundle: bundle };
      }).then(function (ctx) {
        var data = ctx.data;
        var bundle = ctx.bundle;
        return ensureClassicTemplateDoc().then(function () {
          return db().collection('storeSettings').doc('activeTemplate').get();
        }).then(function (ptrSnap) {
          var pointer = (ptrSnap.exists && ptrSnap.data()) || {};
          var currentId = pointer.templateId || 'classic';
          if (currentId === templateId) throw new Error('القالب ده مفعّل أصلاً');
          var bundleVersion = bundle ? (data.version || BUNDLE_VERSION) : BUNDLE_VERSION;
          var bundleHash = bundle ? (data.bundleHash || null) : null;
          var historyEntry = { templateId: templateId, bundleVersion: bundleVersion, bundleHash: bundleHash, at: serverTimestamp(), by: actor };
          var history = pointerHistoryAppend(pointer, historyEntry);
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
          chain = chain.then(function () { return _demotePreviousLive(currentId, 'template_activate'); });
          return chain.then(function () {
            return auditedWrite({
              writes: { 'storeSettings/activeTemplate': { templateId: templateId, bundleVersion: bundleVersion, bundleHash: bundleHash, previousTemplateId: currentId, history: history } },
              sensitive: {},
              operation: 'template_activate',
              oldValues: { 'storeSettings/activeTemplate': { templateId: currentId } },
              topNewValues: { templateId: templateId, previousTemplateId: currentId }
            });
          }).then(function () {
            return recordTemplateActivation(templateId, { templateId: templateId, bundleVersion: bundleVersion, bundleHash: bundleHash, shellVersion: SHELL_VERSION, approver: actor, action: 'activate', previousTemplateId: currentId });
          }).then(function () { return { previousTemplateId: currentId, templateId: templateId, bundleVersion: bundleVersion, bundleHash: bundleHash }; });
        });
      });
    }

    // One-tap rollback (spec B5): restore the second-last entry of the
    // pointer history stack — never previousTemplateId (display only).
    // Rolling back twice walks the stack backwards one step at a time
    // and can never ping-pong. A target that has since been archived
    // or retired (or is missing/invalid) is denied and classic is
    // restored instead, with the denial recorded on the history entry.
    function rollbackTemplate() {
      requireAdmin();
      var actor = (state.user && (state.user.email || state.user.uid)) || '';
      return db().collection('storeSettings').doc('activeTemplate').get().then(function (ptrSnap) {
        var pointer = (ptrSnap.exists && ptrSnap.data()) || {};
        var currentId = pointer.templateId || 'classic';
        var target = rollbackTargetFromHistory(pointer);
        if (!target || !target.templateId) throw new Error('مفيش قالب سابق للرجوع ليه');
        var targetId = target.templateId;
        var note = null;
        var deniedId = null;
        return ensureClassicTemplateDoc().then(function () {
          return db().collection('templates').doc(targetId).get();
        }).then(function (snap) {
          var data = snap.exists ? (snap.data() || {}) : null;
          // Denial: the target is unusable — restore classic instead
          // (or throw when classic is already live). The denial
          // decision must wait for the async hosted-manifest check,
          // so it lives in this helper, not after the if/else.
          function denied() {
            deniedId = targetId;
            note = 'الرجوع لـ' + targetId + ' مرفوض (القالب اتأرشف أو مش صالح) — رجعنا للكلاسيكي';
            if (currentId === 'classic') throw new Error('الرجوع لـ' + deniedId + ' مرفوض — والكلاسيكي مفعّل أصلاً');
            targetId = 'classic';
            return db().collection('templates').doc('classic').get().then(function (csnap) {
              if (!csnap.exists) throw new Error('القالب الكلاسيكي مش موجود');
              return csnap.data() || {};
            });
          }
          if (!data) return denied();
          if (data.status === 'retired' || data.status === 'archived') return denied();
          if (isBundleDoc(data)) {
            // Registry-shape (A): six-field registry check; the
            // hosted manifest is checked next — the full-manifest
            // validator never runs on registry data.
            var registryReport = validateRegistryManifest(data, targetId);
            if (!registryReport.passed) return denied();
            return validateHostedManifest(targetId).then(function (hosted) {
              if (!hosted.passed) return denied();
              return data;
            });
          }
          if (!validateTemplateDoc(data).passed) return denied();
          return data;
        }).then(function (targetData) {
          if (targetId === currentId) throw new Error('القالب السابق هو نفسه الحالي');
          var bundle = isBundleDoc(targetData);
          var bundleVersion = bundle ? (targetData.version || BUNDLE_VERSION) : BUNDLE_VERSION;
          var bundleHash = bundle ? (targetData.bundleHash || null) : null;
          var historyEntry = { templateId: targetId, bundleVersion: bundleVersion, bundleHash: bundleHash, at: serverTimestamp(), by: actor };
          if (note) historyEntry.note = note;
          var history = pointerHistoryAppend(pointer, historyEntry);
          var chain = Promise.resolve();
          if (targetData.status !== 'active') {
            chain = chain.then(function () {
              return auditedWrite({
                writes: { ['templates/' + targetId]: { status: 'active' } },
                sensitive: { ['templates/' + targetId]: { status: 'active' } },
                operation: 'template_rollback',
                oldValues: { ['templates/' + targetId]: { status: targetData.status } },
                topNewValues: { templateId: targetId, status: 'active' }
              });
            });
          }
          chain = chain.then(function () { return _demotePreviousLive(currentId, 'template_rollback'); });
          return chain.then(function () {
            return auditedWrite({
              writes: { 'storeSettings/activeTemplate': { templateId: targetId, bundleVersion: bundleVersion, bundleHash: bundleHash, previousTemplateId: currentId, history: history } },
              sensitive: {},
              operation: 'template_rollback',
              oldValues: { 'storeSettings/activeTemplate': { templateId: currentId } },
              topNewValues: { templateId: targetId, previousTemplateId: currentId }
            });
          }).then(function () {
            return recordTemplateActivation(targetId, { templateId: targetId, bundleVersion: bundleVersion, bundleHash: bundleHash, shellVersion: SHELL_VERSION, approver: actor, action: 'rollback', previousTemplateId: currentId, note: note, deniedTemplateId: deniedId });
          }).then(function () { return { templateId: targetId, previousTemplateId: currentId, fellBack: deniedId !== null, deniedTemplateId: deniedId }; });
        });
      });
    }

    // Approval (D1 checklist — Mohamed judges; the admin records it):
    // preview → approved. Freezes bundle hash + shell version; a
    // changed hash needs a new approval (checkApprovalFreeze).
    function approveTemplate(templateId) {
      requireAdmin();
      var actor = (state.user && (state.user.email || state.user.uid)) || '';
      return db().collection('templates').doc(templateId).get().then(function (snap) {
        if (!snap.exists) throw new Error('القالب مش موجود');
        var data = snap.data() || {};
        if (!isBundleDoc(data)) throw new Error('القالب ده من النظام القديم — الاعتماد للنسخ الجديدة بس');
        if (data.status !== 'preview') throw new Error('القالب لازم يكون في مرحلة المعاينة عشان تعتمده');
        // Registry-shape (A): the registry doc gets the six-field
        // check only; the HOSTED manifest (fetch + hash check) is
        // validated next — the full-manifest validator never runs
        // on registry data.
        var registryReport = validateRegistryManifest(data, templateId);
        if (!registryReport.passed) throw new Error('القالب مش صالح للاعتماد: ' + registryReport.failedChecks.join('، '));
        return validateHostedManifest(templateId).then(function (hosted) {
          if (!hosted.passed) throw new Error('القالب المستضاف مش صالح للاعتماد: ' + hosted.failedChecks.join('، '));
          var approval = { approver: actor, at: serverTimestamp(), shellVersion: SHELL_VERSION, bundleHash: data.bundleHash || null };
          return auditedWrite({
            writes: { ['templates/' + templateId]: { status: 'approved', approval: approval } },
            sensitive: { ['templates/' + templateId]: { status: 'approved' } },
            operation: 'template_approve',
            oldValues: { ['templates/' + templateId]: { status: data.status } },
            topNewValues: { templateId: templateId, status: 'approved' }
          }).then(function () { return true; });
        });
      });
    }

    // Draft → preview, by the admin running the gateway (transition
    // table): the bundle files are fetched from Hosting and run
    // through the full gateway; on pass the template moves to preview
    // with the report stored, on fail it stays a draft with the report.
    function markTemplatePreview(templateId) {
      requireAdmin();
      return db().collection('templates').doc(templateId).get().then(function (snap) {
        if (!snap.exists) throw new Error('القالب مش موجود');
        var data = snap.data() || {};
        if (!isBundleDoc(data)) throw new Error('القالب ده من النظام القديم — نقل المعاينة للنسخ الجديدة بس');
        if (data.status !== 'draft') throw new Error('القالب لازم يكون مسودة عشان يتنقل للمعاينة');
        return validateBundleFromHosting(templateId).then(function (report) {
          return saveTemplateValidation(templateId, report).then(function () {
            if (!report.passed) throw new Error('القالب مش صالح للمعاينة: ' + report.failedChecks.join('، '));
            return auditedWrite({
              writes: { ['templates/' + templateId]: { status: 'preview' } },
              sensitive: { ['templates/' + templateId]: { status: 'preview' } },
              operation: 'template_preview',
              oldValues: { ['templates/' + templateId]: { status: data.status } },
              topNewValues: { templateId: templateId, status: 'preview' }
            });
          }).then(function () { return true; });
        });
      });
    }

    // Status moves that are NOT activation/approval: back to draft (a
    // preview rejection — counts as one of the 2 D1 rounds) or to
    // retired. Classic is pinned: it can never be archived or deleted
    // while it is the rollback target.
    function setTemplateStatus(id, status) {
      requireAdmin();
      if (status !== 'draft' && status !== 'retired') return Promise.reject(new Error('الحالة دي بتتغير من الاعتماد أو التفعيل بس'));
      return db().collection('templates').doc(id).get().then(function (snap) {
        if (!snap.exists) throw new Error('القالب مش موجود');
        var data = snap.data() || {};
        return db().collection('storeSettings').doc('activeTemplate').get().then(function (ptrSnap) {
          var pointer = (ptrSnap.exists && ptrSnap.data()) || {};
          if ((pointer.templateId || 'classic') === id) throw new Error('مينفعش تغير حالة القالب المفعّل — رجّع قالب تاني الأول');
          if (id === 'classic' && isRollbackTarget('classic', pointer)) throw new Error('الكلاسيكي مثبت كقالب الرجوع الآمن — مينفعش يتأرشف أو يتمسح');
          if (status === 'draft' && data.status !== 'preview') throw new Error('الرجوع لمسودة من الحالة دي مش مسموح');
          if (status === 'retired' && (data.status === 'active' || data.status === 'retired')) throw new Error('القالب المفعّل ميتأرشفش — رجّع قالب تاني الأول');
          return auditedWrite({
            writes: { ['templates/' + id]: { status: status } },
            sensitive: { ['templates/' + id]: { status: status } },
            operation: 'template_status',
            oldValues: { ['templates/' + id]: { status: data.status } },
            topNewValues: { templateId: id, status: status }
          });
        });
      }).then(function () { return true; });
    }

    // Stores the last gateway report on the registry doc (the
    // transition table: a failed gateway leaves the template in draft
    // WITH the report).
    function saveTemplateValidation(templateId, report) {
      requireAdmin();
      var rep = report || { passed: false, failedChecks: ['unknown'] };
      return auditedWrite({
        writes: { ['templates/' + templateId]: { validation: { passed: !!rep.passed, checks: rep.failedChecks || [], warnings: rep.warnings || [], at: new Date().toISOString() } } },
        sensitive: {},
        operation: 'template_validate',
        topNewValues: { templateId: templateId }
      }).then(function () { return true; });
    }

    // Preview slugs (spec §Preview mechanism): previews/{slug} with
    // {templateId, version, issuedAt, issuedBy, status}. Reuses an open
    // slug for the template; otherwise issues a fresh 128-bit random
    // URL-safe slug (32 hex chars). The rules for previews/{slug} land
    // with entry 10; until then this fails with a clear message.
    function getOrIssuePreviewSlug(templateId) {
      requireAdmin();
      var actor = (state.user && (state.user.email || state.user.uid)) || '';
      return db().collection('templates').doc(templateId).get().then(function (snap) {
        if (!snap.exists) throw new Error('القالب مش موجود');
        var data = snap.data() || {};
        return db().collection('previews').where('templateId', '==', templateId).get().then(function (qs) {
          var open = null;
          qs.forEach(function (d) {
            var dd = d.data() || {};
            if (dd.status === 'open' && !open) open = d.id;
          });
          if (open) return open;
          var slug = newUuid().replace(/-/g, '');
          var doc = { templateId: templateId, version: data.version || BUNDLE_VERSION, issuedAt: serverTimestamp(), issuedBy: actor, status: 'open' };
          return db().collection('previews').doc(slug).set(doc).then(function () { return slug; });
        });
      }).catch(function (e) {
        if (e && e.message === 'القالب مش موجود') throw e;
        logDiag('preview slug unavailable (' + templateId + '): ' + (e && e.message ? e.message : e));
        throw new Error('رابط المعاينة لسه مش متاح — قواعد المعاينة لسه متنشرتش');
      });
    }

    // Fetches a bundle body from Hosting (versioned path) for the deep
    // gateway check — the validate action on the card. 10s TOTAL
    // timeout for manifest + all files (gateway-rules.json
    // bundleTimeoutMs). fetchImpl is injectable for tests; defaults to
    // the global fetch.
    function fetchBundleFiles(templateId, version, fetchImpl) {
      var fetchFn = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
      if (!fetchFn) return Promise.reject(new Error('المتصفح ده مش بيدعم جلب ملفات القالب'));
      var ver = version || BUNDLE_VERSION;
      var base = STOREFRONT_BASE_URL + '/templates/' + templateId + '/' + ver + '/';
      var deadline = Date.now() + BUNDLE_TIMEOUT_MS;
      function timedFetch(url) {
        return new Promise(function (resolve, reject) {
          var remaining = Math.max(0, deadline - Date.now());
          var done = false;
          var timer = setTimeout(function () { if (!done) { done = true; reject(new Error('انتهت المهلة (' + BUNDLE_TIMEOUT_MS + 'ms): ' + url)); } }, remaining || 1);
          fetchFn(url).then(function (res) {
            if (done) return;
            done = true; clearTimeout(timer);
            if (!res.ok) { reject(new Error('تعذر جلب ' + url + ' (HTTP ' + res.status + ')')); return; }
            resolve(res.text());
          }, function (e) {
            if (done) return;
            done = true; clearTimeout(timer); reject(e);
          });
        });
      }
      return timedFetch(base + 'manifest.json').then(function (manifestText) {
        var manifest;
        try { manifest = JSON.parse(manifestText); } catch (e) { throw new Error('manifest.json مش JSON صحيح'); }
        var files = { 'manifest.json': manifestText };
        var sections = Array.isArray(manifest.sections) ? manifest.sections : [];
        var wanted = sections.map(function (s) { return 'sections/' + s + '.html'; });
        wanted.push('styles.css', 'tokens.json');
        var chain = Promise.resolve();
        wanted.forEach(function (path) {
          chain = chain.then(function () {
            return timedFetch(base + path).then(function (text) { files[path] = text; });
          });
        });
        return chain.then(function () { return { manifest: manifest, files: files }; });
      });
    }

    function validateBundleFromHosting(templateId) {
      requireAdmin();
      return db().collection('templates').doc(templateId).get().then(function (snap) {
        if (!snap.exists) throw new Error('القالب مش موجود');
        var data = snap.data() || {};
        if (!isBundleDoc(data)) {
          var v1 = validateTemplateDoc(data);
          return { passed: v1.passed, failedChecks: v1.failedChecks, warnings: ['v1-doc'] };
        }
        return fetchBundleFiles(templateId, data.version).then(function (bundle) {
          var manifest = bundle.manifest;
          manifest.id = manifest.id || templateId;
          return validateTemplateBundle(manifest, bundle.files, templateId);
        });
      });
    }

    // Validates the HOSTED manifest (decision 2, shape (A)): fetches
    // manifest.json from Hosting, validates it with the FULL manifest
    // validator (a hosted manifest IS a full manifest — motion, dark,
    // sections all live there), and requires its bundleHash to equal
    // the registry doc's bundleHash — a bundle changed after approval
    // fails here and must be re-approved. Returns a report
    // {passed, failedChecks, warnings}; a fetch failure fails closed
    // (bundle.fetch). The full file-set gateway already ran at preview
    // time (markTemplatePreview); this is the cheap re-check at
    // approve/activate time.
    function validateHostedManifest(templateId) {
      requireAdmin();
      return db().collection('templates').doc(templateId).get().then(function (snap) {
        if (!snap.exists) throw new Error('القالب مش موجود');
        var data = snap.data() || {};
        if (!isBundleDoc(data)) {
          var v1 = validateTemplateDoc(data);
          return { passed: v1.passed, failedChecks: v1.failedChecks, warnings: ['v1-doc'] };
        }
        var fetchFn = (typeof fetch !== 'undefined' ? fetch : null);
        if (!fetchFn) return { passed: false, failedChecks: ['bundle.fetch'], warnings: [] };
        var url = STOREFRONT_BASE_URL + '/templates/' + templateId + '/' + (data.version || BUNDLE_VERSION) + '/manifest.json';
        return fetchFn(url).then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.text();
        }).then(function (text) {
          var hosted;
          try { hosted = JSON.parse(text); } catch (e) {
            return { passed: false, failedChecks: ['manifest.json'], warnings: [] };
          }
          hosted.id = hosted.id || templateId;
          var rep = validateBundleManifest(hosted, templateId);
          var failed = rep.failedChecks.slice();
          if (hosted.bundleHash !== data.bundleHash) failed.push('manifest.bundleHash');
          var seen = {};
          var unique = failed.filter(function (c) { if (seen[c]) return false; seen[c] = true; return true; });
          return { passed: unique.length === 0, failedChecks: unique, warnings: rep.warnings };
        }).catch(function () {
          return { passed: false, failedChecks: ['bundle.fetch'], warnings: [] };
        });
      });
    }

    // One audited DELETE: the document is deleted and its audit entry
    // lands in the same batch (the rules allow a delete only with its
    // delete-audit). oldValues lists the fields the audit covers.
    // Delete audit (rules hasDeleteAudit): the entry id is
    // deterministic — `del_<collection>_<docId>` — with operation
    // 'delete'. The old random id + '<collection>_delete'
    // operation (pre-existing, v1.1.0) was denied live for
    // products / categories (feedback has no audit
    // requirement, so it worked by accident). Mirrors deleteDraft's
    // deterministic entry below.
    function auditedDelete(collection, docId, operation, oldValues) {
      requireAdmin();
      var batch = db().batch();
      var auditId = 'del_' + collection + '_' + docId;
      var auditRef = db().collection('audit').doc(auditId);
      var opId = auditId;
      var key = collection + '/' + docId;
      var writes = {};
      writes[key] = {};
      var entry = buildAuditEntry({
        opId: opId,
        actor: state.user.uid,
        actorName: state.user.email || '',
        timestamp: serverTimestamp(),
        operation: 'delete',
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
      return auditedDelete('feedback', feedbackId, 'delete', {});
    }

    function deleteWebsiteProduct(productId) {
      return auditedDelete('products', productId, 'delete', {});
    }

    function deleteCategory(categoryId) {
      return auditedDelete('categories', categoryId, 'delete', {});
    }

    // ---- Website-control subscriptions (contract §8) ----
    function subscribeProducts(cb) {
      return _subscribe(db().collection('products').orderBy('name'), cb);
    }

    function subscribeCategories(cb) {
      return _subscribe(db().collection('categories').orderBy('name'), cb);
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

    // ── Account profile (1.1.5): display name + mobile for the signed-in admin ──
    // Writes to admins/{uid} (merge) so the Team page and the mobile app show
    // the same name/phone. Also keeps the phones sign-in lookup in sync when
    // the number changes (lookup key = SHA-256 hex of the normalized phone,
    // same rule as the mobile app's lib/core/identifier.dart). Best-effort:
    // any failure resolves {saved:false} — localStorage remains the chip's
    // source of truth, so a failed sync never blocks the panel.
    function sha256Hex(str) {
      if (typeof crypto === 'undefined' || !crypto.subtle || !crypto.subtle.digest) return Promise.resolve(null);
      if (typeof TextEncoder === 'undefined') return Promise.resolve(null);
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (buf) {
        return Array.prototype.map.call(new Uint8Array(buf), function (b) {
          return ('0' + b.toString(16)).slice(-2);
        }).join('');
      }).catch(function () { return null; });
    }
    function saveAccountProfile(profile) {
      var st = state;
      if (!st || !st.user || !st.user.uid) return Promise.resolve({ saved: false, reason: 'no-session' });
      var name = (profile.name || 'محمد').trim() || 'محمد';
      var phone = (profile.phone || '').trim();
      var prevPhone = (profile.prevPhone || '').trim();
      return db().collection('admins').doc(st.user.uid).set({ name: name, phone: phone }, { merge: true }).then(function () {
        if (phone === prevPhone) return { saved: true };
        var oldKey = normalizeEgyptPhone(prevPhone);
        var newKey = normalizeEgyptPhone(phone);
        var chain = Promise.resolve();
        if (oldKey) {
          chain = chain.then(function () { return sha256Hex(oldKey); }).then(function (h) {
            if (!h) return null;
            return db().collection('phones').doc(h).delete().catch(function () {});
          });
        }
        if (newKey) {
          chain = chain.then(function () { return sha256Hex(newKey); }).then(function (h) {
            if (!h) return null;
            return db().collection('phones').doc(h).set({ email: st.user.email || '', uid: st.user.uid }, { merge: true }).catch(function () {});
          });
        }
        return chain.then(function () { return { saved: true }; });
      }).catch(function () { return { saved: false, reason: 'admins-write-failed' }; });
    }

    return {
      state: state,
      onStateChange: onStateChange,
      init: init,
      signIn: signIn,
      signOut: signOut,
      saveAccountProfile: saveAccountProfile,
      setPersistenceMode: setPersistenceMode,
      updateTemplateGrid: updateTemplateGrid,
      subscribeOrders: subscribeOrders,
      subscribeTemplates: subscribeTemplates,
      subscribeFeedback: subscribeFeedback,
      subscribeTeam: subscribeTeam,
      subscribeAttempts: subscribeAttempts,
      subscribeShippingCompanies: subscribeShippingCompanies,
      subscribeInventory: subscribeInventory,
      subscribeActiveTemplate: subscribeActiveTemplate,
      subscribeProducts: subscribeProducts,
      subscribeCategories: subscribeCategories,
      subscribeWebsiteSettings: subscribeWebsiteSettings,
      createManualOrder: createManualOrder,
      convertDraft: convertDraft,
      subscribeDrafts: subscribeDrafts,
      fetchDraftsPage: fetchDraftsPage,
      updateDraftStatus: updateDraftStatus,
      deleteDraft: deleteDraft,
      getJourneySummary: getJourneySummary,
      subscribeGovernorates: subscribeGovernorates,
      saveGovernorates: saveGovernorates,
      subscribeDeletionConfig: subscribeDeletionConfig,
      getDeletionConfig: getDeletionConfig,
      saveDeletionConfig: saveDeletionConfig,
      runDraftDeletion: runDraftDeletion,
      subscribeQuota: subscribeQuota,
      setQuotaCutoff: setQuotaCutoff,
      fetchOrdersByPhones: fetchOrdersByPhones,
      dailyWriteEstimate: dailyWriteEstimate,
      runLazySweep: runLazySweep,
      findOrphanOrders: findOrphanOrders,
      repairOrphanOrder: repairOrphanOrder,
      refreshInStock: refreshInStock,
      auditedWrite: auditedWrite,
      auditedDelete: auditedDelete,
      updateOrderStatus: updateOrderStatus,
      updateOrderPaymentStatus: updateOrderPaymentStatus,
      attachOrderMeta: attachOrderMeta,
      activateTemplate: activateTemplate,
      rollbackTemplate: rollbackTemplate,
      approveTemplate: approveTemplate,
      markTemplatePreview: markTemplatePreview,
      setTemplateStatus: setTemplateStatus,
      saveTemplateValidation: saveTemplateValidation,
      getOrIssuePreviewSlug: getOrIssuePreviewSlug,
      fetchBundleFiles: fetchBundleFiles,
      validateBundleFromHosting: validateBundleFromHosting,
      validateRegistryManifest: validateRegistryManifest,
      validateHostedManifest: validateHostedManifest,
      subscribeActiveTemplatePointer: subscribeActiveTemplatePointer,
      getActiveTemplatePointer: getActiveTemplatePointer,
      deleteFeedback: deleteFeedback,
      deleteWebsiteProduct: deleteWebsiteProduct,
      deleteCategory: deleteCategory,
      getDiagnostics: function () { return diagLog.slice(); },
      // Pure helpers (also exported on the factory for the tests).
      isAllowedOrderTransition: isAllowedOrderTransition,
      normalizeEgyptPhone: normalizeEgyptPhone,
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
    CLASSIC_BUNDLE_HASH: CLASSIC_BUNDLE_HASH,
    isAllowedOrderTransition: isAllowedOrderTransition,
    normalizeEgyptPhone: normalizeEgyptPhone,
    validateTemplateDoc: validateTemplateDoc,
    // Template bundles (entries 16–17): mirror gateway + pointer
    // history + approval freeze + D2 end-date helpers (pure).
    SHELL_VERSION: SHELL_VERSION,
    BUNDLE_VERSION: BUNDLE_VERSION,
    BUNDLE_GATEWAY_RULES_VERSION: BUNDLE_GATEWAY_RULES_VERSION,
    TEMPLATE_IDS: TEMPLATE_IDS,
    TEMPLATE_STATUSES_BUNDLE: TEMPLATE_STATUSES_BUNDLE,
    TEMPLATE_IDENTITY: TEMPLATE_IDENTITY,
    sha256Hex: sha256Hex,
    canonicalManifestJson: canonicalManifestJson,
    computeBundleHash: computeBundleHash,
    validateBundleManifest: validateBundleManifest,
    validateBundleFiles: validateBundleFiles,
    validateTemplateBundle: validateTemplateBundle,
    isBundleDoc: isBundleDoc,
    manifestFromRegistryDoc: manifestFromRegistryDoc,
    validateRegistryManifest: validateRegistryManifest,
    checkApprovalFreeze: checkApprovalFreeze,
    pointerHistoryAppend: pointerHistoryAppend,
    rollbackTargetFromHistory: rollbackTargetFromHistory,
    isRollbackTarget: isRollbackTarget,
    promoEndDateToISO: promoEndDateToISO,
    isoToLocalInput: isoToLocalInput,
    isValidISODateTime: isValidISODateTime,
    gridCap: gridCap,
    computeStoreProfit: computeStoreProfit,
    buildAuditEntry: buildAuditEntry,
    dedupeOrderLines: dedupeOrderLines,
    computeOrderTotals: computeOrderTotals,
    computePricingCounters: computePricingCounters,
    roundHalfUp: roundHalfUp,
    isOnSale: isOnSale,
    salePercent: salePercent,
    computeInStock: computeInStock,
    orderDateValue: orderDateValue,
    lowStockProducts: lowStockProducts,
    salesByPeriod: salesByPeriod,
    friendlyCallableError: friendlyCallableError,
    friendlyAuthError: friendlyAuthError,
    newUuid: newUuid,
    // Incomplete orders + journey tracking (2026-11-27).
    GOVERNORATES_27: GOVERNORATES_27,
    normalizeEgyptianMobile: normalizeEgyptianMobile,
    isValidEgyptianMobile: isValidEgyptianMobile,
    dwellBand: dwellBand,
    lineAvailability: lineAvailability,
    draftTriageScore: draftTriageScore,
    DRAFT_TRANSITIONS: DRAFT_TRANSITIONS,
    draftCanTransition: draftCanTransition,
    draftIsCallable: draftIsCallable,
    governorateFallback: governorateFallback,
    dedupDraftsByPhone: dedupDraftsByPhone,
    JOURNEY_SCHEMA_VERSION: JOURNEY_SCHEMA_VERSION,
    capJourneyEntries: capJourneyEntries,
    journeyActionLabel: journeyActionLabel
  };
});
