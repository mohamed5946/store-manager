const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(app.getPath('userData'), 'data');
const BACKUPS_TO_KEEP = 7;

function ensureDataDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

// كتابة ذرية: اكتب ملف مؤقت ثم أعد تسميته فوق الأصلي.
// لو الجهاز طفى أو البرنامج قفل في نص الكتابة، الملف الأصلي يفضل سليم
// (أسوأ حالة: يتبقى ملف .tmp يتيم، ويتمسح في الكتابة اللي بعدها).
function atomicWrite(file, text) {
  ensureDataDir(); // دفاع: لو مجلد الداتا اتمسح أو لم يُنشأ بعد، الكتابة لا تنهار
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function readDB(name) {
  const file = path.join(dataDir, `${name}.json`);
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}
function writeDB(name, data) {
  atomicWrite(path.join(dataDir, `${name}.json`), JSON.stringify(data, null, 2));
}
function readConfig() {
  const file = path.join(dataDir, 'config.json');
  if (!fs.existsSync(file)) return { companyName: 'Store Manager', currency: 'ج.م', lowStockLimit: 5 };
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function writeConfig(cfg) {
  atomicWrite(path.join(dataDir, 'config.json'), JSON.stringify(cfg, null, 2));
}

// نسخة احتياطية عند كل تشغيل: صورة كاملة من ملفات الداتا في مجلد مؤرخ،
// مع الاحتفاظ بآخر 7 نسخ فقط. الاسترجاع يدوي: انسخ ملفات النسخة فوق مجلد data.
// ملاحظة: النسخة بتتعمل قبل أي كتابة، فأي تلف لاحق في الجلسة له نسخة سليمة قبلها.
function backupDataDir() {
  try {
    ensureDataDir();
    const files = fs.readdirSync(dataDir).filter(f => {
      const p = path.join(dataDir, f);
      return f !== 'backups' && fs.statSync(p).isFile() && f.endsWith('.json');
    });
    if (!files.length) return; // أول تشغيل: مفيش داتا تتنسخ
    const backupsDir = path.join(dataDir, 'backups');
    if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(backupsDir, stamp);
    fs.mkdirSync(dest);
    files.forEach(f => fs.copyFileSync(path.join(dataDir, f), path.join(dest, f)));
    const dirs = fs.readdirSync(backupsDir)
      .filter(d => fs.statSync(path.join(backupsDir, d)).isDirectory())
      .sort();
    while (dirs.length > BACKUPS_TO_KEEP) {
      const old = dirs.shift();
      fs.rmSync(path.join(backupsDir, old), { recursive: true, force: true });
    }
  } catch { /* النسخ الاحتياطي لا يجب أن يمنع تشغيل البرنامج أبداً */ }
}

// تعديل مخزون منتج واحد. الحد الأدنى صفر: المخزون لا يصبح سالباً أبداً
// من جهة الـ main (واجهة البرنامج نفسها تمنع البيع فوق المتاح أصلاً).
function adjustStock(products, productId, delta) {
  const pi = products.findIndex(p => p.id === productId);
  if (pi !== -1) products[pi].stock = Math.max(0, (products[pi].stock || 0) + delta);
}

// تطبيق أثر فاتورة على المخزون.
// direction = -1 للبيع (ينقص)، +1 للشراء/مرتجع مبيعات (يزود).
function applyDocStock(products, items, direction) {
  (items || []).forEach(item => adjustStock(products, item.productId, direction * item.qty));
}
// عكس أثر فاتورة قديمة قبل تطبيق نسختها المعدلة.
function revertDocStock(products, items, direction) {
  applyDocStock(products, items, -direction);
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1100, minHeight: 700,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // webSecurity مفعّل: كل الموارد الخارجية https (الخطوط، Firebase، الصور)
      webSecurity: true
    },
    title: 'Store Manager', backgroundColor: '#070d16',
    show: false, frame: true, titleBarStyle: 'default'
  });
  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

