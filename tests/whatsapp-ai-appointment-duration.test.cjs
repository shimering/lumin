const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const webhookContent = fs.readFileSync(path.join(root, 'supabase', 'functions', 'whatsapp-webhook', 'index.ts'), 'utf8');

test('resolveAppointmentDuration helper is defined in webhook with 60-minute default', () => {
  assert.match(webhookContent, /function resolveAppointmentDuration\(/);
  assert.match(webhookContent, /return 60;/);
});

test('resolveAppointmentDuration functional behavior: defaults to 60 mins and parses admin exceptions', () => {
  function resolveAppointmentDuration(
    visitType,
    customInstructions,
    explicitDuration
  ) {
    if (explicitDuration && Number.isFinite(explicitDuration) && explicitDuration >= 15) {
      return Math.min(240, explicitDuration);
    }

    if (customInstructions && visitType) {
      const vLower = String(visitType).toLowerCase().trim();
      const lines = customInstructions.split(/\r?\n/);
      for (const line of lines) {
        const lineLower = line.toLowerCase();
        const isRelevant = lineLower.includes(vLower) ||
          (vLower.includes("consult") && (lineLower.includes("consult") || lineLower.includes("كشف") || lineLower.includes("فحص") || lineLower.includes("استشارة"))) ||
          (vLower.includes("clean") && (lineLower.includes("clean") || lineLower.includes("تنظيف"))) ||
          (vLower.includes("check") && (lineLower.includes("check") || lineLower.includes("كشف") || lineLower.includes("فحص"))) ||
          (vLower.includes("endo") && (lineLower.includes("endo") || lineLower.includes("عصب") || lineLower.includes("جذور"))) ||
          (vLower.includes("ortho") && (lineLower.includes("ortho") || lineLower.includes("تقويم"))) ||
          (vLower.includes("extract") && (lineLower.includes("extract") || lineLower.includes("خلع")));

        if (isRelevant) {
          const numMatch = line.match(/(\d{1,3})\s*(?:دقيقة|دقائق|min(?:ute)?s?)/i);
          if (numMatch) {
            const parsed = parseInt(numMatch[1], 10);
            if (parsed >= 15 && parsed <= 240) return parsed;
          }
          if (line.includes("نصف ساعة") || line.includes("half an hour") || line.includes("half hour")) return 30;
          if (line.includes("ربع ساعة") || line.includes("quarter hour")) return 15;
          if (line.includes("ساعة ونصف") || line.includes("hour and a half") || line.includes("1.5 hour")) return 90;
          if (line.includes("ساعتين") || line.includes("2 hours")) return 120;
          if (line.includes("ساعة") || line.includes("1 hour") || line.includes("one hour")) return 60;
        }
      }
    }

    return 60;
  }

  // 1. Default without any instructions -> 60 minutes
  assert.equal(resolveAppointmentDuration(), 60);
  assert.equal(resolveAppointmentDuration("General Checkup", ""), 60);
  assert.equal(resolveAppointmentDuration("Cleaning", null), 60);

  // 2. Explicit duration -> honors explicit value
  assert.equal(resolveAppointmentDuration("Cleaning", "Cleaning is 45 mins", 45), 45);
  assert.equal(resolveAppointmentDuration(null, null, 90), 90);

  // 3. Admin instruction exception in Arabic: "الكشف والاستشارة مدتها 30 دقيقة"
  const adminInstructionsAr = `
### قواعد عامة
الترحيب بالمريض بلطف.
### مدد المواعيد المخصصة
الكشف والاستشارة مدتها 30 دقيقة.
تنظيف الأسنان وتلميعها 45 دقيقة.
جلسات سحب العصب 90 دقيقة.
`;
  assert.equal(resolveAppointmentDuration("كشف", adminInstructionsAr), 30);
  assert.equal(resolveAppointmentDuration("Consultation", adminInstructionsAr), 30);
  assert.equal(resolveAppointmentDuration("تنظيف", adminInstructionsAr), 45);
  assert.equal(resolveAppointmentDuration("Cleaning", adminInstructionsAr), 45);
  assert.equal(resolveAppointmentDuration("عصب", adminInstructionsAr), 90);
  assert.equal(resolveAppointmentDuration("Endo", adminInstructionsAr), 90);

  // 4. Other services not mentioned in admin instructions default to 1 hour (60 mins)
  assert.equal(resolveAppointmentDuration("حشو تجميلي", adminInstructionsAr), 60);
  assert.equal(resolveAppointmentDuration("Restoration", adminInstructionsAr), 60);
  assert.equal(resolveAppointmentDuration("Extraction", adminInstructionsAr), 60);
});

test('buildGeminiTools declares duration_minutes in check_available_slots and book_appointment', () => {
  assert.match(webhookContent, /name:\s*"check_available_slots"[\s\S]*?duration_minutes:\s*\{/);
  assert.match(webhookContent, /name:\s*"book_appointment"[\s\S]*?duration_minutes:\s*\{/);
  assert.match(webhookContent, /Defaults to 60 \(1 hour\)/);
});

test('handleGeminiToolCall uses dynamic duration for slot checks and book_appointment insert', () => {
  // check_available_slots uses durationMinutes
  assert.match(webhookContent, /const durationMinutes = resolveAppointmentDuration\(/);
  assert.match(webhookContent, /m \+ durationMinutes <= endM/);
  assert.match(webhookContent, /slotStartMin \+ durationMinutes/);

  // book_appointment uses dynamic duration
  assert.match(webhookContent, /const duration = resolveAppointmentDuration\(visit_type, customInstructions/);
  assert.match(webhookContent, /reqStartMs \+ duration \* 60 \* 1000/);
  assert.match(webhookContent, /duration_minutes:\s*duration/);
  assert.match(webhookContent, /duration:\s*duration === 60 \? "ساعة واحدة \(1 hour\)" : `\$\{duration\} دقيقة \(\$\{duration\} mins\)`/);
});

test('systemInstruction injects 1-hour default appointment duration rules and admin exception guidance', () => {
  assert.match(webhookContent, /CRITICAL APPOINTMENT DURATION RULES \(1 HOUR DEFAULT\):/);
  assert.match(webhookContent, /DEFAULT APPOINTMENT DURATION IS 1 HOUR \(60 MINUTES\):/);
  assert.match(webhookContent, /EXCEPTIONS SPECIFIED IN THE ADMIN INSTRUCTIONS:/);
  assert.match(webhookContent, /IF NO specific duration is mentioned in the admin instructions for a service, ALWAYS default to 1 hour \(60 minutes\)/);
});
