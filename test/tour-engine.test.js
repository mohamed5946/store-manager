// Functional test for the onboarding-tour ENGINE as it ships in
// index.html: the engine block is extracted from the real file and
// run against a stub DOM (no browser, no Electron). Covers first-run
// auto-show, step navigation, the gated-page fallback, Skip,
// "don't show again", and Escape.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const Tour = require(path.join(__dirname, '..', 'tour.js'));
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const ENGINE_START = '// ONBOARDING TOUR — first-run overlay guide';
const ENGINE_END = '// RIPPLE EFFECT';
const engineCode = html.slice(html.indexOf(ENGINE_START), html.indexOf(ENGINE_END));
assert.ok(engineCode.length > 500, 'tour engine block not found in index.html');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeClassList(initial) {
  const set = new Set(initial || []);
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    _set: set
  };
}
function makeEl(id, rect) {
  return {
    id,
    classList: makeClassList(['hidden']),
    style: {},
    textContent: '',
    innerHTML: '',
    offsetHeight: 200,
    checked: false,
    scrollIntoViewCalled: 0,
    getBoundingClientRect: () => rect || { top: 100, left: 200, width: 300, height: 40, bottom: 140, right: 500 },
    scrollIntoView: function () { this.scrollIntoViewCalled++; }
  };
}

// Fresh stub-DOM world per test; returns the vm context + spies.
function makeWorld({ tourDone = false, summaryOpen = false, storeConnected = false } = {}) {
  const store = tourDone ? { [Tour.TOUR_KEY]: '1' } : {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); }
  };
  const els = {};
  const pageIds = [...new Set([...html.matchAll(/id="pg-([a-z-]+)"/g)].map((m) => m[1]))];
  for (const p of pageIds) els['pg-' + p] = makeEl('pg-' + p);
  els['pg-dashboard'].classList.remove('hidden'); // boot lands on dashboard
  for (const id of ['tourOverlay', 'tourRing', 'tourCard', 'tourStepNo', 'tourTitle', 'tourText',
    'tourNever', 'tourPrevBtn', 'tourNextBtn', 'tourDots', 'mDailySummary',
    'dStats', 'sb', 'tb', 'fabBtn']) els[id] = makeEl(id);
  els.tourOverlay.classList.add('hidden');
  if (!summaryOpen) els.mDailySummary.classList.add('hidden');
  else els.mDailySummary.classList.remove('hidden');
  const navCalls = [];
  const ctx = {
    console,
    setTimeout, clearTimeout,
    localStorage,
    Tour,
    navCalls,
    nav: (p) => {
      navCalls.push(p);
      for (const key of Object.keys(els)) {
        if (key.startsWith('pg-')) els[key].classList.add('hidden');
      }
      if (els['pg-' + p]) els['pg-' + p].classList.remove('hidden');
    },
    keyHandlers: {},
    document: {
      getElementById: (id) => els[id] || null,
      querySelector: (sel) => {
        const m = sel.match(/^\.ni\[data-p="([a-z-]+)"\]$/);
        if (m) return makeEl('ni-' + m[1], { top: 300, left: 10, width: 180, height: 36, bottom: 336, right: 190 });
        if (sel.includes('.pg-hd')) {
          const page = sel.split(' ')[0].slice(4);
          return makeEl('pg-' + page + '-hd', { top: 80, left: 250, width: 700, height: 60, bottom: 140, right: 950 });
        }
        if (sel.startsWith('#')) return els[sel.slice(1)] || null;
        return null;
      },
      addEventListener: function (type, fn) { ctx.keyHandlers[type] = fn; }
    },
    window: null // set below to the context itself
  };
  ctx.$ = (id) => ctx.document.getElementById(id);
  ctx.window = ctx;
  ctx.window.Tour = Tour;
  ctx.window.StoreFB = storeConnected ? { state: { connected: true } } : undefined;
  ctx.window.addEventListener = () => {};
  ctx.window.innerWidth = 1280;
  ctx.window.innerHeight = 800;
  vm.createContext(ctx);
  vm.runInContext(engineCode, ctx);
  return { ctx, els, store, navCalls, localStorage };
}

test('engine: first run shows step 1 on the dashboard, ring positioned', async () => {
  const { ctx, els } = makeWorld();
  vm.runInContext('maybeShowTour()', ctx);
  await sleep(400);
  assert.equal(els.tourOverlay.classList.contains('hidden'), false);
  assert.equal(els.tourStepNo.textContent, 'خطوة 1 من 25');
  assert.equal(els.tourTitle.textContent, 'أهلاً بيك في Store Manager');
  assert.ok(els.tourRing.style.top !== '' && els.tourRing.style.width !== '');
  assert.ok(els.tourDots.innerHTML.includes('tourGoTo(0)'));
  assert.ok(els.tourDots.innerHTML.includes('tourGoTo(24)'));
});

