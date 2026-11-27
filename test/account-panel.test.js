// Account panel tests (1.1.5): the sidebar user chip opens the account
// modal, the display name + mobile are editable and persisted per account,
// and the chip shows name + phone instead of email + role. No Firebase,
// no DOM: the page is asserted as text (same pattern as
// test/pc-draft-fixes.test.js); the phone normalizer is unit-tested
// directly through the factory export.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const fbSrc = fs.readFileSync(path.join(__dirname, '..', 'firebase-store.js'), 'utf8');
const StoreFB = require(path.join(__dirname, '..', 'firebase-store.js'));

// ---- The chip is clickable and shows name + phone, not email + role ----
test('chip: clickable, shows display name on line 1 and mobile on line 2', () => {
  assert.ok(html.includes('id="sbUserChip" onclick="openAccountM()"'),
    'the sidebar user chip must open the account modal on click');
  assert.ok(html.includes('id="sbUserName"'), 'chip line 1 (display name) must exist');
  assert.ok(html.includes('id="sbUserPhone"'), 'chip line 2 (mobile) must exist');
  assert.ok(!html.includes('sbUserRole'),
    'the old role line must be gone — the chip shows name + phone, not email + role');
});

// ---- The account modal exists, with editable name/phone, read-only email/role ----
test('modal: mAccount with editable name + phone, read-only email + role, live buttons', () => {
  assert.ok(html.includes('id="mAccount"'), 'the account modal must exist');
  assert.ok(html.includes('id="accName"'), 'editable display-name field must exist');
  assert.ok(html.includes('id="accPhone"'), 'editable mobile field must exist');
  assert.ok(html.includes('id="accEmail" readonly'), 'email must be read-only');
  assert.ok(html.includes('id="accRole" readonly'), 'role must be read-only');
  assert.ok(html.includes("onclick=\"closeM('mAccount')\""), 'Cancel must close the modal');
  assert.ok(html.includes('onclick="saveAccount()"'), 'Save must call saveAccount()');
});

// ---- The chip renders from the per-account profile, avatar follows the name ----
test('renderStoreUserCard: reads the per-account profile, avatar follows the name', () => {
  assert.ok(html.includes('const prof=getAccProfile(email);'),
    'the chip must render from the per-account profile, not the raw email');
  assert.ok(html.includes("$('sbUserName').textContent=prof.name||email;"),
    'chip line 1 must show the display name (falling back to the email)');
  assert.ok(html.includes("$('sbUserPhone').textContent=prof.phone||'أضف رقم الموبايل';"),
    'chip line 2 must show the mobile, with a hint when none is saved yet');
  assert.ok(html.includes("$('sbUserAv').textContent=(prof.name||email||'S').charAt(0).toUpperCase();"),
    'the avatar initial must follow the display name');
});

// ---- Saving persists per account (localStorage) and syncs the admins doc ----
test('saveAccount: persists to localStorage per account and syncs the admins doc', () => {
  assert.ok(html.includes("function getAccProfile(email){"),
    'getAccProfile must exist');
  assert.ok(html.includes("'sb_profile_' + String(email || '').toLowerCase()"),
    'the profile must be keyed per account (email) in localStorage');
  assert.ok(html.includes("localStorage.setItem(accProfileKey(email), JSON.stringify({ name: prof.name || 'محمد', phone: prof.phone || '' }))"),
    'saving must persist name + phone to localStorage');
  assert.ok(html.includes('window.StoreFB.saveAccountProfile({ name: name, phone: phone, prevPhone: prev.phone || \'\' })'),
    'saving must also sync the admins/{uid} doc (best-effort)');
  assert.ok(fbSrc.includes('saveAccountProfile: saveAccountProfile,'),
    'firebase-store.js must expose saveAccountProfile on the StoreFB API');
  assert.ok(fbSrc.includes("db().collection('admins').doc(st.user.uid).set({ name: name, phone: phone }, { merge: true })"),
    'the sync must merge name + phone into the signed-in admin doc');
});

// ---- Phone normalizer matches the mobile app (lib/core/identifier.dart) ----
test('normalizeEgyptPhone: 01… / +20… / 10-digit forms all map to 20…', () => {
  const norm = StoreFB.normalizeEgyptPhone;
  assert.equal(typeof norm, 'function', 'the normalizer must be exported on the factory');
  assert.equal(norm('01557887719'), '201557887719');
  assert.equal(norm('+201557887719'), '201557887719');
  assert.equal(norm('00201557887719'), '201557887719');
  assert.equal(norm('1557887719'), '201557887719');
  assert.equal(norm('0155 788 7719'), '201557887719');
  assert.equal(norm('0155-788-7719'), '201557887719');
  assert.equal(norm('01001234567'), '201001234567');
  assert.equal(norm('123'), null, 'a short number is not a plausible Egyptian mobile');
  assert.equal(norm(''), null, 'an empty number normalizes to null');
  assert.equal(norm('99999999999'), null, 'an 11-digit number not starting 01 is invalid');
});
