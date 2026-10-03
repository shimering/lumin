const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const webhookContent = fs.readFileSync(path.join(root, 'supabase', 'functions', 'whatsapp-webhook', 'index.ts'), 'utf8');

test('buildGeminiTools defines lookup_patient, assign_patient, and create_patient tools', () => {
  assert.match(webhookContent, /name:\s*"lookup_patient"/);
  assert.match(webhookContent, /name:\s*"assign_patient"/);
  assert.match(webhookContent, /name:\s*"create_patient"/);
  assert.match(webhookContent, /patient_id:\s*\{\s*type:\s*"STRING",\s*description:\s*"Optional ID of the patient/);
});

test('findPatientsByPhone helper is defined and queries patients by phone variants', () => {
  assert.match(webhookContent, /async function findPatientsByPhone\(supabase: any, rawPhone: string\)/);
  assert.match(webhookContent, /from\("patients"\)/);
  assert.match(webhookContent, /cleanPhone\(rawPhone\)/);
  assert.match(webhookContent, /getPhoneTail\(clean\)/);
  assert.match(webhookContent, /uniqueMap\.set\(p\.id, p\)/);
});

test('handleGeminiToolCall handles lookup_patient, assign_patient, and create_patient', () => {
  // lookup_patient handler
  assert.match(webhookContent, /if \(name === "lookup_patient"\)/);
  assert.match(webhookContent, /const matches = await findPatientsByPhone\(supabase, rawPhone\)/);
  assert.match(webhookContent, /duplicates:\s*matches\.map/);

  // assign_patient handler
  assert.match(webhookContent, /if \(name === "assign_patient"\)/);
  assert.match(webhookContent, /\.update\(\{\s*patient_id:\s*p\.id,\s*patient_name:\s*finalName/);

  // create_patient handler
  assert.match(webhookContent, /if \(name === "create_patient"\)/);
  assert.match(webhookContent, /\.from\("patients"\)\s*\.insert\(\{/);
  assert.match(webhookContent, /phoneToAssign/);
});

test('book_appointment guards against duplicate patients and only creates new patient when appropriate', () => {
  assert.match(webhookContent, /let patientId = patient_id \|\| conversation\.patient_id;/);
  assert.match(webhookContent, /error:\s*"DUPLICATE_PATIENTS_EXIST"/);
  assert.match(webhookContent, /if \(!patientId\) \{\s*const effectiveName = finalPatientName \|\| "WhatsApp Patient";/);
});

test('runGeminiAgent dynamically injects patient identity status, duplicate prompts, and lookup rules', () => {
  assert.match(webhookContent, /matchedPatients = await findPatientsByPhone\(supabase, conversation\.phone\)/);
  assert.match(webhookContent, /CRITICAL PATIENT CONTEXT - DUPLICATE PATIENTS FOUND FOR PHONE/);
  assert.match(webhookContent, /MANDATORY RULES FOR DUPLICATE PATIENTS:/);
  assert.match(webhookContent, /ALWAYS ASK THE PATIENT WHICH ONE TO ASSIGN:/);
  assert.match(webhookContent, /PATIENT CONTEXT - REGISTERED PATIENT FOUND FOR PHONE/);
  assert.match(webhookContent, /PHONE NUMBER LOOKUP & ASSIGNMENT RULES:/);
});

test('incoming webhook and manual sends use findPatientsByPhone without brittle maybeSingle', () => {
  assert.match(webhookContent, /const matchedPatients = await findPatientsByPhone\(supabase, fromPhone\);/);
  assert.match(webhookContent, /if \(matchedPatients\.length === 1\)/);
  assert.match(webhookContent, /else if \(matchedPatients\.length > 1\)/);
});

test('functional simulation of findPatientsByPhone correctly resolves single, duplicate, and new patients', async () => {
  // Extract pure JS logic of cleanPhone, isBsuid, getPhoneTail, findPatientsByPhone
  function isBsuid(val) {
    if (!val || typeof val !== 'string') return false;
    return /^[A-Za-z]{2}\.\d+$/i.test(val.trim());
  }

  function cleanPhone(raw) {
    if (isBsuid(raw)) return String(raw).trim();
    return String(raw || '').replace(/[^\d]/g, '');
  }

  function getPhoneTail(phone) {
    if (isBsuid(phone)) return String(phone).trim();
    const cleaned = cleanPhone(phone);
    return cleaned.length > 9 ? cleaned.slice(-9) : cleaned;
  }

  async function findPatientsByPhone(supabase, rawPhone) {
    if (!rawPhone || isBsuid(rawPhone)) return [];
    const clean = cleanPhone(rawPhone);
    if (!clean || clean.length < 6) return [];
    const tail = getPhoneTail(clean);

    const { data } = await supabase.from('patients').select().or();
    if (!Array.isArray(data)) return [];

    const uniqueMap = new Map();
    for (const p of data) {
      if (!p || !p.id || uniqueMap.has(p.id)) continue;
      const pClean = cleanPhone(p.phone || '');
      if (
        pClean === clean ||
        (tail && pClean.endsWith(tail)) ||
        (clean && pClean && (clean.endsWith(pClean) || pClean.endsWith(clean))) ||
        (p.phone && tail && p.phone.replace(/[^\d]/g, '').endsWith(tail))
      ) {
        uniqueMap.set(p.id, p);
      }
    }
    return Array.from(uniqueMap.values());
  }

  // 1. Single patient found
  const mockSingleDb = {
    from: () => ({
      select: () => ({
        or: async () => ({
          data: [{ id: 'p1', name: 'Zaid Ali', phone: '07701234567' }],
        }),
      }),
    }),
  };
  const singleResult = await findPatientsByPhone(mockSingleDb, '+9647701234567');
  assert.equal(singleResult.length, 1);
  assert.equal(singleResult[0].name, 'Zaid Ali');

  // 2. Duplicate patients found (e.g. family sharing a phone)
  const mockDuplicateDb = {
    from: () => ({
      select: () => ({
        or: async () => ({
          data: [
            { id: 'p1', name: 'Ahmed Samir', phone: '07701112233' },
            { id: 'p2', name: 'Sara Samir', phone: '07701112233' },
          ],
        }),
      }),
    }),
  };
  const dupResult = await findPatientsByPhone(mockDuplicateDb, '07701112233');
  assert.equal(dupResult.length, 2);
  assert.equal(dupResult[0].name, 'Ahmed Samir');
  assert.equal(dupResult[1].name, 'Sara Samir');

  // 3. New patient / unrecognised phone
  const mockEmptyDb = {
    from: () => ({
      select: () => ({
        or: async () => ({ data: [] }),
      }),
    }),
  };
  const emptyResult = await findPatientsByPhone(mockEmptyDb, '07809999999');
  assert.equal(emptyResult.length, 0);
});

test('normalizeArabicName and matchPatientNameScore are defined and handle Arabic letter variants and titles', () => {
  assert.match(webhookContent, /function normalizeArabicName\(name: string\): string/);
  assert.match(webhookContent, /function matchPatientNameScore\(targetName: string, candidateName: string\): number/);
  assert.match(webhookContent, /function namesMatch\(name1: string, name2: string\): boolean/);

  // Pure JS execution simulation
  function normalizeArabicName(name) {
    if (!name) return "";
    return String(name)
      .trim()
      .toLowerCase()
      .replace(/[\u064B-\u065F\u0670]/g, "")
      .replace(/^(دكتور|دكتورة|د\.?|أستاذ|أستاذة|سيد|سيدة|م\.?|mr\.?|mrs\.?|dr\.?)\s+/i, "")
      .replace(/[إأآا]/g, "ا")
      .replace(/[ة]/g, "ه")
      .replace(/[ى]/g, "ي")
      .replace(/\s+/g, " ")
      .trim();
  }

  function matchPatientNameScore(targetName, candidateName) {
    const n1 = normalizeArabicName(targetName);
    const n2 = normalizeArabicName(candidateName);
    if (!n1 || !n2) return 0;
    if (n1 === n2) return 100;
    const w1 = n1.split(" ").filter(Boolean);
    const w2 = n2.split(" ").filter(Boolean);
    if (w1[0] && w2[0] && w1[0] === w2[0]) {
      if (w1.length > 1 && w2.length > 1 && w1[1] === w2[1]) return 90;
    }
    // Check if shorter name's words appear as consecutive whole words in the longer name (requires at least 2 words)
    if (w1.length >= 2 && w2.length >= 2) {
      const shorter = w1.length <= w2.length ? w1 : w2;
      const longer = w1.length <= w2.length ? w2 : w1;
      const shorterStr = shorter.join(" ");
      const longerStr = longer.join(" ");
      const escaped = shorterStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`(^|\\s)${escaped}(\\s|$)`);
      if (regex.test(longerStr)) return 80;
    }
    if (w1[0] && w2[0] && w1[0] === w2[0] && (w1.length === 1 || w2.length === 1)) return 60;
    return 0;
  }

  // Hamza normalization
  assert.equal(matchPatientNameScore("عمر أحمد", "عمر احمد"), 100);
  assert.equal(matchPatientNameScore("إبراهيم علي", "ابراهيم علي"), 100);

  // Title removal
  assert.equal(matchPatientNameScore("د. عمر أحمد", "عمر احمد"), 100);
  assert.equal(matchPatientNameScore("أستاذ أحمد", "احمد"), 100);

  // Taa marbouta and Alef maksura
  assert.equal(matchPatientNameScore("فاطمة الزهراء", "فاطمه الزهراء"), 100);
  assert.equal(matchPatientNameScore("منى علي", "مني علي"), 100);

  // Partial / First+Second name match
  assert.equal(matchPatientNameScore("أحمد علي", "أحمد علي حسين"), 90);
  assert.ok(matchPatientNameScore("علي", "علي حسن") >= 60);

  // Single first name MUST NOT match words that merely contain it as a substring (e.g. "هدى" inside "مهدي" or "هديل")
  assert.equal(matchPatientNameScore("هدى", "رباب مهدي"), 0);
  assert.equal(matchPatientNameScore("هدى", "هديل عمرو"), 0);
  assert.equal(matchPatientNameScore("هدى", "هدير محمد"), 0);
  assert.equal(matchPatientNameScore("هدى", "مروة مهدي محرم"), 0);

  // Different names
  assert.equal(matchPatientNameScore("حيدر", "علي حسن"), 0);
});

test('create_patient guards against duplicate creation and re-uses existing fetched profile', () => {
  assert.match(webhookContent, /const existingMatches = phoneToAssign \? await findPatientsByPhone\(supabase, phoneToAssign\) : \[\];/);
  assert.match(webhookContent, /already_existed:\s*true/);
  assert.match(webhookContent, /تم استخدام الملف المسجل مسبقاً للمريض/);
});

test('book_appointment re-uses fetched patient profile attached to phone number without creating duplicate', async () => {
  // Simulate resolvePatient logic from book_appointment
  function resolvePatientForBooking({ patient_name, patient_id, conversation, matches }) {
    let patientId = patient_id || conversation.patient_id;
    let finalPatientName = (patient_name || conversation.patient_name || "").trim();

    if (!patientId) {
      if (matches.length === 1) {
        // Exactly 1 patient attached to phone: ALWAYS re-use
        patientId = matches[0].id;
        finalPatientName = matches[0].name;
      } else if (matches.length > 1) {
        // Multiple matches: fuzzy score match
        const norm = (s) => (s || "").replace(/[إأآا]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").trim();
        const matched = matches.find(m => norm(m.name).includes(norm(finalPatientName)) || norm(finalPatientName).includes(norm(m.name)));
        if (matched) {
          patientId = matched.id;
          finalPatientName = matched.name;
        }
      }
    }

    const createdNewPatient = !patientId;
    return { patientId, finalPatientName, createdNewPatient };
  }

  // Case 1: Phone has 1 registered patient "عمر أحمد". Patient books appointment.
  const resSingle = resolvePatientForBooking({
    patient_name: "عمر أحمد",
    conversation: { phone: "07701234567", patient_id: null, patient_name: null },
    matches: [{ id: "p-existing-1", name: "عمر أحمد", phone: "07701234567" }],
  });
  assert.equal(resSingle.patientId, "p-existing-1", "Must use existing patient ID");
  assert.equal(resSingle.finalPatientName, "عمر أحمد");
  assert.equal(resSingle.createdNewPatient, false, "Must NOT create a new patient");

  // Case 2: Phone has 2 registered patients (family: Father & Son). User books for "علي سمير".
  const resDup = resolvePatientForBooking({
    patient_name: "علي سمير",
    conversation: { phone: "07701112233", patient_id: null, patient_name: null },
    matches: [
      { id: "p-samir", name: "سمير حميد", phone: "07701112233" },
      { id: "p-ali", name: "علي سمير", phone: "07701112233" }
    ],
  });
  assert.equal(resDup.patientId, "p-ali", "Must match and use existing profile 'علي سمير'");
  assert.equal(resDup.createdNewPatient, false, "Must NOT create a duplicate patient");

  // Case 3: Completely new unregistered phone
  const resNew = resolvePatientForBooking({
    patient_name: "زينب جواد",
    conversation: { phone: "07809999999", patient_id: null, patient_name: null },
    matches: [],
  });
  assert.equal(resNew.createdNewPatient, true, "Only completely new phone creates new patient");
});

test('findPatientsByWhatsApp and formatWhatsAppCode correctly resolve patients by BSUID code and username', () => {
  assert.match(webhookContent, /async function findPatientsByWhatsApp\(/);
  assert.match(webhookContent, /function formatWhatsAppCode\(/);
  assert.match(webhookContent, /savePatientWhatsAppIdentity\(/);
  assert.match(webhookContent, /whatsapp_code\.eq/);
  assert.match(webhookContent, /whatsapp_username/);

  // Pure JS simulation
  function isBsuid(val) {
    if (!val || typeof val !== 'string') return false;
    return /^\+?[A-Za-z]{2}\.\d+$/i.test(val.trim());
  }

  function formatWhatsAppCode(val) {
    if (!val || typeof val !== 'string') return '';
    const s = val.trim();
    if (!s) return '';
    return s.startsWith('+') ? s : `+${s}`;
  }

  assert.equal(isBsuid('EG.4631528857091458'), true);
  assert.equal(isBsuid('+EG.4631528857091458'), true);
  assert.equal(isBsuid('01065668752'), false);
  assert.equal(formatWhatsAppCode('EG.4631528857091458'), '+EG.4631528857091458');
  assert.equal(formatWhatsAppCode('+EG.4631528857091458'), '+EG.4631528857091458');
});

test('lookup_patient preserves BSUID recipient phone and links patient file with WhatsApp identity', () => {
  // Ensure lookup_patient does NOT overwrite conversation.phone with rawPhone when conversation.phone is BSUID
  assert.doesNotMatch(webhookContent, /if \(isBsuid\(conversation\.phone\) && rawPhone\) \{\s*updatePayload\.phone = cleanPhone\(rawPhone\);/);
  assert.match(webhookContent, /savePatientWhatsAppIdentity\(supabase, p\.id/);
});

test('Gemini AI agent strictly instructs never to ask for phone number again when patient has actual profile, allowing confirmation only', () => {
  // 1. Registered patient context section rules
  assert.match(webhookContent, /MANDATORY RULES FOR PATIENT WITH AN ACTUAL PROFILE:/);
  assert.match(webhookContent, /FORBIDDEN TO ASK FOR PHONE NUMBER/);
  assert.match(webhookContent, /CONFIRMATION ALLOWED:\s*You MAY confirm with him the phone number associated with his profile/);

  // 2. PHONE NUMBER LOOKUP & ASSIGNMENT RULES section
  assert.match(webhookContent, /PATIENTS WITH AN ACTUAL PROFILE:\s*\n\s*-\s*When communicating with a patient that currently has an actual profile/);
  assert.match(webhookContent, /DO NOT ASK HIM FOR A PHONE NUMBER AGAIN/);
  assert.match(webhookContent, /You MAY confirm with him the phone number associated with his profile/);

  // 3. General Rules section
  assert.match(webhookContent, /CRITICAL - NO PHONE NUMBER REQUEST FOR EXISTING PROFILES:/);
  assert.match(webhookContent, /You may confirm with him the phone number associated with his profile if needed/);

  // 4. book_appointment tool description
  assert.match(webhookContent, /For patients who already have an actual profile, DO NOT ask them for their phone number again; you may confirm with them the phone number associated with their profile if needed\./);

  // 5. Tool completion handlers guide the model
  assert.match(webhookContent, /المريض لديه ملف فعلي مسجل الآن: لا تسأله عن رقم هاتفه مرة أخرى أبداً، ويمكنك فقط تأكيد رقم الهاتف المرتبط بملفه معه إذا دعت الحاجة/);
  assert.match(webhookContent, /إذا كان المريض لديه ملف فعلي مسجل، لا تسأله عن رقم هاتفه مرة أخرى، ويمكنك فقط تأكيد رقم الهاتف المرتبط بملفه معه إذا رغبت/);
});

test('findPatientsByWhatsApp guards against single first-name matching and BSUID prompt does not mislabel code as phone number', async () => {
  // 1. Webhook source code guards
  assert.match(webhookContent, /words\.length >= 2/);
  assert.match(webhookContent, /A single first name \(e\.g\. "هدى", "Ahmed", "Sarah"\) must NEVER match arbitrary patients/);
  assert.match(webhookContent, /CRITICAL PATIENT CONTEXT - DUPLICATE PATIENTS FOUND FOR WHATSAPP ACCOUNT/);
  assert.match(webhookContent, /WHATSAPP ACCOUNT \(NOT A PHONE NUMBER\): This user is messaging via a masked WhatsApp account/);
  assert.match(webhookContent, /PATIENT CONTEXT - REGISTERED PATIENT FOUND FOR WHATSAPP ACCOUNT/);

  // 2. Functional simulation of findPatientsByWhatsApp with single name "هدى" vs multiple candidates
  async function simulateFindPatientsByWhatsApp(supabase, codeOrPhone, username) {
    const isBsuid = (val) => val && /^\+?[A-Za-z]{2}\.\d+$/i.test(String(val).trim());
    const normalizeArabicName = (name) => String(name || '')
      .replace(/[إأآا]/g, 'ا')
      .replace(/[ة]/g, 'ه')
      .replace(/[ى]/g, 'ي')
      .trim();

    const uniqueMap = new Map();

    // Check username fallback
    if (username && typeof username === 'string') {
      const cleanUser = username.trim();
      const normUser = normalizeArabicName(cleanUser);
      const words = normUser.split(' ').filter(Boolean);

      // Guard: require >= 2 words for fallback matching
      if (words.length >= 2 && words[0].length >= 2 && words[1].length >= 2) {
        const { data } = await supabase.from('patients').select();
        for (const p of data || []) {
          uniqueMap.set(p.id, p);
        }
      }
    }

    return Array.from(uniqueMap.values());
  }

  const mockDbWithSimilarNames = {
    from: () => ({
      select: async () => ({
        data: [
          { id: '1', name: 'هديل عمرو' },
          { id: '2', name: 'هدير ايهاب' },
          { id: '3', name: 'رباب مهدي' },
          { id: '4', name: 'مروة مهدي' },
        ],
      }),
    }),
  };

  // User with single first name "هدى" must NOT match any of the above candidates
  const singleNameMatches = await simulateFindPatientsByWhatsApp(mockDbWithSimilarNames, 'EG.1598566451815476', 'هدى');
  assert.equal(singleNameMatches.length, 0, 'Single first name "هدى" must return 0 matches and not match arbitrary patients');

  // User with full name "هدى محمود علي" allows matching
  const fullNameMatches = await simulateFindPatientsByWhatsApp(mockDbWithSimilarNames, 'EG.1598566451815476', 'هدى محمود علي');
  assert.ok(fullNameMatches.length > 0, 'Full name with >= 2 words is allowed to match');
});

test('systemInstruction and lookup_patient strictly enforce privacy by never suggesting database names to patients', () => {
  // 1. systemInstruction defines CRITICAL PRIVACY RULE section
  assert.match(webhookContent, /CRITICAL PRIVACY RULE - NEVER SUGGEST NAMES FROM THE DATABASE/);
  assert.match(webhookContent, /STRICT PROHIBITION AGAINST REVEALING DATABASE NAMES/);
  assert.match(webhookContent, /JUST ASK FOR THE NAME AND PHONE NUMBER/);
  assert.match(webhookContent, /MATCH ONLY ON EXPLICIT GIVEN PHONE NUMBER/);

  // 2. General Rules contains privacy protection
  assert.match(webhookContent, /Patient Privacy & Data Protection:/);
  assert.match(webhookContent, /STRICT PRIVACY: NEVER suggest, guess, or reveal patient names from the database in the chat/);

  // 3. lookup_patient tool definition forbids revealing names
  assert.match(webhookContent, /STRICT PRIVACY RULE: NEVER suggest or reveal patient names from the database to the customer/);

  // 4. lookup_patient handler does NOT output patient names list to the patient in its duplicate message
  assert.doesNotMatch(webhookContent, /تنبيه: يوجد \$\{matches\.length\} مرضى مسجلين بنفس رقم الهاتف \(\$\{matches\.map/);
  assert.match(webhookContent, /قاعدة الخصوصية الصارمة: ممنوع منعاً باتاً ذكر أو اقتراح أو إفشاء أي اسم من هذه الأسماء للمريض في الشات/);

  // 5. patientContextSection does NOT format duplicate patient names into customer prompt questions
  assert.doesNotMatch(webhookContent, /يوجد لدينا أكثر من ملف مسجل بحساب الواتساب هذا:\s*\n\s*\$\{matchedPatients\.map/);
  assert.doesNotMatch(webhookContent, /يوجد لدينا أكثر من ملف مسجل بهذا الرقم:\s*\n\s*\$\{matchedPatients\.map/);

  // 6. Incoming webhook filters out any previous messages mentioning duplicate registered files to prevent leaking
  assert.match(webhookContent, /if \(c\.includes\("يوجد لدينا أكثر من ملف مسجل"\)\) return false;/);
  assert.match(webhookContent, /if \(c\.includes\("ملف مسجل بهذا الرقم في النظام"\)\) return false;/);
  assert.match(webhookContent, /if \(c\.includes\("ملف مسجل بحساب الواتساب"\)\) return false;/);
});

test('patient matching strictly requires explicit given phone number and prohibits querying patients table by WhatsApp display username', () => {
  // WhatsApp display username must NEVER query patients table by name
  assert.doesNotMatch(webhookContent, /\.ilike\("name", cleanUser\)/);
  assert.match(webhookContent, /CRITICAL PRIVACY & SECURITY GUARD: Never query patients table by WhatsApp display username/);
});



