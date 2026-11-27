// Template gateway parity tests for the PC Store Manager (spec entries 21 + 22).
//
// Runs the SHARED fixtures in test/templates/fixtures/ (store-work tree,
// entry 22 — the single fixture set all gateways run against) against
// every gateway that exists now:
//   (1) the shell bundle gateway (storefront/bundle-gateway.js, entry 3)
//       — LANDED. validateBundle(files, manifest, {rules}) with the
//       hash check ON, fed the fixtures' canonical file form (see the
//       hash-serialisation note below).
//   (2) the PC mirror gateway in firebase-store.js (entry 16) — LANDED.
//       validateTemplateBundle(manifest, files, registryId), fed the
//       same canonical file form.
//   (3) a test-side allow-list check against gateway-rules.json (the
//       sanctioned fallback): it reads the rule file itself — it does
//       NOT re-implement a gateway, it asserts each fixture against
//       the allow-lists the rule file carries. A fixture verdict that
//       disagrees with an implementation is a flag, never a reason to
//       edit the fixture.
//   (4) the old-shell shape: a cached old app.js reading a new registry
//       document falls back to classic — proved here with the PC's own
//       v1 validateTemplateDoc, which must FAIL the new doc.
//   (5) pointer/rollback writes through firebase-store.js, with a
//       trimmed in-memory fake (same pattern as firebase-store.test.js).
//
// HASH SERIALISATION — pinned by the coordinator (decision 1,
// gateway-rules.json bundleHash.serialisation): ONE canonical form
// everywhere. manifest.json and tokens.json are parsed and
// re-serialised with recursively sorted keys and no whitespace
// (manifest.json with its bundleHash removed first); sections +
// styles.css are raw bytes. The shell gateway used to hash raw file
// bytes and the PC gateway used to hash tokens.json raw; both now
// canonicalise, so the three gateways agree on canonical AND raw
// input — the divergence test below pins that agreement.
//
// Run: npm test (node --test test/*.test.js). No network, no credentials.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const StoreFB = require(path.join(__dirname, '..', 'firebase-store.js'));

const CONFIG = {
  apiKey: 'test', authDomain: 'test', projectId: 'store-3384c',
  storageBucket: 'store-3384c.firebasestorage.app',
  messagingSenderId: '1', appId: '1:1:web:test',
};

// The store-work tree sits next to this repo under ~/workspace.
const STORE_WORK = path.resolve(__dirname, '..', '..', '..', '..', '..', 'store-work');
const FIXTURES_DIR = path.join(STORE_WORK, 'test', 'templates', 'fixtures');
const GATEWAY_RULES_PATH = path.join(STORE_WORK, 'storefront', 'templates', 'gateway-rules.json');
const SHELL_GATEWAY_PATH = path.join(STORE_WORK, 'storefront', 'bundle-gateway.js');

const HASH64 = 'a'.repeat(64);

/* ---------- fixture + rule-file loading ---------- */

function loadFixtures() {
  const index = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'index.json'), 'utf8'));
  return index.fixtures.map((name) => JSON.parse(
    fs.readFileSync(path.join(FIXTURES_DIR, name + '.json'), 'utf8')));
}

function loadRules() {
  return JSON.parse(fs.readFileSync(GATEWAY_RULES_PATH, 'utf8'));
}

/* ---------- canonical JSON + bundle hash (generator + Dart form) ---------- */

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort()
    .map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

function computeBundleHash(fixture) {
  const files = {};
  const { bundleHash: _drop, ...manifest } = fixture.manifest;
  files['manifest.json'] = canonicalJson(manifest);
  for (const name of Object.keys(fixture.sections || {}).sort()) {
    files['sections/' + name] = fixture.sections[name];
  }
  files['styles.css'] = fixture.styles || '';
  files['tokens.json'] = fixture.tokens == null ? '' : canonicalJson(fixture.tokens);
  const blob = Object.keys(files).sort().map((k) => files[k]).join('');
  return crypto.createHash('sha256').update(blob, 'utf8').digest('hex');
}

// The files map a gateway receives for one fixture, in canonical form:
// manifest WITHOUT its bundleHash (the hash input excludes it),
// tokens canonicalised. Sections + styles raw. This is the form the
// generator hashed and the Dart gateway hashes; the shell gateway
// hashes raw bytes, so feeding it this form is what makes the three
// agree — see the header note.
function canonicalFilesForFixture(fx) {
  const { bundleHash: _drop, ...manifest } = fx.manifest;
  const files = { 'manifest.json': canonicalJson(manifest) };
  for (const [k, v] of Object.entries(fx.sections || {})) files['sections/' + k] = v;
  if (fx.styles != null) files['styles.css'] = fx.styles;
  if (fx.tokens != null) files['tokens.json'] = canonicalJson(fx.tokens);
  return files;
}

/* ---------- test-side allow-list check (sanctioned fallback) ----------
 * Reads gateway-rules.json and asserts the fixture against its
 * allow-lists. Emits the fixture's own coarse reason codes. */

