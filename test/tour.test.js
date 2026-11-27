// Tests for the first-run onboarding tour — step inventory in
// tour.js plus structural checks that index.html wires the engine
// in. No Firebase, no network, no DOM (page/selector coverage is
// verified against the real index.html text).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const Tour = require(path.join(__dirname, '..', 'tour.js'));
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// All real pages in the app, from the page containers.
const pageIds = [...new Set([...html.matchAll(/id="pg-([a-z-]+)"/g)].map((m) => m[1]))];

test('tour inventory: the app really has 20 pages', () => {
  assert.equal(pageIds.length, 20);
  for (const p of ['dashboard', 'sales', 'customers', 'orders', 'incomplete', 'templates',
    'feedback', 'website-products', 'website-categories', 'website-homepage',
    'website-preview', 'purchases', 'suppliers', 'inventory',
    'returns', 'profits', 'expenses', 'settings', 'activitylog', 'team']) {
    assert.ok(pageIds.includes(p), 'missing page ' + p);
  }
});

test('tour steps cover EVERY page exactly once, plus chrome steps', () => {
  const covered = Tour.TOUR_STEPS.map((s) => s.page);
  for (const p of pageIds) {
    if (p === 'dashboard') continue; // chrome steps reuse it — checked below
    const n = covered.filter((x) => x === p).length;
    assert.equal(n, 1, 'page ' + p + ' covered ' + n + ' times, expected 1');
  }
  // Chrome steps (welcome / sidebar / top bar / stats / FAB / done) reuse dashboard.
  assert.equal(covered.filter((x) => x === 'dashboard').length, 6);
  assert.equal(Tour.TOUR_STEPS.length, 25);
});

test('every step has a real target: page exists, selector id exists in index.html', () => {
  for (const s of Tour.TOUR_STEPS) {
    assert.ok(pageIds.includes(s.page), 'step "' + s.title + '" page ' + s.page + ' is not a real page');
    assert.equal(typeof s.title, 'string');
    assert.ok(s.title.trim().length > 0);
    assert.equal(typeof s.text, 'string');
    assert.ok(s.text.trim().length > 20, 'step "' + s.title + '" copy is too short');
    assert.ok(s.sel.startsWith('#'), 'step "' + s.title + '" selector must be an id selector');
    const firstId = s.sel.split(' ')[0].slice(1);
    assert.ok(html.includes('id="' + firstId + '"'), 'step "' + s.title + '" target #' + firstId + ' not in index.html');
    // Page steps highlight the page header, which every page has.
    if (s.sel.includes('.pg-hd')) {
      const chunk = html.split('id="pg-' + s.page + '"')[1].split('id="pg-')[0];
      assert.ok(chunk.includes('pg-hd'), 'page ' + s.page + ' has no .pg-hd for the step to highlight');
    }
  }
});

test('gated steps are exactly the store-login pages', () => {
  assert.deepEqual([...Tour.TOUR_GATED_PAGES].sort(), ['feedback', 'incomplete', 'templates']);
  for (const s of Tour.TOUR_STEPS) {
    if (Tour.TOUR_GATED_PAGES.includes(s.page)) assert.equal(s.gated, true, s.page + ' must be gated');
    else assert.equal(s.gated, undefined, s.page + ' must not be gated');
  }
  assert.ok(Tour.TOUR_GATED_NOTE.includes('تسجيل دخول المتجر'));
});

test('first-run storage: shows until marked done, then never again', () => {
  const store = {};
  const fake = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); }
  };
  assert.equal(Tour.shouldShowTour(fake), true);
  assert.equal(Tour.isTourDone(fake), false);
  Tour.markTourDone(fake);
  assert.equal(store[Tour.TOUR_KEY], '1');
  assert.equal(Tour.shouldShowTour(fake), false);
  assert.equal(Tour.isTourDone(fake), true);
  // A throwing storage (private mode) never crashes the check.
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.equal(Tour.shouldShowTour(broken), true);
  Tour.markTourDone(broken); // no throw
});

test('index.html wires the tour engine in', () => {
  assert.ok(html.includes('<script src="tour.js"></script>'));
  assert.ok(html.includes('id="tourOverlay"'));
  assert.ok(html.includes('id="tourRing"'));
  assert.ok(html.includes('id="tourCard"'));
  // Skip on every step: one Skip button, rendered on each step card.
  assert.ok(html.includes('onclick="tourSkip()"'));
  assert.ok(html.includes('تخطي'));
  // "Don't show again" checkbox on the card.
  assert.ok(html.includes('id="tourNever"'));
  assert.ok(html.includes('متعرضش الجولة دي تاني'));
  // Next / Previous / dots navigation.
  assert.ok(html.includes('onclick="tourNext()"'));
  assert.ok(html.includes('onclick="tourPrev()"'));
  assert.ok(html.includes('id="tourDots"'));
  // First-run auto-show hook at boot + restart from Settings.
  assert.ok(html.includes('setTimeout(maybeShowTour,1500)'));
  assert.ok(html.includes('function maybeShowTour()'));
  assert.ok(html.includes('onclick="startTour(true)"'));
  assert.ok(html.includes('الجولة التعريفية'));
  // Auto-show waits for the daily-summary modal to close first.
  assert.ok(html.includes("if(sum&&!sum.classList.contains('hidden'))"));
  // Engine never navigates a gated page while logged out (no stray toast).
  assert.ok(html.includes('const gatedBlocked=st.gated && !tourStoreConnected();'));
});
