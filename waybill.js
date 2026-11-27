// ════════════════════════════════════════════════════════════════
// WAYBILL (بوليصة شحن) — pure helpers for Store Manager (PC).
// No DOM, no Firebase: buildWaybillData() normalizes a store order
// into waybill data, amountToArabicWords() writes the COD amount in
// words, and waybillSheetHtml()/waybillPrintDoc() render the approved
// compact sheet (150mm, top of A4 — mockup "بوليصة شحن — نموذج").
// Loaded by index.html as a plain <script>; unit-tested in
// test/waybill.test.js via module.exports.
// ════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  // Store contact line printed at the bottom of every waybill
  // (approved shape, 2nd revision 2026-11-27).
  var CONTACT_PHONE = '01557887719';
  // Shown in the shipping-company field when the order has none.
  var DEFAULT_SHIP_COMPANY = 'أرامكس';

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---- Amount formatting: integers plain, fractions with 2 decimals ----
  function fmtAmount(n) {
    n = Number(n) || 0;
    if (Number.isInteger(n)) return n.toLocaleString('en-US');
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // ---- Arabic number-to-words (Egyptian/standard wording, integers) ----
  // Covers 0 .. 999,999,999 — far above any real COD amount.
  var ONES = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة',
    'ثمانية', 'تسعة', 'عشرة', 'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر',
    'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
  var TENS = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون',
    'ثمانون', 'تسعون'];
  var HUNDREDS = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة',
    'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];

  function under100(n) {
    if (n < 20) return ONES[n];
    var t = Math.floor(n / 10), o = n % 10;
    return o ? ONES[o] + ' و' + TENS[t] : TENS[t];
  }
  function under1000(n) {
    var h = Math.floor(n / 100), r = n % 100;
    if (!h) return under100(r);
    return r ? HUNDREDS[h] + ' و' + under100(r) : HUNDREDS[h];
  }
  // one/two/few/many forms, e.g. ألف / ألفان / آلاف / ألفاً.
  // 100+ takes the singular again (مائة ألف، مائتا ألف).
  function scalePart(n, one, two, few, many) {
    var q = Math.floor(n / 1000), r = n % 1000;
    var qw = under1000(q);
    if (q === 200) qw = 'مائتا'; // مائتا ألف، لا مائتان ألف
    var head;
    if (q === 1) head = one;
    else if (q === 2) head = two;
    else if (q >= 3 && q <= 10) head = qw + ' ' + few;
    else if (q >= 100) head = qw + ' ' + one;
    else head = qw + ' ' + many;
    return r ? head + ' و' + under1000(r) : head;
  }
  function amountToArabicWords(n) {
    n = Math.round(Number(n) || 0);
    if (n < 0) n = 0;
    if (n === 0) return 'صفر';
    var parts = [];
    var millions = Math.floor(n / 1000000);
    var rest = n % 1000000;
    if (millions) parts.push(scalePart(millions * 1000, 'مليون', 'مليونان', 'ملايين', 'مليوناً'));
    var thousands = Math.floor(rest / 1000);
    rest = rest % 1000;
    if (thousands) parts.push(scalePart(thousands * 1000, 'ألف', 'ألفان', 'آلاف', 'ألفاً'));
    if (rest) parts.push(under1000(rest));
    return parts.join(' و');
  }

  // Full COD words line, with the currency wording.
  function codWordsLine(cod) {
    cod = Math.round(Number(cod) || 0);
    if (cod === 0) return '';
    if (cod === 1) return 'جنيه مصري واحد فقط لا غير';
    if (cod === 2) return 'جنيهان مصريان فقط لا غير';
    return amountToArabicWords(cod) + ' جنيهات مصرية فقط لا غير';
  }

  function firstNonEmpty() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v);
    }
    return '';
  }

  // ---- Normalize a store order into waybill data ----
  // order: a storeOrders entry (customer object OR flat customer*
  // fields, items[], amountDue/total, deliveryFee, governorate,
  // detailedAddress, customerPhone2, notes, paymentStatus, id).
  // shipName: resolved shipping-company name (storeShipName) — falls
  // back to DEFAULT_SHIP_COMPANY when missing/'-'.
  // opts: { dateStr, waybillDate, govName, currency, name, governorate,
  //   address, phone, phone2, shipco, notes } — the last seven are
  //   the fields the user may have edited in the preview; they win.
  function buildWaybillData(order, shipName, opts) {
    opts = opts || {};
    var o = order || {};
    var cust = (o.customer && typeof o.customer === 'object') ? o.customer : {};
    var items = (o.items || []).map(function (it) {
      var qty = Number(it.qty) || 0;
      var unit = Number(it.price) || 0;
      var line = (it.subtotal != null) ? Number(it.subtotal) || 0 : unit * qty;
      return { name: it.name || it.productId || '', qty: qty, unitPrice: unit, lineTotal: line };
    });
    var subtotal = (o.subtotal != null) ? Number(o.subtotal) || 0
      : items.reduce(function (a, it) { return a + it.lineTotal; }, 0);
    var fee = (o.deliveryFee != null) ? Number(o.deliveryFee) || 0 : null;
    var due = (o.amountDue != null) ? Number(o.amountDue) || 0
      : (o.total != null ? Number(o.total) || 0 : subtotal + (fee || 0));
    var cod = (o.paymentStatus === 'cod_paid') ? 0 : due;
    return {
      orderNo: String(o.id || '').slice(-6) || '—',
      orderDate: opts.dateStr || '',
      waybillDate: opts.waybillDate || new Date().toLocaleDateString('en-GB'),
      customer: {
        name: firstNonEmpty(opts.name, cust.name, o.customerName),
        governorate: firstNonEmpty(opts.govName, opts.governorate, cust.governorate, o.governorate),
        address: firstNonEmpty(opts.address, o.detailedAddress, cust.address, o.customerAddress),
        phone: firstNonEmpty(opts.phone, cust.phone, o.customerPhone),
        phone2: firstNonEmpty(opts.phone2, o.customerPhone2)
      },
      shipCompany: firstNonEmpty(opts.shipco, shipName) === '-' || !firstNonEmpty(opts.shipco, shipName)
        ? DEFAULT_SHIP_COMPANY : firstNonEmpty(opts.shipco, shipName),
      items: items,
      subtotal: subtotal,
      deliveryFee: fee,
      due: due,
      cod: cod,
      codWords: codWordsLine(cod),
      // Notes: an explicit opts.notes (even '') wins — clearing the
      // notes in the preview really clears them on the printout.
      notes: (opts.notes !== undefined && opts.notes !== null) ? String(opts.notes) : firstNonEmpty(o.notes),
      currency: opts.currency || 'ج.م',
      contactPhone: CONTACT_PHONE
    };
  }

  // ---- Sheet CSS (approved mockup, scoped wb-*; no demo strip, no watermark) ----
  var SHEET_CSS = [
    '.wb-sheet{position:relative;width:min(150mm,100%);margin:14px auto 28px;background:#FFFDF8;',
    'padding:7mm 7mm 6mm;border:1.5px solid #D8D2C4;box-shadow:0 4px 28px rgba(28,40,90,.14);',
    'font-family:"Cairo","Segoe UI",Tahoma,sans-serif;color:#23232B;direction:rtl;text-align:right;',
    '-webkit-print-color-adjust:exact;print-color-adjust:exact;overflow:hidden}',
    '.wb-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;',
    'border-bottom:2.5px solid #1C285A;padding-bottom:8px}',
    '.wb-brand h1{margin:0;font-size:24px;font-weight:900;color:#1C285A;line-height:1.15}',
    '.wb-title{text-align:left}.wb-title .t{font-size:16px;font-weight:900;color:#FF7A1A;margin:0;line-height:1.2}',
    '.wb-title .meta{font-size:11.5px;color:#23232B;margin-top:2px;line-height:1.6}',
    '.wb-title .meta b{color:#1C285A}',
    '.wb-barcode{margin-top:4px;height:22px;border-radius:2px;background:repeating-linear-gradient(to left,',
    '#23232B 0 2px,transparent 2px 5px,#23232B 5px 6px,transparent 6px 10px,#23232B 10px 13px,',
    'transparent 13px 16px,#23232B 16px 17px,transparent 17px 21px,#23232B 21px 24px,transparent 24px 27px)}',
    '.wb-barcode-num{font-size:10px;letter-spacing:3px;color:#6B6B76;text-align:center;margin-top:2px;direction:ltr}',
    '.wb-box{border:1.5px solid #1C285A;border-radius:6px;overflow:hidden;margin-top:9px}',
    '.wb-box h2{margin:0;background:#1C285A;color:#fff;font-size:12.5px;font-weight:800;padding:3px 9px}',
    '.wb-box .body{padding:6px 9px 7px;font-size:12px;line-height:1.75}',
    '.wb-row{display:flex;gap:5px}.wb-lbl{color:#6B6B76;font-weight:700;white-space:nowrap;min-width:62px}',
    '.wb-val{font-weight:700;color:#23232B}.wb-phone{direction:ltr;unicode-bidi:embed;font-weight:800;color:#1C285A;letter-spacing:.4px}',
    '.wb-editable{border-bottom:1.5px dashed #FF7A1A;padding:0 2px;outline:none;min-width:40px;display:inline-block}',
    '.wb-editable:focus{background:#FFF3E6;border-bottom-style:solid}',
    '.wb-edit-note{margin:5px 2px 0;font-size:11px;color:#6B6B76}',
    '.wb-edit-note::before{content:"✎ ";color:#FF7A1A;font-weight:900}',
    '.wb-shipco{margin-top:9px;border:1.5px solid #1C285A;border-radius:6px;display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:12.5px}',
    '.wb-shipco .lbl{font-weight:900;color:#1C285A;white-space:nowrap}.wb-shipco .val{font-weight:700;color:#23232B}',
    '.wb-items{margin-top:10px}.wb-items h2{margin:0 0 5px;font-size:13.5px;font-weight:900;color:#1C285A}',
    '.wb-items table{width:100%;border-collapse:collapse;font-size:12px}',
    '.wb-items thead th{background:#1C285A;color:#fff;font-weight:800;padding:4px 8px;text-align:right;border:1px solid #1C285A}',
    '.wb-items tbody td{padding:4px 8px;border:1px solid #D8D2C4;font-weight:600;color:#23232B}',
    '.wb-items tbody tr:nth-child(even) td{background:#FBF8F1}',
    '.wb-items td.num,.wb-items th.num{text-align:center;width:48px}',
    '.wb-items td.price,.wb-items th.price{text-align:left;width:82px}',
    '.wb-items tfoot td{padding:4px 8px;border:1px solid #D8D2C4;font-weight:700;color:#23232B}',
    '.wb-items tfoot .grand td{background:#F7F2EA;font-size:13.5px;font-weight:900;color:#1C285A;border-top:2px solid #1C285A}',
    '.wb-cod{margin-top:10px;border:2.5px solid #FF7A1A;border-radius:8px;display:flex;align-items:center;',
    'justify-content:space-between;gap:10px;padding:8px 12px;background:#FFF7EE;flex-wrap:wrap}',
    '.wb-cod .cap{font-size:13.5px;font-weight:900;color:#1C285A;line-height:1.5}',
    '.wb-cod .cap small{display:block;font-size:11px;color:#6B6B76;font-weight:600}',
    '.wb-cod .amount{font-size:23px;font-weight:900;color:#FF7A1A;white-space:nowrap}',
    '.wb-cod .words{width:100%;font-size:11.5px;color:#23232B;font-weight:700;border-top:1px dashed #D8D2C4;padding-top:5px}',
    '.wb-notes{margin-top:10px;font-size:12px}.wb-notes .lbl{font-weight:800;color:#1C285A}',
    '.wb-notes .line{border-bottom:1.5px dotted #6B6B76;min-height:20px;margin-top:2px;color:#23232B}',
    '.wb-date{margin-top:16px;max-width:55%}.wb-date .role{font-size:12.5px;font-weight:800;color:#1C285A}',
    '.wb-date .name{font-size:12px;font-weight:600;margin-top:2px}',
    '.wb-foot{margin-top:14px;border-top:2px solid #1C285A;padding-top:6px;text-align:center;font-size:10px;font-weight:600;color:#6B6B76}',
    '.wb-foot .wb-phone{font-size:10px}',
    '@page{size:A4;margin:10mm}',
    '@media print{.wb-sheet{width:150mm;margin:0 auto;box-shadow:none}.wb-editable{border-bottom:none}.wb-edit-note{display:none!important}}'
  ].join('\n');

  // ---- Sheet HTML. editable=true: contenteditable fields + edit note
  // (preview modal). editable=false: clean print version. ----
  function waybillSheetHtml(d, editable) {
    var ed = editable ? ' contenteditable="true"' : '';
    var rows = (d.items || []).map(function (it) {
      return '<tr><td>' + escHtml(it.name) + '</td>' +
        '<td class="price">' + fmtAmount(it.unitPrice) + ' ' + escHtml(d.currency) + '</td>' +
        '<td class="num">' + it.qty + '</td>' +
        '<td class="price">' + fmtAmount(it.lineTotal) + ' ' + escHtml(d.currency) + '</td></tr>';
    }).join('') || '<tr><td colspan="4">—</td></tr>';
    var feeCell = d.deliveryFee == null ? '—'
      : (d.deliveryFee === 0 ? 'مجاني' : fmtAmount(d.deliveryFee) + ' ' + escHtml(d.currency));
    var codBlock = d.cod === 0
      ? '<div class="cap">المبلغ المطلوب تحصيله عند الاستلام<small>الدفع عند الاستلام (COD) — يُحصَّل من العميل نقدًا عند التسليم</small></div>' +
        '<div class="amount">مدفوع بالكامل</div>' +
        '<div class="words">لا يوجد مبلغ يُحصَّل عند الاستلام — الطلب مدفوع بالكامل.</div>'
      : '<div class="cap">المبلغ المطلوب تحصيله عند الاستلام<small>الدفع عند الاستلام (COD) — يُحصَّل من العميل نقدًا عند التسليم</small></div>' +
        '<div class="amount">' + fmtAmount(d.cod) + ' ' + escHtml(d.currency) + '</div>' +
        '<div class="words">المبلغ بالأحرف: ' + escHtml(d.codWords) + '.</div>';
    return '<style>' + SHEET_CSS + '</style>' +
      '<main class="wb-sheet" id="wbSheet" aria-label="بوليصة شحن">' +
      '<header class="wb-head">' +
      '<div class="wb-brand"><h1>المتجر</h1></div>' +
      '<div class="wb-title"><p class="t">بوليصة شحن</p>' +
      '<div class="meta">رقم الطلب: <b>#' + escHtml(d.orderNo) + '</b><br>' +
      (d.orderDate ? 'تاريخ الطلب: <b>' + escHtml(d.orderDate) + '</b>' : '') +
      '</div><div class="wb-barcode" aria-hidden="true"></div>' +
      '<div class="wb-barcode-num">' + escHtml(d.orderNo) + '</div></div>' +
      '</header>' +
      '<section class="wb-box"><h2>بيانات العميل (المستلم)</h2><div class="body">' +
      '<div class="wb-row"><span class="wb-lbl">الاسم:</span><span class="wb-val' + (editable ? ' wb-editable' : '') + '" data-wb="name"' + ed + '>' + escHtml(d.customer.name || '—') + '</span></div>' +
      '<div class="wb-row"><span class="wb-lbl">المحافظة:</span><span class="wb-val' + (editable ? ' wb-editable' : '') + '" data-wb="governorate"' + ed + '>' + escHtml(d.customer.governorate || '—') + '</span></div>' +
      '<div class="wb-row"><span class="wb-lbl">العنوان:</span><span class="wb-val' + (editable ? ' wb-editable' : '') + '" data-wb="address"' + ed + '>' + escHtml(d.customer.address || '—') + '</span></div>' +
      '<div class="wb-row"><span class="wb-lbl">رقم أساسي:</span><span class="wb-phone' + (editable ? ' wb-editable' : '') + '" data-wb="phone"' + ed + '>' + escHtml(d.customer.phone || '—') + '</span></div>' +
      '<div class="wb-row"><span class="wb-lbl">رقم احتياطي:</span><span class="wb-phone' + (editable ? ' wb-editable' : '') + '" data-wb="phone2"' + ed + '>' + escHtml(d.customer.phone2 || '—') + '</span></div>' +
      '</div></section>' +
      (editable ? '<p class="wb-edit-note">عنوان العميل وأرقامه قابلة للتعديل هنا قبل الطباعة لو فيها أي خطأ.</p>' : '') +
      '<section class="wb-shipco"><span class="lbl">شركة الشحن:</span>' +
      '<span class="val' + (editable ? ' wb-editable' : '') + '" data-wb="shipco"' + ed + '>' + escHtml(d.shipCompany) + '</span></section>' +
      '<section class="wb-items"><h2>تفاصيل الطلب</h2><table>' +
      '<thead><tr><th>المنتج</th><th class="price">سعر الوحدة</th><th class="num">الكمية</th><th class="price">الإجمالي</th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '<tfoot><tr><td colspan="3">إجمالي المنتجات</td><td class="price">' + fmtAmount(d.subtotal) + ' ' + escHtml(d.currency) + '</td></tr>' +
      '<tr><td colspan="3">مصاريف الشحن</td><td class="price">' + feeCell + '</td></tr>' +
      '<tr class="grand"><td colspan="3">الإجمالي المستحق</td><td class="price">' + fmtAmount(d.due) + ' ' + escHtml(d.currency) + '</td></tr></tfoot>' +
      '</table></section>' +
      '<section class="wb-cod">' + codBlock + '</section>' +
      '<section class="wb-notes"><span class="lbl">ملاحظات التسليم:</span>' +
      '<div class="line' + (editable ? ' wb-editable' : '') + '"' + (editable ? ' data-wb="notes"' + ed : '') + '>' + escHtml(d.notes || '') + '</div></section>' +
      '<section class="wb-date"><div class="role">التاريخ</div>' +
      '<div class="name">' + escHtml(d.waybillDate) + '</div>' +
      '<div class="cap" style="font-size:10.5px;color:#6B6B76;margin-top:3px">تاريخ إصدار البوليصة</div></section>' +
      '<footer class="wb-foot">للتواصل معنا: <span class="wb-phone">' + escHtml(d.contactPhone) + '</span> — واتساب ومكالمات</footer>' +
      '</main>';
  }

  // ---- Full print-window document (same pattern as printInvoice). ----
  function waybillPrintDoc(d) {
    return '<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8">' +
      '<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;900&display=swap" rel="stylesheet">' +
      '<title>بوليصة شحن #' + escHtml(d.orderNo) + '</title>' +
      '<style>body{margin:0;background:#fff}@media print{body{margin:0}}</style>' +
      '</head><body>' + waybillSheetHtml(d, false) +
      '<script>window.onload=()=>{window.print()}<\/script></body></html>';
  }

  var api = {
    CONTACT_PHONE: CONTACT_PHONE,
    DEFAULT_SHIP_COMPANY: DEFAULT_SHIP_COMPANY,
    escHtml: escHtml,
    fmtAmount: fmtAmount,
    amountToArabicWords: amountToArabicWords,
    codWordsLine: codWordsLine,
    buildWaybillData: buildWaybillData,
    waybillSheetHtml: waybillSheetHtml,
    waybillPrintDoc: waybillPrintDoc
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Waybill = api;
})();