function semverCompare(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function checkBundleAgainstAllowLists(fixture, rules) {
  const reasons = new Set();
  const m = fixture.manifest || {};
  const sections = fixture.sections || {};
  const styles = fixture.styles || '';
  const tokens = fixture.tokens;

  // 1. Identity / version / hash.
  if (!rules.templateIds.includes(m.id)) reasons.add('bad-id');
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(m.version)) reasons.add('bad-version');
  if (typeof m.shellMinVersion === 'string' && semverCompare(m.shellMinVersion, rules.shellVersion) > 0) {
    reasons.add('shell-version');
  }
  if (typeof m.bundleHash === 'string' && /^[0-9a-f]{64}$/.test(m.bundleHash)
    && tokens != null && fixture.styles != null
    && computeBundleHash(fixture) !== m.bundleHash) {
    reasons.add('hash-mismatch');
  }
  for (const b of (m.behaviours || [])) {
    if (!rules.behaviours.includes(b)) reasons.add('behaviour-unknown');
  }
  for (const s of (m.sections || [])) {
    if (!rules.sectionFiles.includes(s)) reasons.add('unknown-section');
  }
  for (const s of rules.requiredSections) {
    if (!(m.sections || []).includes(s)) reasons.add('missing-' + s);
  }
  for (const d of (m.dataNeeds || [])) {
    if (!rules.dataNeeds.includes(d)) reasons.add('data-needs-unknown-field');
  }
  for (const f of (m.fonts || [])) {
    if (!rules.fontOrigins.includes(f.origin)) reasons.add('font-origin');
  }
  if (m.cartLayout && !rules.cartLayouts.includes(m.cartLayout)) reasons.add('bad-layout');
  if (m.modalLayout && !rules.modalLayouts.includes(m.modalLayout)) reasons.add('bad-layout');

  // 2. Required section files + brand slot.
  for (const s of rules.requiredSections) {
    if (!sections[s + '.html']) reasons.add('missing-' + s);
  }
  const allHtml = Object.values(sections).join('\n');
  if (!allHtml.includes('data-section="brand"') && !allHtml.includes("data-section='brand'")) {
    reasons.add('missing-brand-slot');
  }

  // 3. No-JavaScript scan, per section file.
  for (const [fileName, html] of Object.entries(sections)) {
    const base = fileName.replace(/\.html$/, '');
    if (!rules.sectionFiles.includes(base)) reasons.add('unknown-section');
    // <svg> with scriptable content (<script> / <foreignObject>) is
    // its own reason; strip those blocks before the plain <script>
    // scan so the script inside an svg does not double-report as a
    // script tag. An on* attribute inside an svg is NOT scriptable
    // content — it is an event-handler, caught by the attribute scan
    // below (invalid-onload-svg must report event-handler only).
    let scanHtml = html;
    const svgRe = /<svg[\s\S]*?<\/svg>/gi;
    let svgMatch;
    while ((svgMatch = svgRe.exec(html)) !== null) {
      const block = svgMatch[0];
      if (/<script/i.test(block) || /<foreignObject/i.test(block)) {
        reasons.add('svg-scriptable');
        scanHtml = scanHtml.replace(block, '');
      }
    }
    if (/<script/i.test(scanHtml)) reasons.add('script-tag');
    if (/javascript:/i.test(scanHtml)) reasons.add('javascript-url');
    const tagRe = /<\s*\/?\s*([A-Za-z][A-Za-z0-9]*)/g;
    let tagMatch;
    while ((tagMatch = tagRe.exec(scanHtml)) !== null) {
      const tag = tagMatch[1].toLowerCase();
      if (rules.forbiddenTags.includes(tag)) {
        reasons.add(tag === 'script' ? 'script-tag' : tag);
      }
    }
    if (/<iframe/i.test(scanHtml)) reasons.add('iframe');
    if (/<form/i.test(scanHtml)) reasons.add('form');
    if (/<meta/i.test(scanHtml)) reasons.add('meta');
    if (/<link/i.test(scanHtml)) reasons.add('link');
    // Attributes: on* handlers; any attribute outside the allow-list.
    // A tag that is itself forbidden (script/meta/link/...) already
    // fails the bundle — its attributes are not a second violation
    // (invalid-meta must report 'meta' only, not 'charset' too).
    const blockRe = /<[^>]+>/g;
    let blockMatch;
    while ((blockMatch = blockRe.exec(scanHtml)) !== null) {
      const tagOfBlock = (/^<\s*\/?\s*([A-Za-z][A-Za-z0-9]*)/.exec(blockMatch[0]) || [])[1];
      if (tagOfBlock && rules.forbiddenTags.includes(tagOfBlock.toLowerCase())) continue;
      const attrRe = /([A-Za-z][A-Za-z0-9-]*)\s*=/g;
      let attrMatch;
      while ((attrMatch = attrRe.exec(blockMatch[0])) !== null) {
        const attr = attrMatch[1].toLowerCase();
        if (attr.startsWith('on')) {
          reasons.add('event-handler');
        } else if (!rules.allowedAttributes.includes(attr)) {
          const idMatch = /id\s*=\s*["']productsGrid["']/.test(blockMatch[0]);
          reasons.add(idMatch ? 'writes-products-grid' : 'unknown-attribute');
        }
      }
    }
    const slotRe = /data-slot=["']([^"']+)["']/g;
    let slotMatch;
    while ((slotMatch = slotRe.exec(scanHtml)) !== null) {
      if (!rules.allowedSlots.includes(slotMatch[1])) reasons.add('unknown-slot');
    }
    const actionRe = /data-action=["']([^"']+)["']/g;
    let actionMatch;
    while ((actionMatch = actionRe.exec(scanHtml)) !== null) {
      if (!rules.allowedActions.includes(actionMatch[1])) reasons.add('unknown-action');
    }
  }

  // 5. tokens.json is REQUIRED.
  if (tokens == null) reasons.add('missing-tokens');

  // CSS: scoping, url/import origins, motion budget.
  const css = styles.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const sel of rules.forbiddenSelectors) {
    if (css.includes(sel)) reasons.add('css-transactional-selector');
  }
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let ruleMatch;
  while ((ruleMatch = ruleRe.exec(css)) !== null) {
    const selector = ruleMatch[1].toLowerCase();
    const body = ruleMatch[2];
    if (/display\s*:\s*none/.test(body)
      && (selector.includes('price') || selector.includes('button')
        || selector.includes('input')
        || rules.forbiddenSelectors.some((f) => selector.includes(f.toLowerCase())))) {
      reasons.add('css-transactional-selector');
    }
  }
  // @import first (its URL must come from a font origin); strip the
  // @import lines so their URLs do not double-report as css-url.
  let cssNoImports = css;
  const importRe = /@import\s+(?:url\(\s*["']?([^)"']+)["']?\s*\)|["']([^"']+)["'])/g;
  let importMatch;
  while ((importMatch = importRe.exec(css)) !== null) {
    const url = importMatch[1] || importMatch[2] || '';
    if (/^https?:\/\//.test(url)
      && !rules.fontOrigins.some((o) => o !== 'self' && url.startsWith(o))) {
      reasons.add('css-import-origin');
    }
  }
  cssNoImports = css.replace(/@import[^;]+;/g, '');
  const urlRe = /url\(\s*["']?([^)"']+)["']?\s*\)/g;
  let urlMatch;
  while ((urlMatch = urlRe.exec(cssNoImports)) !== null) {
    const url = urlMatch[1];
    if (/^https?:\/\//.test(url)
      && !rules.fontOrigins.some((o) => o !== 'self' && url.startsWith(o))
      && !rules.imageOrigins.some((o) => o !== 'self' && url.startsWith(o))) {
      reasons.add('css-url-origin');
    }
  }
  // Motion: blur / backdrop-filter anywhere; width/height only when
  // animated (transition/animation declarations or @keyframes bodies).
  if (/blur\s*\(/.test(css)) reasons.add('motion-blur');
  if (/backdrop-filter/.test(css)) reasons.add('motion-backdrop-filter');
  const keyframesRe = /@keyframes[^{]+\{([\s\S]*?)\}\s*\}/g;
  let kfMatch;
  while ((kfMatch = keyframesRe.exec(css)) !== null) {
    const body = kfMatch[1];
    if (/\bwidth\s*:/.test(body)) reasons.add('motion-width');
    if (/\bheight\s*:/.test(body)) reasons.add('motion-height');
  }
  const declRe = /(?:transition|animation)\s*:[^;}{]+/g;
  let declMatch;
  while ((declMatch = declRe.exec(css)) !== null) {
    if (/\bwidth\b/.test(declMatch[0])) reasons.add('motion-width');
    if (/\bheight\b/.test(declMatch[0])) reasons.add('motion-height');
  }

  return { passed: reasons.size === 0, reasons: [...reasons].sort() };
}

/* ---------- trimmed in-memory fake (activateTemplate path only) ---------- */

function createFakeFirebase() {
  const store = {};
  function docRef(coll, id) {
    if (id === undefined || id === null) id = 'auto-' + Math.random().toString(36).slice(2);
    return {
      id, path: coll + '/' + id,
      get: async () => {
        const data = store[coll + '/' + id];
        return { exists: data !== undefined, id, data: () => (data ? { ...data } : undefined) };
      },
      set: async (data, opts) => {
        const key = coll + '/' + id;
        const next = (opts && opts.merge) ? { ...(store[key] || {}) } : {};
        Object.keys(data || {}).forEach((k) => { next[k] = data[k]; });
        store[key] = next;
      },
      update: async (data) => {
        const key = coll + '/' + id;
        store[key] = { ...(store[key] || {}), ...data };
      },
      delete: async () => { delete store[coll + '/' + id]; },
      onSnapshot: (cb) => {
        const data = store[coll + '/' + id];
        cb({ exists: data !== undefined, id, data: () => (data ? { ...data } : undefined) });
        return () => {};
      },
      collection: (sub) => collectionRef(coll + '/' + id + '/' + sub),
    };
  }
  function collectionRef(coll) {
    return {
      doc: (id) => docRef(coll, id),
      where: () => collectionRef(coll),
      orderBy: () => collectionRef(coll),
      limit: () => collectionRef(coll),
      get: async () => ({ docs: [], empty: true, forEach: () => {} }),
      onSnapshot: (cb) => { cb({ docs: [], empty: true, forEach: () => {} }); return () => {}; },
    };
  }
  const db = {
    collection: (name) => collectionRef(name),
    batch: () => {
      const ops = [];
      return {
        set: (ref, data, opts) => { ops.push({ ref, data, merge: !!(opts && opts.merge) }); },
        delete: (ref) => { ops.push({ ref, del: true }); },
        commit: async () => {
          for (const op of ops) {
            if (op.del) { delete store[op.ref.path]; continue; }
            const next = op.merge ? { ...(store[op.ref.path] || {}) } : {};
            Object.keys(op.data || {}).forEach((k) => { next[k] = op.data[k]; });
            store[op.ref.path] = next;
          }
        },
      };
    },
  };
  const authState = { user: null, cbs: [] };
  const auth = {
    get currentUser() { return authState.user; },
    signInWithEmailAndPassword: async (email) => {
      authState.user = { uid: 'uid-admin', email };
      authState.cbs.forEach((cb) => cb(authState.user));
      return { user: authState.user };
    },
    signOut: async () => {
      authState.user = null;
      authState.cbs.forEach((cb) => cb(null));
    },
    setPersistence: async () => {},
    onAuthStateChanged: (cb) => {
      authState.cbs.push(cb);
      cb(authState.user);
      return () => {};
    },
  };
  const fake = {
    apps: [],
    initializeApp: (cfg) => {
      const app = { options: cfg };
      fake.apps.push(app);
      return app;
    },
    auth: () => auth,
    firestore: Object.assign(() => db, {
      FieldValue: {
        serverTimestamp: () => ({ __serverTimestamp: true }),
        delete: () => ({ __delete: true }),
      },
    }),
    functions: () => ({ httpsCallable: () => async () => ({ data: { ok: true } }) }),
    _store: store,
    _setRole: (uid, role) => { store['admins/' + uid] = { role }; },
  };
  fake.auth.Auth = { Persistence: { LOCAL: 'local', SESSION: 'session' } };
  return fake;
}

async function signedInFb() {
  const fake = createFakeFirebase();
  fake._setRole('uid-admin', 'admin');
  const fb = StoreFB.create(fake, CONFIG);
  await fb.init();
  await fb.signIn('admin@store.test', 'correct');
  return { fake, fb };
}

function bundleTemplateDoc(id, { nameAr, nameEn, hash, status, approval = true }) {
  const doc = {
    id, nameAr, nameEn,
    version: '1.0.0', shellMinVersion: '1.0.0', bundleHash: hash,
    status, motion: 'calm', dark: 'light-only',
    sections: ['products', 'delivery', 'contact'],
  };
  if (approval) {
    doc.approval = {
      approver: 'uid-admin', timestamp: { __serverTimestamp: true },
      shellVersion: '1.0.0', bundleHash: hash,
    };
  }
  return doc;
}

// A spec-shaped registry doc (spec §2 line 276): the six-field
// manifest copy only — no motion / dark / sections / behaviours /
// dataNeeds / fonts. This is the shape the rules (entry 10,
// templateShapeOk hasOnly) enforce and the rules tests seed.
function specRegistryDoc(id, { nameAr, nameEn, hash, status, approval = true }) {
  const doc = {
    id, nameAr, nameEn,
    version: '1.0.0', shellMinVersion: '1.0.0', bundleHash: hash,
    status,
  };
  if (approval) {
    doc.approval = {
      approver: 'uid-admin', timestamp: { __serverTimestamp: true },
      shellVersion: '1.0.0', bundleHash: hash,
    };
  }
  return doc;
}

function activationRecords(fake, templateId) {
  const prefix = 'templates/' + templateId + '/activations/';
  return Object.keys(fake._store)
    .filter((k) => k.startsWith(prefix))
    .map((k) => fake._store[k]);
}

// A hosted manifest.json as validateHostedManifest fetches it: the
// FULL manifest (motion / dark / sections / behaviours / fonts all
// live on Hosting, not in Firestore).
function hostedManifest(id, { nameAr, nameEn, hash }) {
  return {
    id, nameAr, nameEn, version: '1.0.0', shellMinVersion: '1.0.0', bundleHash: hash,
    motion: 'calm', dark: 'light-only', behaviours: [],
    sections: ['hero', 'products', 'delivery', 'contact'],
    dataNeeds: [], cartLayout: 'drawer', modalLayout: 'default',
    fonts: [{ family: 'Tajawal', weights: [400, 700], origin: 'self' }],
    previewImageUrl: 'https://store-3384c.web.app/templates/' + id + '/1.0.0/preview.png',
  };
}

// Stubs global.fetch so validateHostedManifest serves the given
// hosted manifests (keyed by template id); anything else 404s.
// Returns a restore function — call it in a finally block.
function stubHostedManifests(manifestsById) {
  const origFetch = global.fetch;
  const byUrl = {};
  for (const [id, manifest] of Object.entries(manifestsById)) {
    byUrl['https://store-3384c.web.app/templates/' + id + '/' + (manifest.version || '1.0.0') + '/manifest.json'] = JSON.stringify(manifest);
  }
  global.fetch = async (url) => {
    const text = byUrl[url];
    if (text === undefined) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => text };
  };
  return () => { global.fetch = origFetch; };
}

