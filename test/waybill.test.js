// Tests for the waybill (بوليصة شحن) — pure helpers in waybill.js
// plus structural checks that index.html wires the feature in.
// No Firebase, no network, no DOM.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const Waybill = require(path.join(__dirname, '..', 'waybill.js'));
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// ---- Arabic number-to-words (tafqeet) ----
test('amountToArabicWords: ones, teens, tens', () => {
  assert.equal(Waybill.amountToArabicWords(0), 'صفر');
  assert.equal(Waybill.amountToArabicWords(1), 'واحد');
  assert.equal(Waybill.amountToArabicWords(2), 'اثنان');
  assert.equal(Waybill.amountToArabicWords(10), 'عشرة');
  assert.equal(Waybill.amountToArabicWords(11), 'أحد عشر');
  assert.equal(Waybill.amountToArabicWords(12), 'اثنا عشر');
  assert.equal(Waybill.amountToArabicWords(19), 'تسعة عشر');
  assert.equal(Waybill.amountToArabicWords(20), 'عشرون');
  assert.equal(Waybill.amountToArabicWords(21), 'واحد وعشرون');
  assert.equal(Waybill.amountToArabicWords(99), 'تسعة وتسعون');
});

test('amountToArabicWords: hundreds and the approved example 1810', () => {
  assert.equal(Waybill.amountToArabicWords(100), 'مائة');
  assert.equal(Waybill.amountToArabicWords(101), 'مائة وواحد');
  assert.equal(Waybill.amountToArabicWords(200), 'مائتان');
  assert.equal(Waybill.amountToArabicWords(810), 'ثمانمائة وعشرة');
  assert.equal(Waybill.amountToArabicWords(1810), 'ألف وثمانمائة وعشرة');
  assert.equal(Waybill.amountToArabicWords(1750), 'ألف وسبعمائة وخمسون');
});

test('amountToArabicWords: thousands and millions', () => {
  assert.equal(Waybill.amountToArabicWords(1000), 'ألف');
  assert.equal(Waybill.amountToArabicWords(2000), 'ألفان');
  assert.equal(Waybill.amountToArabicWords(3000), 'ثلاثة آلاف');
  assert.equal(Waybill.amountToArabicWords(10000), 'عشرة آلاف');
  assert.equal(Waybill.amountToArabicWords(11000), 'أحد عشر ألفاً');
  assert.equal(Waybill.amountToArabicWords(2500), 'ألفان وخمسمائة');
  assert.equal(Waybill.amountToArabicWords(100000), 'مائة ألف');
  assert.equal(Waybill.amountToArabicWords(200000), 'مائتا ألف');
  assert.equal(Waybill.amountToArabicWords(1000000), 'مليون');
  assert.equal(Waybill.amountToArabicWords(2000000), 'مليونان');
  // Rounding + negatives never produce words for a negative amount.
  assert.equal(Waybill.amountToArabicWords(-5), 'صفر');
  assert.equal(Waybill.amountToArabicWords(1810.4), 'ألف وثمانمائة وعشرة');
});

test('codWordsLine: currency wording, 1/2 special forms, 0 empty', () => {
  assert.equal(Waybill.codWordsLine(0), '');
  assert.equal(Waybill.codWordsLine(1), 'جنيه مصري واحد فقط لا غير');
  assert.equal(Waybill.codWordsLine(2), 'جنيهان مصريان فقط لا غير');
  assert.equal(Waybill.codWordsLine(1810), 'ألف وثمانمائة وعشرة جنيهات مصرية فقط لا غير');
});

// ---- Data builder: a realistic store order ----
function sampleOrder() {
  return {
    id: 'ord_abc123456789',
    createdAt: '2026-11-26T10:00:00.000Z',
    customer: { name: 'أحمد محمود حسن', phone: '01012345678', email: '', address: '24 شارع جامعة الدول العربية' },
    customerPhone2: '01123456789',
    governorate: 'giza',
    detailedAddress: '24 شارع جامعة الدول العربية، المهندسين',
    items: [
      { name: 'سماعات بلوتوث لاسلكية — أسود', qty: 1, price: 850, subtotal: 850 },
      { name: 'حقيبة ظهر مقاومة للماء — كحلي', qty: 2, price: 450, subtotal: 900 }
    ],
    deliveryFee: 60,
    total: 1810,
    amountDue: 1810,
    status: 'new',
    paymentStatus: 'cod_pending',
    shippingCompanyId: 'aramex',
    notes: 'الاتصال قبل الوصول بربع ساعة'
  };
}

