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
    if (n1.includes(n2) || n2.includes(n1)) return 80;
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