/* ---------- the tests ---------- */

test('templates fixtures: the shared set loads (36 fixtures + index)', () => {
  assert.ok(fs.existsSync(FIXTURES_DIR), 'fixtures dir missing: ' + FIXTURES_DIR);
  assert.ok(fs.existsSync(GATEWAY_RULES_PATH), 'gateway-rules.json missing');
  const fixtures = loadFixtures();
  assert.equal(fixtures.length, 36);
  const kinds = {};
  for (const fx of fixtures) kinds[fx.kind] = (kinds[fx.kind] || 0) + 1;
  assert.equal(kinds['valid-bundle'], 5);
  assert.equal(kinds['slot-contract-valid'], 1);
  assert.equal(kinds['old-shell'], 1);
});

test('templates fixtures: the allow-list check agrees with every declared verdict', () => {
  const rules = loadRules();
  const fixtures = loadFixtures();
  for (const fx of fixtures) {
    if (fx.kind === 'old-shell') continue; // not a bundle — see below
    const got = checkBundleAgainstAllowLists(fx, rules);
    const wantPass = fx.expected.verdict === 'pass';
    assert.equal(got.passed, wantPass,
      fx.id + ': verdict — got ' + JSON.stringify(got.reasons)
      + ', expected ' + fx.expected.verdict);
    assert.deepEqual(got.reasons, [...fx.expected.reasons].sort(),
      fx.id + ': reasons');
  }
});

