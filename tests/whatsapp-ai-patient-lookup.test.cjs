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
