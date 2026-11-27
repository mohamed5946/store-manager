// Syntax gate: every inline <script> block in index.html and every
// shipped JS file must pass `node --check`.
//
// 2026-11-27 — 1.1.3 shipped an app that could never start: commit
// e230d65 ("Remove discount code entirely") clipped the `// ----`
// prefix off a comment line in index.html, leaving a bare expression
// ` (Hosting manifest, /updates/) ----` at what was then line 5467.
// The whole inline <script> block (index.html:2015-7027: startSplash,
// bootAfterSplash, showLogin, enterProgram, init, all UI wiring) never
// executed, so the splash never hid and the app never started — on
// every machine, network-independent. The full suite was 151/151 GREEN
// on the broken code because no test parsed index.html's inline script.
// This gate exists so that can never ship again. It runs in CI
// (build-windows.yml, "Run syntax gate" step) before the build.
//
// The extractor is a sequential scanner, not a regex over the whole
// file: it walks <script>...</script> pairs in order, skips tags with
// a src attribute (external files, checked separately), and consumes
// each block's content whole — so <script> occurrences inside JS
// template literals (e.g. the print-window HTML strings) are content,
// not new blocks, and escaped `<\/script>` closings inside strings do
// not end a block early.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'index.html');
// Shipped JS files (main + renderer). update-download.js is included:
// it ships in the app and is loaded by the updater flow.
const SHIPPED_JS = [
  'main.js',
  'preload.js',
  'firebase-store.js',
  'waybill.js',
  'tour.js',
  'update-download.js',
];
// The three inline blocks index.html is expected to carry:
//   915  sound system (Web Audio API)
//   2000 Firebase config (window.STORE_FIREBASE_CONFIG)
//   2015 main app (splash, boot, login, init, all UI wiring)
// If a fourth block is ever added, update this count deliberately —
// a silent drop to zero blocks must never pass.
const EXPECTED_INLINE_BLOCKS = 3;

function extractInlineScripts(html) {
  const blocks = [];
  let i = 0;
  for (;;) {
    const openIdx = html.indexOf('<script', i);
    if (openIdx === -1) break;
    const tagEnd = html.indexOf('>', openIdx);
    if (tagEnd === -1) break;
    const tag = html.slice(openIdx, tagEnd + 1);
    const closeIdx = html.indexOf('</script>', tagEnd + 1);
    if (closeIdx === -1) break;
    if (!/\bsrc\s*=/.test(tag)) {
      const startLine = html.slice(0, openIdx).split('\n').length;
      blocks.push({ startLine, code: html.slice(tagEnd + 1, closeIdx) });
    }
    i = closeIdx + '</script>'.length;
  }
  return blocks;
}

function nodeCheck(code, label) {
  const tmp = path.join(
    os.tmpdir(),
    `sm-syntax-gate-${process.pid}-${label.replace(/[^A-Za-z0-9]+/g, '-')}.js`,
  );
  fs.writeFileSync(tmp, code, 'utf8');
  try {
    return spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* best effort */ }
  }
}

test('index.html: every inline <script> block passes node --check', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const blocks = extractInlineScripts(html);
  assert.strictEqual(
    blocks.length,
    EXPECTED_INLINE_BLOCKS,
    `expected ${EXPECTED_INLINE_BLOCKS} inline <script> blocks in index.html, found ${blocks.length} ` +
      `(starts at lines ${blocks.map((b) => b.startLine).join(', ') || 'none'}) — ` +
      'if a block was added or removed on purpose, update EXPECTED_INLINE_BLOCKS',
  );
  const failures = [];
  for (const block of blocks) {
    const result = nodeCheck(block.code, `index-html-line-${block.startLine}`);
    if (result.status !== 0) {
      failures.push(
        `inline <script> starting at index.html:${block.startLine}:\n${result.stderr || result.stdout || '(no output)'}`,
      );
    }
  }
  assert.deepStrictEqual(
    failures,
    [],
    `node --check failed for inline <script> block(s) in index.html:\n${failures.join('\n')}`,
  );
});

test('shipped JS files pass node --check', () => {
  for (const file of SHIPPED_JS) {
    const full = path.join(ROOT, file);
    assert.ok(fs.existsSync(full), `shipped JS file missing: ${file}`);
    const result = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' });
    assert.strictEqual(
      result.status,
      0,
      `${file} fails node --check:\n${result.stderr || result.stdout || '(no output)'}`,
    );
  }
});