test('templates fixtures: the five valid direction bundles + slot-contract pass, hash included', () => {
  const rules = loadRules();
  for (const id of ['valid-bazaar', 'valid-gallery', 'valid-scroll',
    'valid-speclab', 'valid-boutique', 'slot-contract-valid']) {
    const fx = loadFixtures().find((f) => f.id === id);
    const got = checkBundleAgainstAllowLists(fx, rules);
    assert.equal(got.passed, true, id + ': ' + JSON.stringify(got.reasons));
    assert.equal(computeBundleHash(fx), fx.manifest.bundleHash, id + ': bundleHash');
  }
});

test('templates fixtures: the slot-contract bundle uses every slot and hook', () => {
  const rules = loadRules();
  const fx = loadFixtures().find((f) => f.id === 'slot-contract-valid');
  const html = Object.values(fx.sections).join('\n');
  for (const slot of rules.allowedSlots) {
    assert.ok(html.includes('data-slot="' + slot + '"'), 'slot ' + slot);
  }
  for (const action of rules.allowedActions) {
    assert.ok(html.includes('data-action="' + action + '"'), 'action ' + action);
  }
});

test('templates fixtures: the CSS-scoping bundle (confirm button hidden) fails', () => {
  const rules = loadRules();
  const fx = loadFixtures().find((f) => f.id === 'invalid-css-hides-confirm');
  const got = checkBundleAgainstAllowLists(fx, rules);
  assert.equal(got.passed, false);
  assert.deepEqual(got.reasons, ['css-transactional-selector']);
});

test('templates old-shell: the v1 gateway fails the new registry doc, so the old shell falls back to classic', () => {
  const fx = loadFixtures().find((f) => f.id === 'old-shell-shape');
  assert.equal(fx.expected.fallback, 'classic');
  assert.equal(fx.expected.oldGatewayPasses, false);
  // The PC's own v1 gateway is the old shell's check here.
  const report = StoreFB.validateTemplateDoc(fx.registryDoc);
  assert.equal(report.passed, false);
  // The classic seed is a bundle doc now (decision 15), so the v1
  // gateway fails it too — by design. The old shell's fallback to
  // classic is to the BUNDLED classic files (templates/classic.json
  // + the built-in fallback chain), not to a registry doc it can
  // read; the seed passes the bundle registry check instead.
  assert.equal(StoreFB.validateTemplateDoc(StoreFB.CLASSIC_TEMPLATE).passed, false);
  assert.equal(StoreFB.validateRegistryManifest(StoreFB.CLASSIC_TEMPLATE, 'classic').passed, true);
});

