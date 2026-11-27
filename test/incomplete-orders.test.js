// Pure-logic tests for the incomplete-orders + journey feature
// (PC data layer). No Firebase, no network — the factory's pure
// helpers are asserted directly.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const StoreFB = require(path.join(__dirname, '..', 'firebase-store.js'));

// ---- Draft state machine (schema doc §2) ----
test('draft state machine: legal transitions pass, terminal states are closed', () => {
  const can = StoreFB.draftCanTransition;
  assert.equal(can('new', 'contacted'), true);
  assert.equal(can('new', 'no-answer'), true);
  assert.equal(can('new', 'converted'), true);
  assert.equal(can('new', 'dead'), true);
  assert.equal(can('contacted', 'no-answer'), true);
  assert.equal(can('contacted', 'converted'), true);
  assert.equal(can('contacted', 'dead'), true);
  assert.equal(can('no-answer', 'contacted'), true);
  assert.equal(can('no-answer', 'converted'), true);
  assert.equal(can('no-answer', 'dead'), true);
  // Terminal: nothing leaves converted or dead.
  assert.equal(can('converted', 'new'), false);
  assert.equal(can('converted', 'contacted'), false);
  assert.equal(can('converted', 'dead'), false);
  assert.equal(can('dead', 'new'), false);
  assert.equal(can('dead', 'contacted'), false);
  assert.equal(can('dead', 'converted'), false);
  // Backwards is never allowed.
  assert.equal(can('contacted', 'new'), false);
  assert.equal(can('no-answer', 'new'), false);
  assert.equal(can('new', 'new'), false);
  assert.deepEqual(StoreFB.DRAFT_TRANSITIONS.converted, []);
  assert.deepEqual(StoreFB.DRAFT_TRANSITIONS.dead, []);
});

// ---- Triage / completeness (schema doc §2: 25 each) ----
test('draftTriageScore: 25 per part — name, phone, cart, address', () => {
  const score = StoreFB.draftTriageScore;
  assert.equal(score({}), 0);
  assert.equal(score({ name: true }), 25);
  assert.equal(score({ phone: true }), 25);
  assert.equal(score({ cart: true }), 25);
  assert.equal(score({ address: true }), 25);
  assert.equal(score({ name: true, phone: true, cart: true }), 75);
  assert.equal(score({ name: true, phone: true, cart: true, address: true }), 100);
  // Falsy parts score nothing.
  assert.equal(score({ name: false, phone: 0, cart: null, address: '' }), 0);
});

test('triage minimum: a callable draft needs a non-empty cart + name + full valid phone', () => {
  const score = StoreFB.draftTriageScore;
  const isCallable = (d) =>
    score({ name: !!d.name, phone: !!d.phone, cart: (d.cart || []).length > 0, address: !!d.address }) >= 75 &&
    StoreFB.isValidEgyptianMobile(d.phone || '');
  assert.equal(isCallable({ name: 'أحمد', phone: '01012345678', cart: [{ productId: 'p1' }] }), true);
  assert.equal(isCallable({ name: 'أحمد', phone: '01012345678', cart: [] }), false); // empty cart
  assert.equal(isCallable({ name: '', phone: '01012345678', cart: [{ productId: 'p1' }] }), false); // no name
  assert.equal(isCallable({ name: 'أحمد', phone: '12345', cart: [{ productId: 'p1' }] }), false); // bad phone
  assert.equal(isCallable({ name: 'أحمد', phone: '01012345678' }), false); // no cart at all
});

// ---- Dedup by phone (newest wins) ----
test('dedupDraftsByPhone: one row per phone, first (newest) wins', () => {
  const dedup = StoreFB.dedupDraftsByPhone;
  // Input arrives newest-first (subscribeDrafts orders by lastSyncAt
  // desc), so the first row per phone is the newest one.
  const drafts = [
    { id: 'd5', phone: null, lastSyncAt: new Date('2026-11-27T12:30:00Z') },
    { id: 'd4', phone: '', lastSyncAt: new Date('2026-11-27T12:00:00Z') },
    { id: 'd2', phone: '+20 101 234 5678', lastSyncAt: new Date('2026-11-27T11:00:00Z') },
    { id: 'd1', phone: '01012345678', lastSyncAt: new Date('2026-11-27T10:00:00Z') },
    { id: 'd3', phone: '01099999999', lastSyncAt: new Date('2026-11-27T09:00:00Z') }
  ];
  const out = dedup(drafts);
  // +20 form folds to the same phone — d2 (newer) wins over d1.
  assert.equal(out.length, 4);
  assert.equal(out[2].id, 'd2');
  assert.equal(out.find((d) => d.id === 'd1'), undefined);
  assert.ok(out.find((d) => d.id === 'd3'));
  // Phoneless drafts are never deduped away.
  assert.ok(out.find((d) => d.id === 'd4'));
  assert.ok(out.find((d) => d.id === 'd5'));
  assert.deepEqual(dedup([]), []);
});

