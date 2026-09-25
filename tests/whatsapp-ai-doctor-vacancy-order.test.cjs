const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const webhookContent = fs.readFileSync(path.join(root, 'supabase', 'functions', 'whatsapp-webhook', 'index.ts'), 'utf8');

test('CLINIC_WEEK_ORDER is defined with Saturday (6) as the first working day', () => {
  assert.match(webhookContent, /const CLINIC_WEEK_ORDER = \[6, 0, 1, 2, 3, 4, 5\];/);
});

test('formatDoctorScheduleForPrompt sorts doctor working days with Saturday before Tuesday', () => {
  assert.match(webhookContent, /CLINIC_WEEK_ORDER\.indexOf\(a\) - CLINIC_WEEK_ORDER\.indexOf\(b\)/);

  // Simulate formatDoctorScheduleForPrompt with Dr. Abdelreheem's schedule [2, 6] (Tuesday and Saturday)
  const CLINIC_WEEK_ORDER = [6, 0, 1, 2, 3, 4, 5];
  const WEEKDAY_NAMES_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const WEEKDAY_NAMES_AR = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

  function formatDoctorSchedule(fullName, sched) {
    const days = (sched?.days || [])
      .map(Number)
      .filter(d => d >= 0 && d <= 6)
      .sort((a, b) => CLINIC_WEEK_ORDER.indexOf(a) - CLINIC_WEEK_ORDER.indexOf(b));

    const shifts = days.map(d => `${WEEKDAY_NAMES_AR[d]} / ${WEEKDAY_NAMES_EN[d]}`);
    return `- Dr. ${fullName}:\n  * ` + shifts.join("\n  * ");
  }

  const result = formatDoctorSchedule("Abdelreheem El Sayed", { days: [2, 6] });
  const satIndex = result.indexOf("Saturday");
  const tueIndex = result.indexOf("Tuesday");

  assert.ok(satIndex !== -1, "Saturday should be present in schedule");
  assert.ok(tueIndex !== -1, "Tuesday should be present in schedule");
  assert.ok(satIndex < tueIndex, "Saturday MUST appear before Tuesday in the doctor prompt schedule");
});

test('buildGeminiTools check_available_slots supports days_ahead parameter for multi-day vacancy checks', () => {
  assert.match(webhookContent, /days_ahead:\s*\{/);
  assert.match(webhookContent, /type:\s*"INTEGER"/);
  assert.match(webhookContent, /Optional number of days to scan \(1 to 7\)/);
});

test('handleGeminiToolCall check_available_slots supports multi-day scan and mandates chronological order', () => {
  assert.match(webhookContent, /const daysAhead = Math\.min\(Math\.max\(Number\(args\.days_ahead\) \|\| 1, 1\), 7\);/);
  assert.match(webhookContent, /for \(let offset = 0; offset < daysAhead; offset\+\+\)/);
  assert.match(webhookContent, /MANDATORY CHRONOLOGICAL ORDER:/);
  assert.match(webhookContent, /NEVER skip an earlier day \(e\.g\. Saturday\) to jump to a later day \(e\.g\. Tuesday\)/);
});

test('runGeminiAgent precomputes 10-day lookahead calendar and provides Middle Eastern clinic week rules', () => {
  assert.match(webhookContent, /Precompute 10-day lookahead calendar reference/);
  assert.match(webhookContent, /Upcoming 10-Day Clinic Calendar Reference/);
  assert.match(webhookContent, /Middle Eastern Clinic Week: The working week begins on SATURDAY/);
  assert.match(webhookContent, /Offer SATURDAY first if available, followed by subsequent days/);
  assert.match(webhookContent, /NEVER skip Saturday to jump to Tuesday!/);
  assert.match(webhookContent, /check_available_slots.*days_ahead:\s*7/);
});
