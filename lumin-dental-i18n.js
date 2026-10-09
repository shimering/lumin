// Shared clinical translations for the clinic and patient quotation pages.
(function (root) {
  'use strict';
  const arabic = Object.freeze({
      // Specialties / Categories
      'All': 'الكل',
      'Cosmetics': 'تجميل الأسنان',
      'Crown': 'تركيبات وتيجان',
      'Dentolize historical import': 'إجراءات أخرى مستوردة',
      'Diagnosis': 'كشف وفحوصات',
      'Endo': 'علاج الجذور والعصب',
      'Implantation': 'زراعة الأسنان',
      'Orthodontics': 'تقويم الأسنان',
      'Pedo': 'طب أسنان الأطفال',
      'Perio': 'علاج اللثة وتنظيف الأسنان',
      'Prosthesis': 'التركيبات المتحركة',
      'Restoration': 'حشوات وترميم الأسنان',
      'Surgery': 'جراحة الفم والأسنان',


      // Common catalog names used by treatment quotations.
      'Root canal treatment': 'علاج الجذور والعصب',
      'Composite restoration': 'حشو كومبوزيت تجميلي',
      'Scaling and polishing': 'تنظيف جير وتلميع الأسنان',
      'Implant': 'زراعة سن',
      'Ceramic crown': 'تاج خزفي',
      'Temporary crown': 'تاج مؤقت',
      'Veneer': 'قشرة تجميلية',
      'Bridge': 'جسر أسنان',

      // Operations - Cosmetics
      'Chemical bleaching': 'تبييض كيميائي للأسنان',
      'Emax veneers': 'فينير إيماكس',
      'Light bleaching (egypt)': 'تبييض بالضوء (محلي)',
      'Light bleaching (german)': 'تبييض بالضوء (ألماني)',
      'Snap on smile': 'ابتسامة هوليوود المتحركة (سناب أون)',

      // Operations - Crown
      'E-Max Cementation': 'تثبيت تركيبة إيماكس',
      'Emax crown (Emax cad)': 'تاج إيماكس (Emax CAD)',
      'Emax veneer': 'فينير إيماكس',
      'Endo-crown (Emax)': 'إندو كراون إيماكس',
      'Inlay (Emax CAD)': 'إنلاي إيماكس',
      'Overlay (Emax CAD)': 'أوفرلاي إيماكس',
      'PFM Crown': 'تاج بورسلين مدمج بمعدن (PFM)',
      'Re-cement crown': 'إعادة تثبيت تاج',
      'Zircomax (cutback)': 'تاج زيركوماكس (كات باك)',
      'Zirconium crown': 'تاج زركونيا',

      // Operations - Diagnosis
      'Bitewing X-Ray': 'أشعة بايت وينج (أشعة الأجنحة)',
      'Blood test': 'تحليل دم',
      'Cephalometric X-ray': 'أشعة سيفالومترية للرأس',
      'ConeBeam CT X-ray (1 jaw)': 'أشعة مقطعية ثلاثية الأبعاد (فك واحد)',
      'ConeBeam CT X-ray (2 jaw)': 'أشعة مقطعية ثلاثية الأبعاد (فكين)',
      'Consultation and treatment Plan': 'استشارة وكشف وخطة علاجية',
      'Diagnosis': 'كشف وتشخيص',
      'Panoramic X-Ray': 'أشعة بانوراما للفكين',
      'Periapical X-Ray': 'أشعة صغيرة للضرس (حول الذروة)',

      // Operations - Endo
      'Abscess drainage/Abscess treatment': 'علاج وتفريغ خراج',
      'Direct Pulp capping': 'تغطية العصب المباشرة',
      'Root canal re-treatment (anterior)': 'إعادة علاج جذور (أسنان أمامية)',
      'Root canal re-treatment (molar)': 'إعادة علاج جذور (ضروس خلفية)',
      'Root canal re-treatment (premolar)': 'إعادة علاج جذور (ضواحك)',
      'Root canal treatment (anterior)': 'علاج جذور وعصب (أسنان أمامية)',
      'Root canal treatment (molar)': 'علاج جذور وعصب (ضروس خلفية)',
      'Root canal treatment (premolar)': 'علاج جذور وعصب (ضواحك)',

      // Operations - Implantation
      'Bone grafting': 'زراعة عظم للفك',
      'Economic Implant (Dual)': 'زراعة أسنان اقتصادية (Dual)',
      'Standard Implant b&b': 'زراعة أسنان قياسية (B&B)',

      // Operations - Orthodontics
      'Invisalign': 'تقويم شفاف (إنفزلاين)',
      'Ortho Follow Up': 'جلسة متابعة تقويم',
      'Orthodontic bracket': 'براكيت تقويم',
      'Traditional ceramic braces - Complicated case: lost of molar, root treated teeth etc': 'تقويم سيراميك تقليدي - حالة معقدة',
      'Traditional ceramic braces - Requires extraction (fee for extraction is not included': 'تقويم سيراميك تقليدي - يتطلب خلع',
      'Traditional ceramic braces - Simple case: no extraction required': 'تقويم سيراميك تقليدي - حالة بسيطة (بدون خلع)',
      'Traditional metal braces - Complicated case: lost of molar, root treated teeth, etc': 'تقويم معدني تقليدي - حالة معقدة',
      'Traditional metal braces - requires extraction': 'تقويم معدني تقليدي - يتطلب خلع',
      'Traditional metal braces - Simple case: no extraction required': 'تقويم معدني تقليدي - حالة بسيطة (بدون خلع)',

      // Operations - Pedo
      'Composite filling': 'حشو كومبوزيت تجميلي للأطفال',
      'Deciduous tooth extraction': 'خلع سن لبني',
      'floride varnish': 'تطبيق فلورايد فارنيش للأطفال',
      'Pits & fissure sealant': 'سدادات الشقوق والميازيب الوقائية',
      'Pulpectomy': 'استئصال عصب كامل للأطفال (علاج جذور لبني)',
      'Pulpotomy': 'بتر العصب الجزئي للأطفال',
      'Reinforced glass inomer (fugi)': 'حشو جلاس أينومر مقوى (فوجي)',
      'SDF': 'تطبيق فلورايد الفضة الديامين (SDF)',
      'Space Maintainer': 'حافظ مسافة لأسنان الأطفال',
      'Stainless steal crown': 'تاج ستانلس ستيل للأطفال (SSC)',
      'Zirconia crown': 'تاج زركونيا للأطفال',

      // Operations - Perio
      'Crown lengthening': 'تطويل التاج السريري',
      'Florid application': 'تطبيق الفلورايد الوقائي',
      'Gingivectomy': 'استئصال جزء من اللثة (قص لثة)',
      'Gum grafting': 'طعم لثوي (زراعة لثة)',
      'Operculectomy': 'إزالة الغطاء اللثوي فوق ضرس العقل',
      'Periodontal Pocket treatment (non-surgical)': 'علاج الجيوب اللثوية (غير جراحي)',
      'PRF': 'علاج بالصفائح الدموية الغنية بالفيبرين (PRF)',
      'Scaling and polishing (promo)': 'تنظيف جير وتلميع الأسنان (عرض)',
      'Teeth cleaning and Polishing (Minimal)': 'تنظيف وتلميع أسنان (بسيط)',
      'Teeth cleaning and polishing (severe)': 'تنظيف وتلميع أسنان (جير متقدم)',

      // Operations - Prosthesis
      'Acrylic complete denture': 'طقم أسنان كامل أكريليك',
      'Flexi Denture': 'طقم أسنان مرن (فليكسي)',
      'Flexible complete denture': 'طقم أسنان كامل مرن',
      'Night Guard one arch': 'واقي ليلي للأسنان (فك واحد)',
      'Nightguard two arches': 'واقي ليلي للأسنان (فكين)',
      'Removable Partial denture': 'طقم أسنان جزئي متحرك',
      'Single tooth removable': 'تركيبة سن واحد متحرك',

      // Operations - Restoration
      'Amalgam restoration': 'حشو أملجم (فضي)',
      'Composite filling (extensive)': 'حشو كومبوزيت ضوئي (كبير / ممتد)',
      'Composite filling (minimal)': 'حشو كومبوزيت ضوئي (بسيط)',
      'Composite inlay': 'إنلاي كومبوزيت',
      'Composite onlay': 'أوفرلاي كومبوزيت',
      'Composite veneer': 'فينير كومبوزيت مباشر',
      'Post & Core': 'وتد وبناء السن (Post & Core)',
      'Resin reinforced glass inomer': 'جلاس أينومر مدعم بالراتنج',
      'Sealant': 'حشوة سادة وقائية للأسنان',

      // Operations - Surgery
      'Cyst removal': 'استئصال كيس فكي',
      'Simple tooth extraction': 'خلع سن بسيط',
      'Surgical tooth extraction': 'خلع سن جراحي',
      'Surgical wisdom tooth extraction': 'خلع جراحي لضرس العقل',
      'Tooth extraction with bone grafting': 'خلع سن مع زراعة عظم',
      'Wisdom tooth extraction': 'خلع ضرس العقل',

      // Operations - Historical Import
      'Composite Compound': 'حشو كومبوزيت مركب',
      'Endo One canal': 'علاج عصب (قناة واحدة)',
      'Endo Two Canals': 'علاج عصب (قناتين)',
      'Endo Three Canals': 'علاج عصب (3 قنوات)',
      'Endo Four Canals': 'علاج عصب (4 قنوات)',
      'Examination': 'فحص وكشف طبي',
      'Excision': 'استئصال نسيجي',
      'Extraction': 'خلع أسنان',
      'Fiber Post & Core': 'وتد فايبر وبناء السن',
      'Fixture 1': 'زرعة أسنان 1',
      'G. Ionomer (fugi)': 'حشو جلاس أينومر (فوجي)',
      'Initial Oral Examination': 'كشف وفحص فموي أولي',
      'K-Line Ortho': 'تقويم كي لاين الشفاف',
      'Metal Braces': 'تقويم معدني',
      'Metal Bracket': 'براكيت معدني',
      'Metal Post & Core': 'وتد معدني وبناء السن',
      'Moderate Extraction': 'خلع سن متوسط الصعوبة',

      // Scopes & General
      'Surfaces': 'الأسطح',
      'Selected surfaces': 'الأسطح المحددة',
      'Whole tooth': 'السن بالكامل',
      'Whole mouth': 'الفم بالكامل',
      'surface': 'الأسطح',
      'whole': 'السن بالكامل',
      'mouth': 'الفم بالكامل'
  });
  const normalized = new Map(Object.entries(arabic).map(([name,translation]) => [name.trim().toLowerCase(),translation]));
  function translate(term,language = 'ar') {
    if (!term || language !== 'ar') return term || '';
    return normalized.get(String(term).trim().toLowerCase()) || term;
  }
  root.LuminDentalI18n = {arabic,translate};
})(globalThis);