// ---- Governorate fallback (schema doc §4) ----
test('governorateFallback: missing doc -> full 27; zero active -> notSetUp', () => {
  const fb = StoreFB.governorateFallback;
  const all = fb(null);
  assert.equal(all.entries.length, 27);
  assert.equal(all.fromFallback, true);
  assert.equal(all.notSetUp, false);
  const cairo = all.entries.find((g) => g.id === 'cairo');
  assert.equal(cairo.name, 'القاهرة');
  const none = fb({ entries: [{ id: 'cairo', name: 'القاهرة', active: false }] });
  assert.equal(none.notSetUp, true);
  assert.equal(none.entries.length, 0);
  const some = fb({ entries: [{ id: 'cairo', name: 'القاهرة', active: true }, { id: 'giza', name: 'الجيزة', active: false }] });
  assert.equal(some.notSetUp, false);
  assert.equal(some.fromFallback, false);
  assert.equal(some.entries.length, 1);
  assert.equal(some.entries[0].id, 'cairo');
  assert.equal(StoreFB.GOVERNORATES_27.length, 27);
});

// ---- Line availability (out-of-stock rule) ----
test('lineAvailability: ok / out / short with the available count', () => {
  const avail = StoreFB.lineAvailability;
  assert.deepEqual(avail(10, 2), { state: 'ok', availableQty: 10 });
  assert.deepEqual(avail(2, 2), { state: 'ok', availableQty: 2 });
  assert.deepEqual(avail(0, 1), { state: 'out', availableQty: 0 });
  assert.deepEqual(avail(1, 3), { state: 'short', availableQty: 1 });
  assert.deepEqual(avail(-1, 1), { state: 'out', availableQty: 0 });
});

// ---- Journey: dwell bands, 20-entry cap, action labels ----
test('dwellBand: <10s / 10-60s / >60s', () => {
  const band = StoreFB.dwellBand;
  assert.equal(band(0), '<10s');
  assert.equal(band(9), '<10s');
  assert.equal(band(10), '10-60s');
  assert.equal(band(60), '10-60s');
  assert.equal(band(61), '>60s');
  assert.equal(band(3600), '>60s');
});

test('capJourneyEntries: first 20 win, the rest counted as overflow', () => {
  const cap = StoreFB.capJourneyEntries;
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ productId: 'p' + i }));
  assert.equal(cap(mk(19)).entries.length, 19);
  assert.equal(cap(mk(19)).overflowCount, 0);
  const twenty = cap(mk(20));
  assert.equal(twenty.entries.length, 20);
  assert.equal(twenty.overflowCount, 0);
  const many = cap(mk(25));
  assert.equal(many.entries.length, 20);
  assert.equal(many.overflowCount, 5);
  assert.equal(many.entries[0].productId, 'p0'); // oldest kept
  assert.equal(many.entries[19].productId, 'p19');
});

test('journeyActionLabel: Arabic labels, unknown actions pass through as plain text', () => {
  const label = StoreFB.journeyActionLabel;
  assert.equal(label('view'), 'شاف المنتج');
  assert.equal(label('add'), 'ضاف للسلة');
  assert.equal(label('checkout_start'), 'بدأ الطلب');
  assert.equal(label('something_new'), 'something_new');
  assert.equal(StoreFB.JOURNEY_SCHEMA_VERSION, 1);
});

// ---- Egyptian mobile validation (shared with the storefront) ----
test('isValidEgyptianMobile: 01… numbers only, +20 folds to 01…', () => {
  const valid = StoreFB.isValidEgyptianMobile;
  assert.equal(valid('01012345678'), true);
  assert.equal(valid('01112345678'), true);
  assert.equal(valid('01212345678'), true);
  assert.equal(valid('01512345678'), true);
  assert.equal(valid('+201012345678'), true);
  assert.equal(valid('201012345678'), true);
  assert.equal(valid('010 1234 5678'), true);
  assert.equal(valid('01312345678'), false); // 013 is not a mobile prefix
  assert.equal(valid('0101234567'), false); // too short
  assert.equal(valid('010123456789'), false); // too long
  assert.equal(valid(''), false);
  assert.equal(valid(null), false);
  assert.equal(StoreFB.normalizeEgyptianMobile('+201012345678'), '01012345678');
});