test('buildWaybillData: real order data, totals, phones, address', () => {
  const d = Waybill.buildWaybillData(sampleOrder(), 'أرامكس', { dateStr: '11/26/2026', govName: 'الجيزة' });
  assert.equal(d.orderNo, '456789'); // last 6 of the id, like the table
  assert.equal(d.customer.name, 'أحمد محمود حسن');
  assert.equal(d.customer.governorate, 'الجيزة');
  assert.equal(d.customer.address, '24 شارع جامعة الدول العربية، المهندسين');
  assert.equal(d.customer.phone, '01012345678');
  assert.equal(d.customer.phone2, '01123456789');
  assert.equal(d.shipCompany, 'أرامكس');
  assert.equal(d.items.length, 2);
  assert.equal(d.items[1].lineTotal, 900);
  assert.equal(d.subtotal, 1750);
  assert.equal(d.deliveryFee, 60);
  assert.equal(d.due, 1810);
  assert.equal(d.cod, 1810);
  assert.equal(d.codWords, 'ألف وثمانمائة وعشرة جنيهات مصرية فقط لا غير');
  assert.equal(d.notes, 'الاتصال قبل الوصول بربع ساعة');
  assert.equal(d.contactPhone, '01557887719');
});

test('buildWaybillData: missing shipping company falls back to أرامكس', () => {
  assert.equal(Waybill.buildWaybillData(sampleOrder(), '-', {}).shipCompany, 'أرامكس');
  assert.equal(Waybill.buildWaybillData(sampleOrder(), '', {}).shipCompany, 'أرامكس');
  assert.equal(Waybill.buildWaybillData(sampleOrder(), null, {}).shipCompany, 'أرامكس');
  assert.equal(Waybill.buildWaybillData(sampleOrder(), 'شركة النيل', {}).shipCompany, 'شركة النيل');
});

test('buildWaybillData: flat customer fields + paid order collects 0', () => {
  const flat = { id: 'x1', customerName: 'سارة', customerPhone: '01200000000', customerAddress: 'القاهرة',
    items: [{ productId: 'p1', qty: 3, price: 100 }], total: 300, paymentStatus: 'cod_paid' };
  const d = Waybill.buildWaybillData(flat, 'أرامكس', {});
  assert.equal(d.customer.name, 'سارة');
  assert.equal(d.customer.phone, '01200000000');
  assert.equal(d.subtotal, 300);
  assert.equal(d.due, 300);
  assert.equal(d.cod, 0); // already paid: nothing to collect
  assert.equal(d.codWords, '');
  assert.equal(d.deliveryFee, null);
});

test('buildWaybillData: preview edits win; clearing notes really clears them', () => {
  const d = Waybill.buildWaybillData(sampleOrder(), 'أرامكس', {
    address: 'عنوان معدل قبل الطباعة', phone: '01099999999', notes: ''
  });
  assert.equal(d.customer.address, 'عنوان معدل قبل الطباعة');
  assert.equal(d.customer.phone, '01099999999');
  assert.equal(d.notes, '');
  // Without overrides the order's own notes survive.
  assert.equal(Waybill.buildWaybillData(sampleOrder(), 'أرامكس', {}).notes, 'الاتصال قبل الوصول بربع ساعة');
});

