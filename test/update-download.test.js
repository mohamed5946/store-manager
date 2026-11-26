// Tests for update-download.js (Store Manager PC — updater stall timeout
// + live progress). Spins up a local HTTP server; no network, no Electron.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');

const { downloadUpdateFile } = require(path.join(__dirname, '..', 'update-download.js'));

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'dl.exe');
}

// Local server; `handler` controls exactly what the client sees.
async function withServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return 'http://127.0.0.1:' + server.address().port + '/setup.exe';
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

test('success: streams the file, reports progress, verifies size + sha', async (t) => {
  const body = crypto.randomBytes(512 * 1024);
  const url = await withServer(t, (req, res) => {
    res.writeHead(200, { 'Content-Length': body.length, 'Content-Type': 'application/octet-stream' });
    // Send in chunks so progress fires more than once.
    const chunk = 64 * 1024;
    for (let off = 0; off < body.length; off += chunk) res.write(body.subarray(off, off + chunk));
    res.end();
  });
  const dest = tmpFile(t);
  const events = [];
  const result = await downloadUpdateFile({
    url, dest, expectedSize: body.length, expectedSha256: sha256(body),
    onProgress: (p) => events.push(p)
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.path, dest);
  assert.equal(fs.statSync(dest).size, body.length);
  assert.deepEqual(fs.readFileSync(dest), body);
  assert.ok(events.length >= 1, 'expected at least one progress event');
  assert.equal(events[events.length - 1].received, body.length);
  assert.equal(events[events.length - 1].total, body.length);
  assert.ok(events.every((e) => e.received <= e.total), 'received never exceeds total');
});

test('stall: aborts when no bytes arrive for the stall window, deletes the file', async (t) => {
  const url = await withServer(t, (req, res) => {
    res.writeHead(200, { 'Content-Length': 1024 * 1024 });
    res.write(Buffer.alloc(1024)); // one chunk, then silence forever
    // Never res.end() — the connection just stalls.
  });
  const dest = tmpFile(t);
  const started = Date.now();
  const result = await downloadUpdateFile({ url, dest, stallMs: 1500, ttfbMs: 5000 });
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.match(result.error, /مفيش بيانات وصلت لمدة دقيقة/);
  assert.ok(elapsed < 10000, 'must abort promptly, not hang (took ' + elapsed + 'ms)');
  assert.equal(fs.existsSync(dest), false, 'partial file must be deleted');
});

test('slow but flowing: completes when bytes keep arriving, even past the stall window', async (t) => {
  // 6 chunks x 400ms = ~2.4s total, longer than the 1200ms stall budget —
  // a hard total cap would kill this; the stall rule must let it finish.
  const body = crypto.randomBytes(6 * 1024);
  const url = await withServer(t, (req, res) => {
    res.writeHead(200, { 'Content-Length': body.length });
    let off = 0;
    const timer = setInterval(() => {
      if (off >= body.length) { clearInterval(timer); res.end(); return; }
      res.write(body.subarray(off, off + 1024));
      off += 1024;
    }, 400);
    req.on('close', () => clearInterval(timer));
  });
  const dest = tmpFile(t);
  const result = await downloadUpdateFile({
    url, dest, expectedSize: body.length, expectedSha256: sha256(body),
    stallMs: 1200, ttfbMs: 5000
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(fs.readFileSync(dest), body);
});

test('size mismatch: rejects and deletes the file', async (t) => {
  const body = crypto.randomBytes(4096);
  const url = await withServer(t, (req, res) => {
    res.writeHead(200, { 'Content-Length': body.length });
    res.end(body);
  });
  const dest = tmpFile(t);
  const result = await downloadUpdateFile({ url, dest, expectedSize: body.length + 1, expectedSha256: sha256(body) });
  assert.equal(result.ok, false);
  assert.match(result.error, /حجم الملف مش مطابق/);
  assert.equal(fs.existsSync(dest), false);
});

test('sha mismatch: rejects and deletes the file', async (t) => {
  const body = crypto.randomBytes(4096);
  const url = await withServer(t, (req, res) => {
    res.writeHead(200, { 'Content-Length': body.length });
    res.end(body);
  });
  const dest = tmpFile(t);
  const result = await downloadUpdateFile({ url, dest, expectedSize: body.length, expectedSha256: '00'.repeat(32) });
  assert.equal(result.ok, false);
  assert.match(result.error, /بصمة الملف مش مطابقة/);
  assert.equal(fs.existsSync(dest), false);
});

test('time-to-first-byte: aborts when headers never arrive', async (t) => {
  const url = await withServer(t, (req, res) => {
    // Never write anything — headers stall.
  });
  const dest = tmpFile(t);
  const started = Date.now();
  const result = await downloadUpdateFile({ url, dest, ttfbMs: 800, stallMs: 60000 });
  assert.equal(result.ok, false);
  assert.match(result.error, /انتهت المهلة أثناء التنزيل/);
  assert.ok(Date.now() - started < 10000, 'TTFB abort must be prompt');
  assert.equal(fs.existsSync(dest), false);
});

test('HTTP error: reports the status instead of hanging', async (t) => {
  const url = await withServer(t, (req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  const dest = tmpFile(t);
  const result = await downloadUpdateFile({ url, dest });
  assert.equal(result.ok, false);
  assert.match(result.error, /HTTP 404/);
  assert.equal(fs.existsSync(dest), false);
});

test('unknown total: progress still reports received bytes', async (t) => {
  const body = crypto.randomBytes(8192);
  const url = await withServer(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); // no Content-Length
    res.end(body);
  });
  const dest = tmpFile(t);
  const events = [];
  const result = await downloadUpdateFile({
    url, dest, expectedSize: body.length, expectedSha256: sha256(body),
    onProgress: (p) => events.push(p)
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(events.length >= 1);
  assert.equal(events[events.length - 1].received, body.length);
  assert.equal(events[events.length - 1].total, 0);
});