test('engine: Next walks steps and navigates pages; Skip ends + marks done', async () => {
  const { ctx, els, navCalls, store } = makeWorld();
  vm.runInContext('startTour(true)', ctx);
  await sleep(300);
  vm.runInContext('tourNext()', ctx); // step 2: sidebar
  await sleep(300);
  assert.equal(els.tourTitle.textContent, 'القايمة الجانبية');
  vm.runInContext('tourGoTo(4)', ctx); // step 5: sales page
  await sleep(400);
  assert.ok(navCalls.includes('sales'), 'expected nav(sales), got ' + navCalls.join(','));
  assert.equal(els.tourTitle.textContent, 'فواتير البيع');
  assert.equal(els['pg-sales'].classList.contains('hidden'), false);
  vm.runInContext('tourSkip()', ctx);
  await sleep(100);
  assert.equal(els.tourOverlay.classList.contains('hidden'), true);
  assert.equal(store[Tour.TOUR_KEY], '1');
  assert.ok(navCalls[navCalls.length - 1] === 'dashboard', 'Skip returns to dashboard');
});

test('engine: gated page while logged out highlights the sidebar item, never navs', async () => {
  const { ctx, els, navCalls } = makeWorld({ storeConnected: false });
  vm.runInContext('startTour(true)', ctx);
  await sleep(300);
  vm.runInContext('tourGoTo(7)', ctx); // step 8: incomplete (gated)
  await sleep(400);
  assert.ok(!navCalls.includes('incomplete'), 'must not nav to a gated page while logged out');
  assert.equal(els.tourTitle.textContent, 'طلبات ناقصة');
  assert.ok(els.tourText.textContent.includes('تسجيل دخول المتجر'));
  assert.ok(els.tourRing.style.top !== '');
});

test('engine: gated page while logged in navigates normally', async () => {
  const { ctx, els, navCalls } = makeWorld({ storeConnected: true });
  vm.runInContext('startTour(true)', ctx);
  await sleep(300);
  vm.runInContext('tourGoTo(7)', ctx);
  await sleep(400);
  assert.ok(navCalls.includes('incomplete'));
  assert.ok(!els.tourText.textContent.includes('تسجيل دخول المتجر'));
});

test('engine: done flag suppresses auto-show; open summary delays it', async () => {
  const done = makeWorld({ tourDone: true });
  vm.runInContext('maybeShowTour()', done.ctx);
  await sleep(400);
  assert.equal(done.els.tourOverlay.classList.contains('hidden'), true);

  const waiting = makeWorld({ summaryOpen: true });
  vm.runInContext('maybeShowTour()', waiting.ctx);
  await sleep(400);
  assert.equal(waiting.els.tourOverlay.classList.contains('hidden'), true, 'must wait for the summary modal');
  waiting.els.mDailySummary.classList.add('hidden'); // user closes the summary
  await sleep(1300);
  assert.equal(waiting.els.tourOverlay.classList.contains('hidden'), false, 'starts after the summary closes');
});

test('engine: "don\'t show again" checkbox and Escape both end + mark done', async () => {
  const { ctx, els, store } = makeWorld();
  vm.runInContext('startTour(true)', ctx);
  await sleep(300);
  els.tourNever.checked = true;
  vm.runInContext('tourNext()', ctx); // checkbox ends the tour immediately
  await sleep(100);
  assert.equal(els.tourOverlay.classList.contains('hidden'), true);
  assert.equal(store[Tour.TOUR_KEY], '1');

  const w2 = makeWorld();
  vm.runInContext('startTour(true)', w2.ctx);
  await sleep(300);
  w2.ctx.keyHandlers.keydown({ key: 'Escape' });
  await sleep(100);
  assert.equal(w2.els.tourOverlay.classList.contains('hidden'), true);
  assert.equal(w2.store[Tour.TOUR_KEY], '1');
});

test('engine: last step finishes the tour', async () => {
  const { ctx, els, store } = makeWorld();
  vm.runInContext('startTour(true)', ctx);
  await sleep(300);
  vm.runInContext('tourGoTo(24)', ctx);
  await sleep(300);
  assert.equal(els.tourTitle.textContent, 'خلصت الجولة');
  assert.equal(els.tourNextBtn.textContent, 'إنهاء');
  vm.runInContext('tourNext()', ctx);
  await sleep(100);
  assert.equal(els.tourOverlay.classList.contains('hidden'), true);
  assert.equal(store[Tour.TOUR_KEY], '1');
});
