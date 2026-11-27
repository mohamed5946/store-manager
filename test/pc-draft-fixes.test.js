// Audit fix-pass tests (2026-11-27) for the PC admin list/detail
// wiring that lives in index.html, not in the module: the page is
// asserted as text (same pattern as test/tour.test.js), and the
// tour-seeding helper is unit-tested directly. No Firebase, no DOM.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const fbSrc = fs.readFileSync(path.join(__dirname, '..', 'firebase-store.js'), 'utf8');
const Tour = require(path.join(__dirname, '..', 'tour.js'));

function fakeStorage(initial) {
  const store = { ...(initial || {}) };
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    _store: store
  };
}

// ---- B2: triage filter in the PC admin list ----
test('B2: the list hides below-minimum drafts, keeps dedup + status filter, closed records stay', () => {
  // The renderer applies the triage predicate after dedup.
  assert.ok(html.includes("list=list.filter(function(d){const stt=d.status||'new'; return stt==='converted'||stt==='dead'||draftIsCallable(d);});"),
    'rIncompleteOrders must triage-filter the list');
  assert.ok(html.includes('if(F&&F.dedupDraftsByPhone) list=F.dedupDraftsByPhone(list);'),
    'dedup must still run before triage');
  assert.ok(html.includes("if(filt) list=list.filter(function(d){return (d.status||'new')===filt;});"),
    'status filter must still apply after triage');
  // Closed records are carved out: a dead draft stays visible as a
  // closed record (CUJ 2), a converted one as history.
  assert.ok(html.includes("stt==='converted'||stt==='dead'||draftIsCallable(d)"),
    'converted/dead drafts must not be triage-hidden');
  // The list helper exists and prefers the factory predicate.
  assert.ok(html.includes('function draftIsCallable(d){'), 'index.html must define draftIsCallable');
  assert.ok(html.includes('if(F&&F.draftIsCallable) return F.draftIsCallable(d);'),
    'the list helper must use the factory predicate when available');
  // Badge + status line count the visible (triaged) drafts, not all.
  assert.ok(html.includes("return (d.status||'new')==='new'&&draftIsCallable(d);"),
    'the new badge must count callable new leads only');
  assert.ok(html.includes("const newCount=list.filter(function(d){return (d.status||'new')==='new';}).length;"),
    'the status line must count from the triaged list');
  assert.ok(!html.includes("const newCount=storeDrafts.filter(function(d){return (d.status||'new')==='new';}).length;"),
    'the status line must no longer count unfiltered storeDrafts');
});

test('B2: factory draftIsCallable is exported for the list', () => {
  assert.ok(fbSrc.includes('draftIsCallable: draftIsCallable,'), 'firebase-store.js must export draftIsCallable');
});

// ---- B3: mark-dead action ----
test('B3: the detail view offers mark-dead, wired to updateDraftStatus with dead', () => {
  assert.ok(html.includes("onclick=\"markDraftDead('${d.id}')\""), 'detail must have a mark-dead button');
  assert.ok(html.includes('إغلاق كملغاة'), 'the button must be labelled as closing dead');
  assert.ok(html.includes('function markDraftDead(id){'), 'markDraftDead must exist');
  assert.ok(html.includes("await setDraftStatus(id,'dead');"), 'mark-dead must close via setDraftStatus dead');
  assert.ok(html.includes("await fb.updateDraftStatus(id,to);"), 'setDraftStatus must call updateDraftStatus');
  // The button sits inside the non-terminal block (no mark-dead on a
  // closed draft) and Delete stays a separate action.
  const detailBtns = html.split("onclick=\"markDraftDead(")[0];
  assert.ok(detailBtns.includes("onclick=\"setDraftStatus('${d.id}','contacted')\""), 'contacted button still present');
  assert.ok(html.includes("onclick=\"deleteDraftCard('${d.id}')\""), 'Delete stays a separate action');
  // The dead record stays visible: see the B2 carve-out above, and
  // the dead status still renders its badge.
  assert.ok(html.includes("dead:'ملغاة'"), 'dead status label still exists');
});

// ---- B4: quota Save no longer throws ----
test('B4: setQuotaCutoff is defined and exported; Settings Save calls it', () => {
  assert.ok(fbSrc.includes('function setQuotaCutoff(cutoffLevel) {'), 'firebase-store.js must define setQuotaCutoff');
  assert.ok(fbSrc.includes('setQuotaCutoff: setQuotaCutoff,'), 'the instance must export setQuotaCutoff');
  assert.ok(fbSrc.includes("writes: { 'storeSettings/quota': { cutoffLevel: level } }"),
    'setQuotaCutoff must write the quota doc');
  assert.ok(html.includes('await fb.setQuotaCutoff(cutoff);'), 'saveQuotaSettings must call fb.setQuotaCutoff');
});

