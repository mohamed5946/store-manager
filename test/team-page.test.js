// Team page tests (1.1.5): a read-only "الفريق" page listing every
// registered user with access (name, email, mobile, role), sourced from
// the admins collection like the mobile app's team tab. No Firebase,
// no DOM: the page is asserted as text (same pattern as
// test/pc-draft-fixes.test.js).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const fbSrc = fs.readFileSync(path.join(__dirname, '..', 'firebase-store.js'), 'utf8');

// ---- Sidebar + page exist under الإدارة ----
test('team: sidebar item under الإدارة and a pg-team page with the list table', () => {
  assert.ok(html.includes('data-p="team"'), 'the sidebar must have a الفريق item');
  assert.ok(html.includes('<span class="ni-lbl">الفريق</span>'), 'the sidebar item must be labelled الفريق');
  assert.ok(html.includes('id="pg-team"'), 'the team page must exist');
  assert.ok(html.includes('id="teamList"'), 'the team table body must exist');
  for (const col of ['الاسم', 'البريد', 'الهاتف', 'الدور']) {
    assert.ok(html.includes('<th>' + col + '</th>'), 'the team table must have a ' + col + ' column');
  }
});

// ---- Wiring: nav guard, showPage dispatch, live subscription ----
test('team: wired into nav, showPage, and the store subscriptions', () => {
  assert.ok(html.includes("p==='team'") && html.includes("if((p==='templates'||p==='feedback'||p==='incomplete'||p==='team')"),
    'the team page must require the store connection like the other store pages');
  assert.ok(html.includes('team:rTeam'), 'showPage must render the team page on navigation');
  assert.ok(html.includes('fb.subscribeTeam(function(list,err){'),
    'the team list must stay live through a store subscription');
  assert.ok(html.includes('let teamMembers=[], teamDenied=false;'),
    'the team list state must exist');
});

// ---- Renderer: reads admins docs, honest when data is missing or denied ----
test('team: rTeam renders name/email/phone/role and handles empty + denied states', () => {
  assert.ok(html.includes('function rTeam(){'), 'rTeam must exist');
  assert.ok(html.includes("escHtml(nm||'—')"),
    'a member with no name yet must show —, never an invented name');
  assert.ok(html.includes("escHtml(m.email||'—')"), 'the email column must render the doc email');
  assert.ok(html.includes("escHtml(m.phone||'—')"), 'the mobile column must render the doc phone');
  assert.ok(html.includes("m.role==='admin'?'أدمن':(m.role==='manager'?'مدير':'—')"),
    'the role column must render أدمن/مدير from the doc role');
  assert.ok(html.includes("es(icOrDot('users'),'مفيش أعضاء فريق لسه')"),
    'an empty team must show the mobile app’s empty state');
  assert.ok(html.includes("es(icOrDot('lock'),'عرض الفريق متاح لحساب الأدمن فقط')"),
    'a manager login (list denied by the rules) must see the admin-only note');
});

// ---- Data layer: subscribeTeam reads the admins collection ----
test('team: subscribeTeam lists the admins collection', () => {
  assert.ok(fbSrc.includes('function subscribeTeam(cb) {'),
    'firebase-store.js must define subscribeTeam');
  assert.ok(fbSrc.includes("return _subscribe(db().collection('admins'), cb);"),
    'subscribeTeam must list the admins collection (doc id = Auth uid)');
  assert.ok(fbSrc.includes('subscribeTeam: subscribeTeam,'),
    'subscribeTeam must be exposed on the StoreFB API');
});