app.whenReady().then(() => { ensureDataDir(); backupDataDir(); createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.on('win-minimize', () => mainWindow.minimize());
ipcMain.on('win-maximize', () => { if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize(); });
ipcMain.on('win-close', () => mainWindow.close());

ipcMain.handle('get-config', () => readConfig());
ipcMain.handle('save-config', (_, cfg) => { writeConfig(cfg); return true; });

ipcMain.handle('get-products', () => readDB('products'));
ipcMain.handle('save-product', (_, p) => {
  const list = readDB('products');
  if (!p.id) { p.id = Date.now().toString(); p.createdAt = new Date().toISOString(); }
  const i = list.findIndex(x => x.id === p.id);
  if (i !== -1) list[i] = p; else list.push(p);
  writeDB('products', list); return p;
});
ipcMain.handle('delete-product', (_, id) => { writeDB('products', readDB('products').filter(p => p.id !== id)); return true; });

ipcMain.handle('get-sales', () => readDB('sales'));
ipcMain.handle('save-sale', (_, sale) => {
  const sales = readDB('sales'); const products = readDB('products');
  const old = sale.id ? sales.find(s => s.id === sale.id) : null;
  // تعديل: عكس أثر الفاتورة القديمة أولاً، ثم تطبيق الجديدة
  if (old) revertDocStock(products, old.items, -1);
  if (!sale.id) { sale.id = Date.now().toString(); sale.date = new Date().toISOString(); }
  applyDocStock(products, sale.items, -1);
  writeDB('products', products);
  const i = sales.findIndex(s => s.id === sale.id);
  if (i !== -1) sales[i] = sale; else sales.push(sale);
  writeDB('sales', sales); return sale;
});
ipcMain.handle('delete-sale', (_, id) => {
  const sales = readDB('sales'); const s = sales.find(x => x.id === id);
  if (s) {
    const products = readDB('products');
    revertDocStock(products, s.items, -1); // حذف البيع يرجّع المخزون
    writeDB('products', products);
  }
  writeDB('sales', sales.filter(x => x.id !== id)); return true;
});

ipcMain.handle('get-purchases', () => readDB('purchases'));
ipcMain.handle('save-purchase', (_, purchase) => {
  const purchases = readDB('purchases'); const products = readDB('products');
  const old = purchase.id ? purchases.find(p => p.id === purchase.id) : null;
  // تعديل: عكس أثر الفاتورة القديمة (نقص الكميات القديمة) أولاً
  if (old) revertDocStock(products, old.items, +1);
  if (!purchase.id) { purchase.id = Date.now().toString(); purchase.date = new Date().toISOString(); }
  purchase.items.forEach(item => {
    const pi = products.findIndex(p => p.id === item.productId);
    if (pi !== -1) { products[pi].stock = (products[pi].stock || 0) + item.qty; products[pi].costPrice = item.unitCost; }
  });
  writeDB('products', products);
  const i = purchases.findIndex(p => p.id === purchase.id);
  if (i !== -1) purchases[i] = purchase; else purchases.push(purchase);
  writeDB('purchases', purchases); return purchase;
});
ipcMain.handle('delete-purchase', (_, id) => {
  const purchases = readDB('purchases'); const p = purchases.find(x => x.id === id);
  if (p) {
    const products = readDB('products');
    revertDocStock(products, p.items, +1); // حذف الشراء ينقص المخزون المضاف
    writeDB('products', products);
  }
  writeDB('purchases', purchases.filter(x => x.id !== id)); return true;
});

ipcMain.handle('get-returns', () => readDB('returns'));
ipcMain.handle('save-return', (_, ret) => {
  const returns = readDB('returns'); const products = readDB('products');
  const old = ret.id ? returns.find(r => r.id === ret.id) : null;
  // مرتجع مبيعات يزوّد المخزون (+1)، مرتجع مشتريات ينقصه (-1)
  const dir = ret.returnType === 'sale' ? +1 : -1;
  if (old) revertDocStock(products, old.items, old.returnType === 'sale' ? +1 : -1);
  if (!ret.id) { ret.id = Date.now().toString(); ret.date = new Date().toISOString(); }
  applyDocStock(products, ret.items, dir);
  writeDB('products', products);
  const i = returns.findIndex(r => r.id === ret.id);
  if (i !== -1) returns[i] = ret; else returns.push(ret); // إصلاح: كان يضيف نسخة جديدة دائماً حتى عند التعديل
  writeDB('returns', returns); return ret;
});
ipcMain.handle('delete-return', (_, id) => {
  const returns = readDB('returns'); const ret = returns.find(r => r.id === id);
  if (ret) {
    const products = readDB('products');
    revertDocStock(products, ret.items, ret.returnType === 'sale' ? +1 : -1);
    writeDB('products', products);
  }
  writeDB('returns', returns.filter(r => r.id !== id)); return true;
});

ipcMain.handle('get-customers', () => readDB('customers'));
ipcMain.handle('save-customer', (_, c) => {
  const list = readDB('customers');
  if (!c.id) { c.id = Date.now().toString(); c.createdAt = new Date().toISOString(); }
  const i = list.findIndex(x => x.id === c.id);
  if (i !== -1) list[i] = c; else list.push(c);
  writeDB('customers', list); return c;
});
ipcMain.handle('delete-customer', (_, id) => { writeDB('customers', readDB('customers').filter(c => c.id !== id)); return true; });

ipcMain.handle('get-suppliers', () => readDB('suppliers'));
ipcMain.handle('save-supplier', (_, s) => {
  const list = readDB('suppliers');
  if (!s.id) { s.id = Date.now().toString(); s.createdAt = new Date().toISOString(); }
  const i = list.findIndex(x => x.id === s.id);
  if (i !== -1) list[i] = s; else list.push(s);
  writeDB('suppliers', list); return s;
});
ipcMain.handle('delete-supplier', (_, id) => { writeDB('suppliers', readDB('suppliers').filter(s => s.id !== id)); return true; });

ipcMain.handle('get-expenses', () => readDB('expenses'));
ipcMain.handle('save-expense', (_, exp) => {
  const list = readDB('expenses');
  if (!exp.id) exp.id = Date.now().toString();
  const i = list.findIndex(e => e.id === exp.id);
  if (i !== -1) list[i] = exp; else list.push(exp);
  writeDB('expenses', list); return exp;
});
ipcMain.handle('delete-expense', (_, id) => { writeDB('expenses', readDB('expenses').filter(e => e.id !== id)); return true; });

ipcMain.handle('get-orders', () => readDB('orders'));
ipcMain.handle('save-order', (_, order) => {
  const list = readDB('orders');
  if (!order.id) order.id = Date.now().toString();
  const i = list.findIndex(o => o.id === order.id);
  if (i !== -1) list[i] = order; else list.push(order);
  writeDB('orders', list); return order;
});
ipcMain.handle('delete-order', (_, id) => { writeDB('orders', readDB('orders').filter(o => o.id !== id)); return true; });

// Write full snapshot for local disk persistence
ipcMain.handle('write-local-snapshot', (_, data) => {
  Object.entries(data).forEach(([key, val]) => {
    if (key === 'config') writeConfig(val);
    else writeDB(key, val);
  });
  return true;
});

// ════════════════════════════════════════
// In-app update (Hosting manifest, /updates/)
// The manifest is the same file the Flutter app reads:
// https://store-3384c.web.app/updates/version.json
// It carries an `exe` entry {url, sha256, size, version}. The check
// compares versions; the download verifies SHA-256 + size before the
// installer is launched. A failed or interrupted download leaves the
// installed version untouched; a corrupted file is deleted, never
// installed. The manifest fetch works without GitHub auth (Hosting is
// public); the artifact URL is the GitHub release link — for a private
// repo the in-app download may fail without auth, in which case the
// renderer opens the link in the browser (where the user is logged
// into GitHub).
// ════════════════════════════════════════
const MANIFEST_URL = 'https://store-3384c.web.app/updates/version.json';
const os = require('os');
const crypto = require('crypto');
const { shell } = require('electron');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

function compareVersions(a, b) {
  const pa = String(a).split('.').map(function (x) { return parseInt(x, 10) || 0; });
  const pb = String(b).split('.').map(function (x) { return parseInt(x, 10) || 0; });
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(function () { ctrl.abort(); }, ms || 15000);
  try {
    return await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
  } finally {
    clearTimeout(t);
  }
}

ipcMain.handle('check-update', async () => {
  try {
    const res = await fetchWithTimeout(MANIFEST_URL, 15000);
    if (!res.ok) return { updateAvailable: false, error: 'تعذر تحميل ملف التحديثات (HTTP ' + res.status + ')' };
    const manifest = await res.json();
    const exe = manifest && manifest.exe;
    if (!exe || !exe.version || !exe.url) return { updateAvailable: false, error: 'ملف التحديثات مش فيه إصدار EXE' };
    const current = app.getVersion();
    return {
      updateAvailable: compareVersions(exe.version, current) > 0,
      currentVersion: current,
      latestVersion: exe.version,
      url: exe.url,
      size: exe.size || 0,
      sha256: exe.sha256 || ''
    };
  } catch (e) {
    return { updateAvailable: false, error: e.name === 'AbortError' ? 'انتهت المهلة — مفيش اتصال؟' : (e.message || 'تعذر الفحص') };
  }
});

let updateDownloadPath = null;

ipcMain.handle('download-update', async () => {
  try {
    const res = await fetchWithTimeout(MANIFEST_URL, 15000);
    if (!res.ok) return { ok: false, error: 'تعذر تحميل ملف التحديثات (HTTP ' + res.status + ')' };
    const manifest = await res.json();
    const exe = manifest && manifest.exe;
    if (!exe || !exe.url) return { ok: false, error: 'مفيش رابط تنزيل في ملف التحديثات' };
    const dest = path.join(os.tmpdir(), 'Store.Manager.Setup.' + String(exe.version || 'latest').replace(/[^0-9A-Za-z.-]/g, '') + '.exe');
    const dl = await fetchWithTimeout(exe.url, 120000);
    if (!dl.ok || !dl.body) return { ok: false, error: 'تعذر تنزيل المثبّت (HTTP ' + dl.status + ')' };
    await pipeline(Readable.fromWeb(dl.body), fs.createWriteStream(dest));
    // verify size + SHA-256 before trusting the file
    const stat = fs.statSync(dest);
    if (exe.size && stat.size !== exe.size) {
      try { fs.unlinkSync(dest); } catch (e) {}
      return { ok: false, error: 'حجم الملف مش مطابق — التنزيل ناقص' };
    }
    if (exe.sha256) {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
      if (hash.toLowerCase() !== String(exe.sha256).toLowerCase()) {
        try { fs.unlinkSync(dest); } catch (e) {}
        return { ok: false, error: 'بصمة الملف مش مطابقة — الملف تالف' };
      }
    }
    updateDownloadPath = dest;
    return { ok: true, path: dest };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'انتهت المهلة أثناء التنزيل' : (e.message || 'تعذر التنزيل') };
  }
});

ipcMain.handle('install-update', async () => {
  if (!updateDownloadPath || !fs.existsSync(updateDownloadPath)) return { ok: false, error: 'مفيش ملف منزّل' };
  try {
    const { spawn } = require('child_process');
    const child = spawn(updateDownloadPath, [], { detached: true, stdio: 'ignore' });
    child.unref();
    // The installer takes over; quit so it can replace the app.
    setTimeout(function () { app.quit(); }, 500);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'تعذر تشغيل المثبّت' };
  }
});

ipcMain.handle('open-external', async (_, url) => {
  if (typeof url !== 'string' || url.indexOf('https://') !== 0) return false;
  await shell.openExternal(url);
  return true;
});
