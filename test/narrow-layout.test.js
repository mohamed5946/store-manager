// Narrow-page regression test (1.1.5): every page must live inside #mn.
//
// Root cause of the 1.1.5 narrow bug: an extra </div> after the dashboard
// closed #mn early, so all pages except the dashboard became direct flex
// children of #app and shrank to content width (~35% of the window).
// The CSS was always full-width — the DOM nesting was broken. This test
// pins the nesting: every pg-* div must have ancestors ['app', 'mn'],
// and #app must have exactly two children (#sb, #mn).
// No Firebase, no DOM: index.html is parsed as text (same pattern as
// test/account-panel.test.js). Only the markup before the first <script>
// is parsed, so JS template strings cannot corrupt the div stack.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
// Strip every <script> block (the head has one at line 915, before #app)
// and every HTML comment, so JS template strings cannot corrupt the
// div stack; the remaining markup is the real page structure.
const markup = html
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/<!--[\s\S]*?-->/g, '');

function parseDivNesting(src) {
  const tagRe = /<div\b[^>]*>|<\/div>/g;
  const stack = [];
  const pages = {};
  const appChildren = [];
  let m;
  while ((m = tagRe.exec(src)) !== null) {
    const tag = m[0];
    if (tag === '</div>') {
      stack.pop();
    } else {
      const idMatch = tag.match(/\bid="([^"]+)"/);
      const id = idMatch ? idMatch[1] : null;
      if (stack.length === 1 && stack[0] === 'app' && id) appChildren.push(id);
      if (id && id.startsWith('pg-')) pages[id] = [...stack];
      stack.push(id);
    }
  }
  return { pages, appChildren, stack };
}

test('narrow layout: every pg-* page is inside #mn (ancestors app > mn)', () => {
  const { pages, stack } = parseDivNesting(markup);
  assert.ok(Object.keys(pages).length >= 20, `expected 20+ pages, found ${Object.keys(pages).length}`);
  assert.deepEqual(stack, [], 'the markup must be div-balanced (no unclosed div left on the stack)');
  for (const [id, ancestors] of Object.entries(pages)) {
    assert.deepEqual(ancestors, ['app', 'mn'], `${id} must be inside #mn — found ancestors [${ancestors.join(', ')}]`);
  }
});

test('narrow layout: #app has exactly two children — the sidebar and #mn', () => {
  const { appChildren } = parseDivNesting(markup);
  assert.deepEqual(appChildren, ['sb', 'mn'], `#app children must be [sb, mn], found [${appChildren.join(', ')}]`);
});