/* ---------- shell gateway (entry 3) ---------- */

// Fixture id → the exact failed checks the shell gateway reports
// (validateBundle, hash check ON, canonical files). Read off the
// implementation by running it — a disagreement here is a flag,
// never a reason to edit the fixture. Vocabulary quirks:
// - The shell inspects @keyframes BODIES (decision 5): a block
//   animating a forbidden property fails as motion.keyframes —
//   the Dart name — so 'invalid-motion-height' and the filter in
//   'invalid-motion-blur' surface it.
// - The shell rejects ANY absolute href except the allow-listed
//   link origins (gateway-rules.json linkOrigins — https://wa.me/),
//   and any <svg> tag (tag_not_allowed:svg) — the PC and Dart do
//   the same for svg; the fixtures never use a raw absolute href.
// - 'invalid-css-import-origin' surfaces as BOTH the import and the
//   url check: the url() scanner also matches the URL inside @import.
const shellChecks = {
  'invalid-script-tag': ['noJavaScript:sections/hero.html:forbidden_tag:script'],
  'invalid-onclick': ['noJavaScript:sections/products.html:forbidden_attribute:onclick'],
  'invalid-onerror-img': ['noJavaScript:sections/products.html:forbidden_attribute:onerror'],
  'invalid-onload-svg': [
    'noJavaScript:sections/hero.html:tag_not_allowed:svg',
    'noJavaScript:sections/hero.html:forbidden_attribute:onload',
  ],
  'invalid-javascript-url': ['noJavaScript:sections/contact.html:forbidden_url_scheme:javascript:'],
  'invalid-iframe': [
    'noJavaScript:sections/hero.html:forbidden_tag:iframe',
    'noJavaScript:sections/hero.html:img_origin_not_allowed:https://example.com',
  ],
  'invalid-form': ['noJavaScript:sections/contact.html:forbidden_tag:form'],
  'invalid-meta': [
    'noJavaScript:sections/hero.html:forbidden_tag:meta',
    'noJavaScript:sections/hero.html:attribute_not_allowed:charset',
  ],
  'invalid-link': [
    'noJavaScript:sections/hero.html:forbidden_tag:link',
    'noJavaScript:sections/hero.html:attribute_not_allowed:rel',
    'noJavaScript:sections/hero.html:href_external:https://example.com/x.css',
  ],
  'invalid-svg-scriptable': [
    'noJavaScript:sections/hero.html:tag_not_allowed:svg',
    'noJavaScript:sections/hero.html:forbidden_tag:script',
  ],
  'invalid-missing-tokens': ['tokens:tokens_missing'],
  'invalid-missing-delivery': ['requiredSections:section_missing:delivery'],
  'invalid-missing-brand-slot': ['requiredSections:brand_slot_missing'],
  'invalid-motion-blur': [
    'motion:css_property_not_allowed:filter',
    'motion:css_blur_or_backdrop_filter',
    'motion:motion.keyframes',
  ],
  'invalid-motion-backdrop-filter': [
    'motion:css_property_not_allowed:backdrop-filter',
    'motion:css_animated_property_forbidden:backdrop-filter',
    'motion:css_animated_property_forbidden:blur/backdrop-filter',
    'motion:css_blur_or_backdrop_filter',
  ],
  'invalid-motion-width': ['motion:css_animated_property_forbidden:width'],
  'invalid-motion-height': ['motion:motion.keyframes'],
  'invalid-css-url-origin': [
    'motion:css_url_origin_not_allowed:https://evil.example/x.png',
    'motion:css_property_not_allowed:background-image',
  ],
  'invalid-css-import-origin': [
    'motion:css_import_origin_not_allowed:https://fonts.evil.com/x.css',
    'motion:css_url_origin_not_allowed:https://fonts.evil.com/x.css',
  ],
  'invalid-data-needs-unknown-field': ['dataNeeds:dataNeed_unknown:stockCount'],
  'invalid-font-origin': ['fonts:font_origin_not_allowed:https://fonts.evil.com'],
  'invalid-behaviour-unknown': ['identity:manifest.behaviour_not_whitelisted:teleport'],
  'invalid-shell-version': ['identity:manifest.shellMinVersion_newer:2.0.0'],
  'invalid-hash-mismatch': ['hash:hash_mismatch'],
  'invalid-unknown-slot': ['noJavaScript:sections/products.html:slot_unknown:product-rating'],
  'invalid-unknown-action': ['noJavaScript:sections/products.html:action_unknown:buy-now'],
  'invalid-unknown-section': ['identity:manifest.section_unknown:checkout'],
  'invalid-writes-products-grid': ['noJavaScript:sections/products.html:attribute_not_allowed:id'],
  'invalid-css-hides-confirm': ['motion:css_forbidden_selector:#checkoutBtn'],
};

test('templates gateway: shell bundle-gateway.js agrees with every fixture verdict', async () => {
  assert.ok(fs.existsSync(SHELL_GATEWAY_PATH), 'bundle-gateway.js missing');
  const Shell = require(SHELL_GATEWAY_PATH);
  const rules = loadRules();
  for (const fx of loadFixtures()) {
    if (fx.kind === 'old-shell') continue;
    const rep = await Shell.validateBundle(canonicalFilesForFixture(fx), fx.manifest, { rules });
    const wantPass = fx.expected.verdict === 'pass';
    assert.equal(rep.passed, wantPass, fx.id + ': verdict — ' + JSON.stringify(rep.failed));
    assert.deepEqual([...rep.failed].sort(), [...(shellChecks[fx.id] || [])].sort(),
      fx.id + ': failed checks');
  }
});

