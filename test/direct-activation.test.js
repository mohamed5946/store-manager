// Direct template activation tests (1.1.5, Mohamed's decision 2026-11-27):
// activating a template works directly from draft or preview — no D1
// approval, no preview step required. Preview + approval stay as
// optional buttons. No Firebase, no DOM: the page and the store module
// are asserted as text (same pattern as test/account-panel.test.js);
// the activation behaviour itself is proven in test/templates.test.js.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const fbSrc = fs.readFileSync(path.join(__dirname, '..', 'firebase-store.js'), 'utf8');

function cardLine(status) {
  const line = html.split('\n').find((l) => l.includes(`if(status==='${status}')`) || l.includes(`else if(status==='${status}')`));
  assert.ok(line, `the ${status} card-actions line must exist`);
  return line;
}

// ---- The activate button exists on draft + preview cards ----
test('cards: draft and preview cards show the "تفعيل على الموقع" button', () => {
  assert.ok(cardLine('draft').includes('activateStoreTemplate'), 'draft card must offer direct activation');
  assert.ok(cardLine('preview').includes('activateStoreTemplate'), 'preview card must offer direct activation');
  assert.ok(cardLine('preview').includes('approveStoreTemplate'), 'preview card must KEEP the optional اعتماد button');
  assert.ok(cardLine('preview').includes('openTemplatePreview'), 'preview card must KEEP the optional معاينة button');
  assert.ok(cardLine('draft').includes('moveTemplateToPreview'), 'draft card must KEEP the optional تحقق وانقل للمعاينة button');
});

// ---- The card validity report uses the registry check, not the full-manifest validator ----
test('tplCardReport: bundle cards use the six-field registry check', () => {
  assert.ok(html.includes('return F.validateRegistryManifest(t,t.id);'),
    'bundle cards must validate with the registry check');
  assert.ok(!html.includes('return F.validateTemplateBundle(m,null,t.id);'),
    'the full-manifest validator must never run on registry data (it always fails there and kept every activate button disabled)');
});

// ---- The quick-activate select lists every activatable template ----
test('quick activate: select lists draft/preview/approved/active, message has no "معتمد" gate', () => {
  assert.ok(html.includes("t.status==='draft'||t.status==='preview'||t.status==='approved'||t.status==='active'"),
    'the quick-activate select must list draft + preview templates too');
  assert.ok(html.includes("اختار قالب الأول."), 'the quick-activate empty message must not demand an approved template');
  assert.ok(!html.includes('اختار قالب معتمد الأول.'), 'no "approved first" message may remain');
  assert.ok(!html.includes('لا يوجد قالب معتمد'), 'no "no approved template" empty state may remain');
  assert.ok(html.includes('التفعيل من هنا مباشر'), 'the quick card note must say activation is direct');
});

// ---- activateTemplate has no approval gate; demotion is honest ----
test('firebase-store: activateTemplate has no approval gate; demotion never fabricates an approval', () => {
  assert.ok(!fbSrc.includes('القالب لسه مش معتمد'),
    'the "not approved yet" rejection must be gone from activation');
  assert.ok(!fbSrc.includes('checkApprovalFreeze(data)'),
    'the approval-freeze check must not gate activation');
  assert.ok(fbSrc.includes('Direct activation (2026-11-27'),
    'the direct-activation decision must be recorded at the gate site');
  assert.ok(fbSrc.includes("var demoted = (prev.approval && typeof prev.approval === 'object') ? 'approved' : 'preview';"),
    'demotion must return an unapproved template to preview, never to a false approved');
});
