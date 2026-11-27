// ════════════════════════════════════════════════════════════════
// ONBOARDING TOUR — step inventory + first-run storage helpers for
// Store Manager (PC). Pure data + storage logic only; the overlay
// engine lives in index.html and reads window.Tour. Steps were
// inventoried from the real app (20 pages in the sidebar + top bar
// + quick-add button) — one step per section/feature, short plain
// Arabic copy. Unit-tested in test/tour.test.js via module.exports.
// ════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  // localStorage flag: '1' once the tour was shown/completed/skipped.
  var TOUR_KEY = 'sb_tour_done';

  // Pages that refuse navigation until the store account is signed
  // in (nav() toasts and stays put). The engine highlights their
  // sidebar item instead and appends TOUR_GATED_NOTE to the text.
  var TOUR_GATED_PAGES = ['templates', 'feedback', 'incomplete'];
  var TOUR_GATED_NOTE = ' (القسم ده بيحتاج تسجيل دخول المتجر الأول — هتلاقيه في القايمة لما تسجّل دخول.)';

  // page: nav() target. sel: element the step highlights (a page
  // header for page steps, a chrome element otherwise).
  var TOUR_STEPS = [
    { page: 'dashboard', sel: '#dStats', title: 'أهلاً بيك في Store Manager',
      text: 'دي جولة سريعة في كل أقسام البرنامج — خطوة خطوة، وكل خطوة بتعلّم على مكانها على الشاشة. تقدر تتخطاها في أي وقت من زر «تخطي».' },
    { page: 'dashboard', sel: '#sb', title: 'القايمة الجانبية',
      text: 'من هنا بتتنقل بين كل أقسام البرنامج: المبيعات، الطلبات والشحن، المشتريات، المستودع، المالية، والإدارة.' },
    { page: 'dashboard', sel: '#tb', title: 'الشريط العلوي',
      text: 'من هنا تغيّر اللغة (عربي / English)، وتبدّل المظهر الفاتح والغامق، وتشوف الإشعارات، وتبحث في كل حاجة بـ Ctrl+K.' },
    { page: 'dashboard', sel: '#dStats', title: 'لوحة التحكم',
      text: 'إحصائيات اليوم في لمحة: المبيعات، الإيراد، صافي الربح، الديون، المنتجات، والطلبات المتأخرة. اضغط على أي بطاقة عشان تروح لقسمها.' },
    { page: 'sales', sel: '#pg-sales .pg-hd', title: 'فواتير البيع',
      text: 'من هنا بتعمل فاتورة بيع جديدة، وتطبع الفواتير، وتصدّرها CSV، وتعمل عرض سعر للعميل.' },
    { page: 'customers', sel: '#pg-customers .pg-hd', title: 'العملاء',
      text: 'بيانات عملائك وديونهم وطلباتهم. تقدر تضيف عميل جديد من زر «إضافة عميل».' },
    { page: 'orders', sel: '#pg-orders .pg-hd', title: 'الطلبات والتوصيل',
      text: 'طلبات المتجر المباشرة والطلبات المحلية، حالات الشحن، ومواعيد التسليم. ومن صف أي طلب تقدر تطبع بوليصة الشحن بتاعته.' },
    { page: 'incomplete', sel: '#pg-incomplete .pg-hd', title: 'طلبات ناقصة', gated: true,
      text: 'عملاء بدأوا الطلب من الموقع ومكملوش. اتصل بيهم من هنا وحوّل الطلب لطلب حقيقي بعد ما يأكدوا بالتلفون.' },
    { page: 'templates', sel: '#pg-templates .pg-hd', title: 'قوالب المتجر', gated: true,
      text: 'اختار القالب اللي يظهر على الموقع. التفعيل فوري، والرجوع لقالب تاني بضغطة واحدة.' },
    { page: 'feedback', sel: '#pg-feedback .pg-hd', title: 'الشكاوى والاقتراحات', gated: true,
      text: 'رسائل العملاء من الموقع — بطاقات للقراءة فقط، واحذف اللي سبام.' },
    { page: 'website-products', sel: '#pg-website-products .pg-hd', title: 'منتجات الموقع',
      text: 'المنتجات اللي بتظهر على الموقع: السعر والصور والمنتجات المميزة — كلها من هنا.' },
    { page: 'website-categories', sel: '#pg-website-categories .pg-hd', title: 'فئات الموقع',
      text: 'الفئات اللي بتظهر في الموقع وبتستخدم في فلترة المنتجات للعميل.' },
    { page: 'website-homepage', sel: '#pg-website-homepage .pg-hd', title: 'الرئيسية والتصميم',
      text: 'الواجهة الرئيسية للموقع وشريط الإعلان والأقسام. الحفظ هنا بدمج، مش بيمسح باقي الحقول.' },
    { page: 'website-preview', sel: '#pg-website-preview .pg-hd', title: 'معاينة الموقع',
      text: 'شوف الموقع زي ما العميل بيشوفه بالظبط، من غير ما تطلع من البرنامج.' },
    { page: 'purchases', sel: '#pg-purchases .pg-hd', title: 'فواتير الشراء',
      text: 'تتبع مشترياتك من الموردين: فاتورة شراء جديدة، والتكلفة، والكميات اللي دخلت المخزون.' },
    { page: 'suppliers', sel: '#pg-suppliers .pg-hd', title: 'الموردون',
      text: 'بيانات الموردين اللي بتتعامل معاهم، وأرصدتهم وفواتيرهم.' },
    { page: 'inventory', sel: '#pg-inventory .pg-hd', title: 'المنتجات',
      text: 'المستودع وإدارة المخزون: إضافة منتج جديد، الأسعار، والكميات. والبرنامج بينبهك لما منتج يقرب يخلص.' },
    { page: 'returns', sel: '#pg-returns .pg-hd', title: 'المرتجعات',
      text: 'سجّل المرتجعات من العملاء أو للموردين من زر «إضافة مرتجع».' },
    { page: 'profits', sel: '#pg-profits .pg-hd', title: 'الأرباح والتقارير',
      text: 'صافي الربح والتقارير المالية بالفترات — المبيعات والمشتريات والمصروفات في مكان واحد.' },
    { page: 'expenses', sel: '#pg-expenses .pg-hd', title: 'المصروفات',
      text: 'سجّل مصروفات المحل من زر «إضافة مصروف»، وتابعها بالتواريخ.' },
    { page: 'settings', sel: '#pg-settings .pg-hd', title: 'الإعدادات',
      text: 'بيانات الشركة واللوجو والعملة، رسوم التوصيل، محافظات التوصيل، واتساب، والتحديثات. ومن هنا كمان تقدر تعيد الجولة دي في أي وقت.' },
    { page: 'activitylog', sel: '#pg-activitylog .pg-hd', title: 'سجل النشاط',
      text: 'كل العمليات اللي اتنفذت في البرنامج بالترتيب — مرجع سريع لأي حاجة حصلت.' },
    { page: 'dashboard', sel: '#fabBtn', title: 'زر الإضافة السريعة',
      text: 'الزر البرتقالي اللي تحت على الشمال: منه تعمل بسرعة فاتورة بيع أو شراء، منتج جديد، طلب توصيل، مصروف، أو مرتجع.' },
    { page: 'dashboard', sel: '#dStats', title: 'خلصت الجولة',
      text: 'دي كل أقسام البرنامج. لو حبيت تعيد الجولة في أي وقت، من الإعدادات ← «الجولة التعريفية». بالتوفيق!' }
  ];

  // ---- First-run storage (storage = localStorage in the app) ----
  function isTourDone(storage) {
    try { return storage.getItem(TOUR_KEY) === '1'; } catch (e) { return false; }
  }
  function shouldShowTour(storage) {
    return !isTourDone(storage);
  }
  function markTourDone(storage) {
    try { storage.setItem(TOUR_KEY, '1'); } catch (e) { /* private mode: tour just shows again */ }
  }

  // Existing-install seeding: an install that already has local
  // state from past use — a cached store role from a sign-in, a
  // saved logo, local data, or a saved store login — is NOT a
  // first run. Mark the tour done before the first auto-show so
  // it never pops (and navigates pages) on the user's existing
  // install. Truly fresh installs (no local state at all) still
  // get the tour. Manual restart from Settings is unaffected.
  // Returns true only when it seeded the flag.
  var EXISTING_INSTALL_KEYS = ['sb_store_role', 'sb_logo', 'smartbulse_v1', 'sb_store_email', 'sb_actlog_v1'];
  function seedTourDoneForExistingInstall(storage) {
    if (isTourDone(storage)) return false;
    try {
      for (var i = 0; i < EXISTING_INSTALL_KEYS.length; i++) {
        if (storage.getItem(EXISTING_INSTALL_KEYS[i]) != null) {
          markTourDone(storage);
          return true;
        }
      }
    } catch (e) { return false; }
    return false;
  }

  var api = {
    TOUR_KEY: TOUR_KEY,
    TOUR_GATED_PAGES: TOUR_GATED_PAGES,
    TOUR_GATED_NOTE: TOUR_GATED_NOTE,
    TOUR_STEPS: TOUR_STEPS,
    EXISTING_INSTALL_KEYS: EXISTING_INSTALL_KEYS,
    isTourDone: isTourDone,
    shouldShowTour: shouldShowTour,
    markTourDone: markTourDone,
    seedTourDoneForExistingInstall: seedTourDoneForExistingInstall
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Tour = api;
})();