test('templates gateway: the shell now fails a height-animating bundle (decision 5)', async () => {
  // Was a KNOWN GAP: checkCss scanned transition/animation
  // DECLARATIONS for forbidden property names, but the fixture
  // animates via @keyframes (`animation: grow 1s` names the
  // keyframes, not `height`) and the shell never inspected
  // @keyframes bodies. The @keyframes-body inspection (decision 5)
  // closes it: the shell reports motion.keyframes, the Dart name,
  // and agrees with Dart + PC on the verdict.
  const Shell = require(SHELL_GATEWAY_PATH);
  const rules = loadRules();
  const fx = loadFixtures().find((f) => f.id === 'invalid-motion-height');
  const rep = await Shell.validateBundle(canonicalFilesForFixture(fx), fx.manifest, { rules });
  assert.equal(rep.passed, false, 'shell must fail motion-height: ' + JSON.stringify(rep.failed));
  assert.deepEqual(rep.failed, ['motion:motion.keyframes']);
});

/* ---------- PC mirror gateway (entry 16) ---------- */

// Fixture id → the exact failedChecks the PC gateway reports
// (validateTemplateBundle, canonical files). Read off the
// implementation by running it. Vocabulary quirks:
// - A bare <svg> tag fails (tag.svg) — same as Dart + shell.
// - 'invalid-unknown-section' fires the manifest check AND the
//   section-file-name check (decision 13): the PC checks file names
//   against the section allow-list, like Dart
//   (sections.unknown.checkout).
// - 'invalid-motion-backdrop-filter' fires THREE checks: the property
//   itself is not in the CSS allow-list, the transition names it,
//   and the backdrop-filter scan catches it (Dart lumps it into one
//   motion.blur).
// - 'invalid-css-url-origin' also fires property.background-image:
//   background-image is not in the CSS allow-list.
const pcChecks = {
  'invalid-script-tag': ['sections/hero.html.tag.script'],
  'invalid-onclick': ['sections/products.html.attr.onclick'],
  'invalid-onerror-img': ['sections/products.html.attr.onerror'],
  'invalid-onload-svg': ['sections/hero.html.tag.svg'],
  'invalid-javascript-url': [
    'sections/contact.html.href.javascript',
    'sections/contact.html.javascript-url',
  ],
  'invalid-iframe': ['sections/hero.html.tag.iframe'],
  'invalid-form': ['sections/contact.html.tag.form'],
  'invalid-meta': ['sections/hero.html.tag.meta'],
  'invalid-link': ['sections/hero.html.tag.link'],
  'invalid-svg-scriptable': ['sections/hero.html.tag.svg', 'sections/hero.html.tag.script'],
  'invalid-missing-tokens': ['tokens.json'],
  'invalid-missing-delivery': ['manifest.sections.delivery', 'sections.delivery'],
  'invalid-missing-brand-slot': ['brandSlot'],
  'invalid-motion-blur': ['styles.css.blur', 'styles.css.keyframe-property.filter'],
  'invalid-motion-backdrop-filter': [
    'styles.css.backdrop-filter',
    'styles.css.animated-property',
    'styles.css.property.backdrop-filter',
  ],
  'invalid-motion-width': ['styles.css.animated-property'],
  'invalid-motion-height': ['styles.css.animated-property', 'styles.css.keyframe-property.height'],
  'invalid-css-url-origin': ['styles.css.url-origin', 'styles.css.property.background-image'],
  'invalid-css-import-origin': ['styles.css.url-origin', 'styles.css.import-origin'],
  'invalid-data-needs-unknown-field': ['manifest.dataNeeds.stockCount'],
  'invalid-font-origin': ['manifest.fonts.Evil'],
  'invalid-behaviour-unknown': ['manifest.behaviours.teleport'],
  'invalid-shell-version': ['manifest.shellMinVersion'],
  'invalid-hash-mismatch': ['manifest.bundleHash'],
  'invalid-unknown-slot': ['sections/products.html.slot.product-rating'],
  'invalid-unknown-action': ['sections/products.html.action.buy-now'],
  'invalid-unknown-section': ['manifest.sections.checkout', 'sections.unknown.checkout'],
  'invalid-writes-products-grid': ['sections/products.html.attr.id'],
  'invalid-css-hides-confirm': [
    'styles.css.selector.#checkoutBtn',
    'styles.css.display-none-transactional',
  ],
};

test('templates gateway: PC mirror gateway agrees with every fixture verdict', () => {
  assert.equal(typeof StoreFB.validateTemplateBundle, 'function');
  for (const fx of loadFixtures()) {
    if (fx.kind === 'old-shell') continue;
    const rep = StoreFB.validateTemplateBundle(
      fx.manifest, canonicalFilesForFixture(fx), fx.manifest.id);
    const wantPass = fx.expected.verdict === 'pass';
    assert.equal(rep.passed, wantPass, fx.id + ': verdict — ' + JSON.stringify(rep.failedChecks));
    assert.deepEqual([...rep.failedChecks].sort(), [...(pcChecks[fx.id] || [])].sort(),
      fx.id + ': failedChecks');
  }
});

test('templates gateway: the five valid direction bundles + slot-contract pass the PC gateway, hash included', () => {
  for (const id of ['valid-bazaar', 'valid-gallery', 'valid-scroll',
    'valid-speclab', 'valid-boutique', 'slot-contract-valid']) {
    const fx = loadFixtures().find((f) => f.id === id);
    const rep = StoreFB.validateTemplateBundle(
      fx.manifest, canonicalFilesForFixture(fx), fx.manifest.id);
    assert.equal(rep.passed, true, id + ': ' + JSON.stringify(rep.failedChecks));
    assert.deepEqual(rep.failedChecks, []);
  }
});

/* ---------- hash serialisation (decision 1 — canonical, pinned) ---------- */