// ---- Sheet HTML: the approved shape ----
test('waybillSheetHtml: approved layout, order, and compact print', () => {
  const d = Waybill.buildWaybillData(sampleOrder(), 'أرامكس', { dateStr: '11/26/2026', govName: 'الجيزة' });
  const sheet = Waybill.waybillSheetHtml(d, true);
  // Brand alone on top, no sender section anywhere.
  assert.ok(sheet.includes('<h1>المتجر</h1>'));
  assert.ok(!sheet.includes('المرسل'));
  assert.ok(!sheet.includes('بيانات المرسل'));
  // Demo-only artefacts from the mockup must NOT ship.
  assert.ok(!sheet.includes('نموذج تجريبي'));
  assert.ok(!sheet.includes('watermark'));
  // Customer box, then shipping company, then items — in that order.
  const iCust = sheet.indexOf('بيانات العميل (المستلم)');
  const iShip = sheet.indexOf('شركة الشحن:');
  const iItems = sheet.indexOf('تفاصيل الطلب');
  const iCod = sheet.indexOf('المبلغ المطلوب تحصيله عند الاستلام');
  const iFoot = sheet.indexOf('للتواصل معنا:');
  assert.ok(iCust > 0 && iShip > iCust && iItems > iShip && iCod > iItems && iFoot > iCod);
  // Real data throughout: phones (primary + backup), address, items, totals.
  assert.ok(sheet.includes('01012345678'));
  assert.ok(sheet.includes('01123456789'));
  assert.ok(sheet.includes('المهندسين'));
  assert.ok(sheet.includes('سماعات بلوتوث'));
  assert.ok(sheet.includes('1,750'));
  assert.ok(sheet.includes('1,810'));
  // COD in figures + words.
  assert.ok(sheet.includes('1,810'));
  assert.ok(sheet.includes('ألف وثمانمائة وعشرة جنيهات مصرية فقط لا غير'));
  // Footer contact, compact 150mm sheet, A4 page.
  assert.ok(sheet.includes('01557887719'));
  assert.ok(sheet.includes('واتساب ومكالمات'));
  assert.ok(sheet.includes('150mm'));
  assert.ok(sheet.includes('@page{size:A4'));
  // Editable preview: contenteditable fields + edit note.
  assert.ok(sheet.includes('contenteditable="true"'));
  assert.ok(sheet.includes('data-wb="address"'));
  assert.ok(sheet.includes('data-wb="phone"'));
  assert.ok(sheet.includes('data-wb="phone2"'));
  assert.ok(sheet.includes('data-wb="shipco"'));
  assert.ok(sheet.includes('قابلة للتعديل هنا قبل الطباعة'));
  // Print version: no editable fields, no edit note.
  const print = Waybill.waybillSheetHtml(d, false);
  assert.ok(!print.includes('contenteditable'));
  assert.ok(!print.includes('قابلة للتعديل هنا قبل الطباعة'));
  // Explicit ink on table cells: the app's global td{color:var(--t1)}
  // (cream in the dark theme) would otherwise beat the sheet's
  // inherited colour and print the rows near-invisible on white.
  const css = Waybill.waybillSheetHtml(d, false).split('</style>')[0];
  assert.ok(css.includes('.wb-items tbody td{') && css.includes('color:#23232B'));
  assert.ok(css.includes('.wb-items tfoot td{') && css.includes('color:#23232B'));
  // User data is escaped, never raw HTML.
  const evil = Waybill.buildWaybillData({ id: 'e1', customerName: '<script>alert(1)</script>', items: [] }, 'أرامكس', {});
  assert.ok(!Waybill.waybillSheetHtml(evil, false).includes('<script>alert(1)'));
});

test('waybillPrintDoc: complete print document calling window.print()', () => {
  const d = Waybill.buildWaybillData(sampleOrder(), 'أرامكس', {});
  const doc = Waybill.waybillPrintDoc(d);
  assert.ok(doc.startsWith('<!DOCTYPE html>'));
  assert.ok(doc.includes('dir="rtl"'));
  assert.ok(doc.includes('بوليصة شحن #456789'));
  assert.ok(doc.includes('window.print()'));
  assert.ok(doc.includes('المتجر'));
});

// ---- Wiring in index.html ----
test('index.html wires the waybill in: scripts, buttons, functions', () => {
  assert.ok(html.includes('<script src="waybill.js"></script>'));
  assert.ok(html.includes('function printWaybill(id)'));
  assert.ok(html.includes('function doPrintWaybill(id)'));
  // Button in the store-orders table + button in the order detail modal.
  const calls = html.match(/onclick="printWaybill\('/g) || [];
  assert.ok(calls.length >= 2, 'expected >=2 printWaybill buttons, got ' + calls.length);
  assert.ok(html.includes("onclick=\"doPrintWaybill('"));
  // Print goes through the existing print-window pattern.
  assert.ok(html.includes('Waybill.waybillPrintDoc(d)'));
  assert.ok(html.includes('Waybill.waybillSheetHtml(d, true)'));
});