// ---- B5: moot badge field fix + link ----
test('B5: moot lookup uses the draft phone field, and the badge links to the real order', () => {
  assert.ok(html.includes('const d=list.find(function(x){return x.phone===ph;});'),
    'moot lookup must match drafts on phone');
  assert.ok(!html.includes('x.customerPhone===ph'), 'no moot lookup may use customerPhone on a draft');
  // List badge is a button opening the real order.
  assert.ok(html.includes("onclick=\"showStoreOrderDetail('${moot}')\""),
    'the list moot badge must link to the order');
  assert.ok(html.includes('طلب قبل كده</button>'), 'the list moot badge must be a button, not plain text');
  // Detail line links to the same order with its short id.
  assert.ok(html.includes("const mootId=draftMootByPhone[d.phone||'']||'';"),
    'detail must read the moot order id from draftMootByPhone');
  assert.ok(html.includes("onclick=\"showStoreOrderDetail('${mootId}')\""),
    'the detail moot line must link to the order');
  assert.ok(!html.includes("${draftMootByPhone[d.phone||'']?' · العميل طلب قبل كده من الموقع':''}"),
    'the detail moot line must no longer be plain text');
});

// ---- D6: journey total as the dwell band ----
test('D6: journey total time shows the dwell band, not raw seconds', () => {
  assert.ok(html.includes('const totalBand=F&&F.dwellBand?F.dwellBand(j.totalSeconds||0)'),
    'showJourneyDialog must band the total visit time');
  assert.ok(html.includes('<div>مدة الزيارة: <b>${totalBand}</b>'), 'the dialog must render the band');
  assert.ok(!html.includes("<b>${j.totalSeconds||0} ثانية</b>"),
    'raw totalSeconds must no longer render');
});

// ---- D8: runDraftDeletion toast — verified behaviour ----
test('D8: the deletion toast fires only when drafts were actually deleted', () => {
  // The audit rider as written does not reproduce in the PC code:
  // the toast is already gated on deleted > 0 (and not skipped).
  // Pin that behaviour so a future "always toast" change is caught.
  assert.ok(html.includes('if(res&&!res.skipped&&res.deleted>0){'),
    'runDraftDeletion must toast only when deleted > 0');
});

// ---- Tour seeding for existing installs ----
test('tour seeding: existing local state marks the tour done, fresh installs still get it', () => {
  assert.equal(typeof Tour.seedTourDoneForExistingInstall, 'function');
  // Cached store role — the install signed in before.
  const withRole = fakeStorage({ sb_store_role: JSON.stringify({ uid: 'u1', role: 'admin' }) });
  assert.equal(Tour.seedTourDoneForExistingInstall(withRole), true);
  assert.equal(withRole._store[Tour.TOUR_KEY], '1');
  assert.equal(Tour.shouldShowTour(withRole), false);
  // Saved logo / local data / saved store email also count.
  for (const key of ['sb_logo', 'smartbulse_v1', 'sb_store_email', 'sb_actlog_v1']) {
    const s = fakeStorage({ [key]: 'x' });
    assert.equal(Tour.seedTourDoneForExistingInstall(s), true, key + ' must seed');
    assert.equal(Tour.shouldShowTour(s), false);
  }
  // Truly fresh install: nothing seeded, tour still shows.
  const fresh = fakeStorage({});
  assert.equal(Tour.seedTourDoneForExistingInstall(fresh), false);
  assert.equal(Tour.shouldShowTour(fresh), true);
  // Already done: no-op, returns false.
  const done = fakeStorage({ [Tour.TOUR_KEY]: '1', sb_store_role: '{}' });
  assert.equal(Tour.seedTourDoneForExistingInstall(done), false);
  // Throwing storage never crashes.
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.equal(Tour.seedTourDoneForExistingInstall(broken), false);
});

test('tour seeding: maybeShowTour seeds before the first auto-show; manual restart still works', () => {
  assert.ok(html.includes('Tour.seedTourDoneForExistingInstall(localStorage);'),
    'maybeShowTour must seed for existing installs');
  const idxSeed = html.indexOf('Tour.seedTourDoneForExistingInstall(localStorage);');
  const idxCheck = html.indexOf('if(!Tour.shouldShowTour(localStorage))');
  assert.ok(idxSeed !== -1 && idxCheck !== -1 && idxSeed < idxCheck,
    'seeding must run before the shouldShowTour check');
  assert.ok(html.includes('onclick="startTour(true)"'), 'manual restart from Settings must still exist');
});