test('templates hash: the three gateways agree on the canonical serialisation, on canonical AND raw input', async () => {
  const Shell = require(SHELL_GATEWAY_PATH);
  const fx = loadFixtures().find((f) => f.id === 'valid-bazaar');
  // Canonical form (what the generator + Dart hash): all three agree.
  assert.equal(computeBundleHash(fx), fx.manifest.bundleHash);
  assert.equal(StoreFB.computeBundleHash(canonicalFilesForFixture(fx)), fx.manifest.bundleHash);
  assert.equal(await Shell.computeBundleHash(canonicalFilesForFixture(fx)), fx.manifest.bundleHash);
  // Raw form (a pretty-printed manifest + declaration-order tokens
  // as an author would write them): the gateways canonicalise the
  // JSON files before hashing, so they agree with the fixture hash
  // here too — the authoring format must not change the hash.
  const rawFiles = { 'manifest.json': JSON.stringify(fx.manifest) };
  for (const [k, v] of Object.entries(fx.sections)) rawFiles['sections/' + k] = v;
  rawFiles['styles.css'] = fx.styles;
  rawFiles['tokens.json'] = JSON.stringify(fx.tokens);
  assert.equal(StoreFB.computeBundleHash(rawFiles), fx.manifest.bundleHash,
    'PC canonicalises tokens.json');
  assert.equal(await Shell.computeBundleHash(rawFiles), fx.manifest.bundleHash,
    'shell canonicalises manifest.json + tokens.json');
});

/* ---------- registry shape (A) — resolved, decision 2 ---------- */

// RESOLVED by the integration fix (decision 2, shape (A) — same pin
// as store-work/test/phase3_templates_test.dart): the registry doc
// stays the six-field manifest copy (spec §2 line 276; the rules'
// templateShapeOk hasOnly) and the flows validate the HOSTED
// manifest (validateHostedManifest: fetch + hash check) at
// approve/activate time; registry docs get the bundle-rules-only
// six-field check (validateRegistryManifest). The first half below
// pins the remaining split: validateTemplateBundle on a six-field
// manifest still fails with motion/dark/sections — that is the
// FULL-manifest validator's contract (it validates HOSTED
// manifests), not a bug. The second half proves the flows no longer
// reject spec-shaped docs: activation of a spec-shaped registry doc
// succeeds once the hosted manifest (stubbed here) matches its hash.
test('templates registry: the full-manifest validator still rejects a six-field copy, but activation of a spec-shaped doc succeeds', async () => {
  const manifest = {
    id: 'bazaar', nameAr: 'بازار', nameEn: 'Deal Bazaar',
    version: '1.0.0', shellMinVersion: '1.0.0', bundleHash: HASH64,
  };
  const rep = StoreFB.validateTemplateBundle(manifest, null, 'bazaar');
  assert.equal(rep.passed, false);
  assert.deepEqual(rep.failedChecks,
    ['manifest.motion', 'manifest.dark', 'manifest.sections']);
  // The six-field registry check itself passes the same doc (with
  // its status, as a registry doc always carries one):
  assert.equal(StoreFB.validateRegistryManifest({ ...manifest, status: 'approved' }, 'bazaar').passed, true);
  // And activation of a spec-shaped doc succeeds with a matching
  // hosted manifest:
  const { fake, fb } = await signedInFb();
  fake._store['templates/gallery'] = specRegistryDoc('gallery',
    { nameAr: 'معرض', nameEn: 'White Gallery', hash: 'b'.repeat(64), status: 'approved' });
  fake._store['templates/classic'] = specRegistryDoc('classic',
    { nameAr: 'الكلاسيكي', nameEn: 'Classic', hash: 'c'.repeat(64), status: 'active', approval: false });
  fake._store['storeSettings/activeTemplate'] = {
    templateId: 'classic', bundleVersion: '1.0.0', bundleHash: 'c'.repeat(64),
    previousTemplateId: 'classic',
    history: [{ templateId: 'classic', bundleVersion: '1.0.0', bundleHash: 'c'.repeat(64), at: 1, by: 'uid-admin' }],
  };
  const restore = stubHostedManifests({
    gallery: hostedManifest('gallery', { nameAr: 'معرض', nameEn: 'White Gallery', hash: 'b'.repeat(64) }),
  });
  try {
    const res = await fb.activateTemplate('gallery');
    assert.equal(res.templateId, 'gallery');
    assert.equal(res.bundleHash, 'b'.repeat(64));
    assert.equal(fake._store['templates/gallery'].status, 'active');
    assert.equal(fake._store['storeSettings/activeTemplate'].templateId, 'gallery');
  } finally {
    restore();
  }
  // A hosted manifest whose hash CHANGED after approval is refused
  // at the hosted check (approval freeze):
  const restore2 = stubHostedManifests({
    gallery: hostedManifest('gallery', { nameAr: 'معرض', nameEn: 'White Gallery', hash: 'd'.repeat(64) }),
  });
  try {
    await assert.rejects(fb.activateTemplate('gallery'), /القالب المستضاف مش صالح للتفعيل: manifest\.bundleHash/);
  } finally {
    restore2();
  }
});

/* ---------- pointer / rollback through firebase-store.js ---------- */

