// Streaming EXE download for the in-app updater (Store Manager PC).
//
// Why this exists: the old code did `fetchWithTimeout(exe.url, 120000)`
// and then piped the whole body with NO timeout and NO progress. The
// 120s timer only covered time-to-first-byte — once headers arrived the
// timer was cleared in `finally`, so a connection that stalled
// mid-download hung forever while the renderer sat on a static
// 'جارٍ التنزيل…' with no way to tell.
//
// This module instead:
//   1. Time-to-first-byte: ~15s for the response headers (TTFB_MS).
//   2. Stall timeout: after headers, abort ONLY if no bytes arrive for
//      ~60s (STALL_MS). A 130 MB file on a slow connection is allowed to
//      finish as long as bytes keep flowing — there is no hard total cap.
//   3. Live progress: onProgress({received, total}) is called (throttled
//      to ~200ms) so the renderer can show percent + MB.
//   4. Verification is unchanged: size + SHA-256 are checked after the
//      download, and a bad file is deleted, never installed.
//
// Pure Node (fs/crypto/stream/fetch) with no Electron dependency, so it
// is unit-testable from plain node — see test/update-download.test.js.
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable, Transform } = require('stream');

const TTFB_MS = 15000; // time to response headers
const STALL_MS = 60000; // abort if no bytes arrive for this long
const PROGRESS_MIN_MS = 200; // throttle progress callbacks

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function unlinkQuiet(file) {
  try { fs.unlinkSync(file); } catch (e) { /* already gone — fine */ }
}

async function downloadUpdateFile(opts) {
  const {
    url,
    dest,
    expectedSize,
    expectedSha256,
    onProgress,
    ttfbMs = TTFB_MS,
    stallMs = STALL_MS,
    fetchImpl = fetch
  } = opts || {};
  if (!url || !dest) return { ok: false, error: 'مفيش رابط تنزيل في ملف التحديثات' };

  const ctrl = new AbortController();
  let stalled = false;

  // --- 1. Time-to-first-byte -------------------------------------------
  const ttfbTimer = setTimeout(() => ctrl.abort(), ttfbMs);
  let res;
  try {
    res = await fetchImpl(url, { signal: ctrl.signal, redirect: 'follow' });
  } catch (e) {
    clearTimeout(ttfbTimer);
    return { ok: false, error: e && e.name === 'AbortError' ? 'انتهت المهلة أثناء التنزيل' : (e && e.message) || 'تعذر التنزيل' };
  }
  clearTimeout(ttfbTimer);
  if (!res.ok || !res.body) {
    return { ok: false, error: 'تعذر تنزيل المثبّت (HTTP ' + res.status + ')' };
  }
  let total = 0;
  try {
    total = Number(res.headers && res.headers.get ? res.headers.get('content-length') : 0) || 0;
  } catch (e) { total = 0; }

  // --- 2. Stream the body with a stall watchdog ------------------------
  let received = 0;
  let lastByteAt = Date.now();
  let lastEmitAt = 0;
  const stallTimer = setInterval(() => {
    if (Date.now() - lastByteAt > stallMs) {
      stalled = true;
      ctrl.abort();
    }
  }, 1000);
  // Unref so a stuck timer can never keep the app alive on its own.
  if (stallTimer.unref) stallTimer.unref();

  const tracker = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      lastByteAt = Date.now();
      if (onProgress) {
        const now = Date.now();
        if (now - lastEmitAt >= PROGRESS_MIN_MS || (total > 0 && received >= total)) {
          lastEmitAt = now;
          try { onProgress({ received, total }); } catch (e) { /* progress must never break the download */ }
        }
      }
      cb(null, chunk);
    }
  });

  try {
    await pipeline(
      Readable.fromWeb(res.body, { signal: ctrl.signal }),
      tracker,
      fs.createWriteStream(dest)
    );
  } catch (e) {
    clearInterval(stallTimer);
    unlinkQuiet(dest);
    if (stalled || (e && e.name === 'AbortError')) {
      return { ok: false, error: stalled ? 'توقف التنزيل — مفيش بيانات وصلت لمدة دقيقة' : 'انتهت المهلة أثناء التنزيل' };
    }
    return { ok: false, error: (e && e.message) || 'تعذر التنزيل' };
  }
  clearInterval(stallTimer);
  if (onProgress) {
    try { onProgress({ received, total }); } catch (e) {}
  }

  // --- 3. Verify size + SHA-256 before trusting the file ---------------
  try {
    const stat = fs.statSync(dest);
    if (expectedSize && stat.size !== expectedSize) {
      unlinkQuiet(dest);
      return { ok: false, error: 'حجم الملف مش مطابق — التنزيل ناقص' };
    }
    if (expectedSha256) {
      const hash = await sha256File(dest);
      if (hash.toLowerCase() !== String(expectedSha256).toLowerCase()) {
        unlinkQuiet(dest);
        return { ok: false, error: 'بصمة الملف مش مطابقة — الملف تالف' };
      }
    }
  } catch (e) {
    unlinkQuiet(dest);
    return { ok: false, error: (e && e.message) || 'تعذر التحقق من الملف' };
  }
  return { ok: true, path: dest };
}

module.exports = { downloadUpdateFile, TTFB_MS, STALL_MS };