test('templates pointer/rollback: activation appends to the history stack, rollback restores the second-last entry', async () => {
  // Seeds are spec-shaped registry docs (six-field copy — the
  // shape the rules enforce); the flows validate them with the
  // six-field registry check and the HOSTED manifest (stubbed
  // here), never the full-manifest validator on registry data.
  const { fake, fb } = await signedInFb();
  fake._store['templates/bazaar'] = specRegistryDoc('bazaar',
    { nameAr: 'بازار', nameEn: 'Deal Bazaar', hash: HASH64, status: 'approved' });
  fake._store['templates/gallery'] = specRegistryDoc('gallery',
    { nameAr: 'معرض', nameEn: 'White Gallery', hash: 'b'.repeat(64), status: 'approved' });
  fake._store['templates/classic'] = specRegistryDoc('classic',
    { nameAr: 'الكلاسيكي', nameEn: 'Classic', hash: 'c'.repeat(64), status: 'active', approval: false });
  fake._store['storeSettings/activeTemplate'] = {
    templateId: 'classic', bundleVersion: '1.0.0', bundleHash: 'c'.repeat(64),
    previousTemplateId: 'classic',
    history: [{ templateId: 'classic', bundleVersion: '1.0.0', bundleHash: 'c'.repeat(64), at: 1, by: 'uid-admin' }],
  };
  const restore = stubHostedManifests({
    bazaar: hostedManifest('bazaar', { nameAr: 'بازار', nameEn: 'Deal Bazaar', hash: HASH64 }),
    gallery: hostedManifest('gallery', { nameAr: 'معرض', nameEn: 'White Gallery', hash: 'b'.repeat(64) }),
    classic: hostedManifest('classic', { nameAr: 'الكلاسيكي', nameEn: 'Classic', hash: 'c'.repeat(64) }),
  });
  try {
  // Activate gallery: pointer carries the new shape, history grows by 1.
  const act = await fb.activateTemplate('gallery');
  assert.equal(act.templateId, 'gallery');
  assert.equal(act.bundleVersion, '1.0.0');
  assert.equal(act.bundleHash, 'b'.repeat(64));
  assert.equal(act.previousTemplateId, 'classic');
  let ptr = fake._store['storeSettings/activeTemplate'];
  assert.equal(ptr.templateId, 'gallery');
  assert.equal(ptr.bundleVersion, '1.0.0');
  assert.equal(ptr.bundleHash, 'b'.repeat(64));
  assert.equal(ptr.previousTemplateId, 'classic');
  assert.equal(ptr.history.length, 2);
  assert.equal(ptr.history[1].templateId, 'gallery');
  assert.equal(ptr.history[1].bundleHash, 'b'.repeat(64));
  // D2: the history `at` is a Firestore Timestamp (serverTimestamp
  // sentinel in the fake), never an ISO string — the rules require
  // `last.get('at') is timestamp` (pointerShapeOk).
  assert.equal(typeof ptr.history[1].at, 'object');
  assert.equal(ptr.history[1].at.__serverTimestamp, true);
  assert.equal(fake._store['templates/gallery'].status, 'active');
  const galleryActivations = activationRecords(fake, 'gallery');
  assert.equal(galleryActivations.length, 1);
  assert.equal(galleryActivations[0].action, 'activate');
  assert.equal(galleryActivations[0].templateId, 'gallery');
  assert.equal(galleryActivations[0].bundleHash, 'b'.repeat(64));
  assert.equal(galleryActivations[0].shellVersion, '1.0.0');
  assert.equal(galleryActivations[0].previousTemplateId, 'classic');
  assert.ok(galleryActivations[0].at, 'activation record has at');
  assert.equal(galleryActivations[0].at.__serverTimestamp, true);

  // Rollback once: classic is live again; gallery demoted to approved.
  const rb1 = await fb.rollbackTemplate();
  assert.equal(rb1.templateId, 'classic');
  assert.equal(rb1.previousTemplateId, 'gallery');
  assert.equal(rb1.fellBack, false);
  ptr = fake._store['storeSettings/activeTemplate'];
  assert.equal(ptr.templateId, 'classic');
  assert.equal(ptr.previousTemplateId, 'gallery');
  assert.equal(ptr.history.length, 3);
  assert.equal(ptr.history[2].templateId, 'classic');
  // D2: the rollback entry's `at` is a Timestamp too.
  assert.equal(typeof ptr.history[2].at, 'object');
  assert.equal(ptr.history[2].at.__serverTimestamp, true);
  assert.equal(fake._store['templates/gallery'].status, 'approved');

  // Rollback again: walks the stack backwards, gallery is live again
  // (no ping-pong: the second rollback does NOT return to classic).
  const rb2 = await fb.rollbackTemplate();
  assert.equal(rb2.templateId, 'gallery');
  ptr = fake._store['storeSettings/activeTemplate'];
  assert.equal(ptr.templateId, 'gallery');
  assert.equal(ptr.history.length, 4);
  assert.equal(ptr.history[3].templateId, 'gallery');
  assert.equal(fake._store['templates/gallery'].status, 'active');

  // Activate bazaar, then retire gallery: the next rollback must
  // DENY the retired target and restore classic instead (spec B5).
  await fb.activateTemplate('bazaar');
  ptr = fake._store['storeSettings/activeTemplate'];
  assert.equal(ptr.templateId, 'bazaar');
  assert.equal(ptr.history.length, 5);
  assert.equal(fake._store['templates/gallery'].status, 'approved');
  await fb.setTemplateStatus('gallery', 'retired');
  assert.equal(fake._store['templates/gallery'].status, 'retired');
  const rb3 = await fb.rollbackTemplate();
  assert.equal(rb3.templateId, 'classic');
  assert.equal(rb3.fellBack, true);
  assert.equal(rb3.deniedTemplateId, 'gallery');
  ptr = fake._store['storeSettings/activeTemplate'];
  assert.equal(ptr.templateId, 'classic');
  assert.equal(ptr.previousTemplateId, 'bazaar');
  assert.equal(ptr.history.length, 6);
  assert.match(ptr.history[5].note || '', /مرفوض/);
  assert.equal(fake._store['templates/bazaar'].status, 'approved');
  assert.equal(fake._store['templates/classic'].status, 'active');
  const classicRollbacks = activationRecords(fake, 'classic')
    .filter((r) => r.action === 'rollback' && r.deniedTemplateId === 'gallery');
  assert.equal(classicRollbacks.length, 1);
  } finally {
    restore();
  }
});

test('templates approval: approval.at is a Timestamp (serverTimestamp), not an ISO string (D2)', async () => {
  const { fake, fb } = await signedInFb();
  fake._store['templates/gallery'] = specRegistryDoc('gallery',
    { nameAr: 'معرض', nameEn: 'White Gallery', hash: 'b'.repeat(64), status: 'preview', approval: false });
  const restore = stubHostedManifests({
    gallery: hostedManifest('gallery', { nameAr: 'معرض', nameEn: 'White Gallery', hash: 'b'.repeat(64) }),
  });
  try {
    const ok = await fb.approveTemplate('gallery');
    assert.equal(ok, true);
    const doc = fake._store['templates/gallery'];
    assert.equal(doc.status, 'approved');
    // templateApprovalOk requires `at is timestamp` — an ISO string
    // is denied by the rules, so this must be the serverTimestamp
    // sentinel (a real Timestamp live), never a string.
    assert.equal(typeof doc.approval.at, 'object');
    assert.equal(doc.approval.at.__serverTimestamp, true);
    assert.equal(doc.approval.approver, 'admin@store.test');
    assert.equal(doc.approval.bundleHash, 'b'.repeat(64));
  } finally {
    restore();
  }
});
