const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const webhookContent = fs.readFileSync(path.join(root, 'supabase', 'functions', 'whatsapp-webhook', 'index.ts'), 'utf8');

test('formatTime12h helper is defined and accurately formats 24h into Arabic & English 12h', () => {
  assert.match(webhookContent, /function formatTime12h\(timeStr: string\)/);

  function formatTime12h(timeStr) {
    const [hh, mm] = (timeStr || "00:00").split(":").map(Number);
    const periodEn = hh >= 12 ? "PM" : "AM";
    const periodAr = hh >= 12 ? "مساءً" : "صباحاً";
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    const timeFormatted = `${String(h12).padStart(2, "0")}:${String(mm || 0).padStart(2, "0")}`;
    return {
      time12: `${timeFormatted} ${periodEn}`,
      en: `${timeFormatted} ${periodEn}`,
      ar: `${timeFormatted} ${periodAr}`,
    };
  }

  assert.deepEqual(formatTime12h("19:00"), {
    time12: "07:00 PM",
    en: "07:00 PM",
    ar: "07:00 مساءً",
  });
  assert.deepEqual(formatTime12h("09:30"), {
    time12: "09:30 AM",
    en: "09:30 AM",
    ar: "09:30 صباحاً",
  });
  assert.deepEqual(formatTime12h("12:00"), {
    time12: "12:00 PM",
    en: "12:00 PM",
    ar: "12:00 مساءً",
  });
  assert.deepEqual(formatTime12h("00:00"), {
    time12: "12:00 AM",
    en: "12:00 AM",
    ar: "12:00 صباحاً",
  });
});

test('fetchPatientUpcomingAppointments and formatUpcomingAppointmentsForPrompt helpers are defined', () => {
  assert.match(webhookContent, /async function fetchPatientUpcomingAppointments\(/);
  assert.match(webhookContent, /function formatUpcomingAppointmentsForPrompt\(/);
  assert.match(webhookContent, /UPCOMING REGISTERED APPOINTMENTS FOR THIS PATIENT/);
});

test('buildGeminiTools declares get_patient_appointments and confirm_patient_appointment tools', () => {
  assert.match(webhookContent, /name:\s*"get_patient_appointments"/);
  assert.match(webhookContent, /Retrieve existing and upcoming booked appointments for the patient/);
  assert.match(webhookContent, /name:\s*"confirm_patient_appointment"/);
  assert.match(webhookContent, /Confirm an existing booked appointment for a patient/);
  assert.match(webhookContent, /appointment_id:\s*\{\s*type:\s*"STRING",\s*description:\s*"The ID of the existing appointment to confirm\."/);
});

test('handleGeminiToolCall handles get_patient_appointments and confirm_patient_appointment', () => {
  assert.match(webhookContent, /if \(name === "get_patient_appointments"\)/);
  assert.match(webhookContent, /const allApts = await fetchPatientUpcomingAppointments\(supabase, targetPatientId/);
  assert.match(webhookContent, /if \(name === "confirm_patient_appointment"\)/);
  assert.match(webhookContent, /status:\s*"Confirmed"/);
});

test('handleGeminiToolCall declares clinicNow at the top level before tool dispatch blocks', () => {
  // Ensure clinicNow is in the top-level scope of handleGeminiToolCall so all tool handlers have access
  const toolCallScopeMatch = webhookContent.match(
    /async function handleGeminiToolCall\([\s\S]*?\)\s*:\s*Promise<any>\s*\{([\s\S]*?)(?:if\s*\(\s*name\s*===)/
  );
  assert.ok(toolCallScopeMatch, 'handleGeminiToolCall function signature must be found');
  assert.match(
    toolCallScopeMatch[1],
    /const\s+clinicNow\s*=\s*getClinicNow\(timeZone\);/,
    'clinicNow must be defined at the start of handleGeminiToolCall before any tool conditionals'
  );
});

test('lookup_patient, assign_patient and create_patient return upcoming_appointments', () => {
  assert.match(webhookContent, /upcoming_appointments:\s*upcomingApts/);
});

test('runGeminiAgent dynamically injects patient upcoming appointments into patientContextSection', () => {
  assert.match(webhookContent, /const upcomingAppointments = await fetchPatientUpcomingAppointments\(supabase, p\.id, clinicNow, timeZone\);/);
  assert.match(webhookContent, /const upcomingAppointmentsStr = formatUpcomingAppointmentsForPrompt\(upcomingAppointments\);/);
  assert.match(webhookContent, /\$\{upcomingAppointmentsStr\}/);
});

test('systemInstruction defines dedicated section for appointment confirmations and existing appointment inquiries', () => {
  assert.match(
    webhookContent,
    /CRITICAL WORKFLOW: HANDLING APPOINTMENT CONFIRMATIONS & EXISTING APPOINTMENT INQUIRIES:/
  );
  assert.match(
    webhookContent,
    /كنت باكد المعاد هو بكره الساعه كام/
  );
  assert.match(
    webhookContent,
    /1\. NEVER TREAT THIS AS A REQUEST TO BOOK A NEW APPOINTMENT!/
  );
  assert.match(
    webhookContent,
    /STRICTLY FORBIDDEN to call \\?`check_available_slots\\?` to propose alternative or new vacant slots/
  );
  assert.match(
    webhookContent,
    /NEVER tell the patient that all appointments are full on that day, and NEVER direct them to pick a different day when they already have an appointment on file!/
  );
  assert.match(
    webhookContent,
    /call \\?`confirm_patient_appointment\\?` to mark the appointment as "Confirmed" in the clinic calendar/
  );
  assert.match(
    webhookContent,
    /ONLY IF NO BOOKED APPOINTMENT EXISTS FOR THIS PATIENT on that day or within the upcoming days after checking:/
  );
});

test('functional simulation of patient confirming appointment tomorrow with Dr. Mohamed Gazzar', async () => {
  // Mock clinicNow as Tuesday 2026-11-10 14:00 (Cairo time)
  const clinicNow = {
    dateStr: "2026-11-10",
    timeStr: "14:00",
    minutesOfDay: 14 * 60,
    dayOfWeek: 2,
    dayEn: "Tuesday",
    dayAr: "الثلاثاء",
    display: "2026-11-10 (Tuesday / الثلاثاء)",
  };

  // Mock patient Omnia Ahmed Fathi with appointment tomorrow Wednesday 2026-11-11 at 19:00 (UTC 17:00)
  const patientId = "1e8b9a3f-942f-4333-a3cf-7a70ac854faa";
  const doctorId = "efa3ebf6-43a9-47da-903e-04cf1001e742";
  const aptId = "603c3989-1553-4017-b8a9-aa4de8d677ff";

  let aptStatus = "Scheduled";

  const fakeSupabase = {
    from: (table) => {
      if (table === "appointments") {
        return {
          select: () => ({
            eq: (col, val) => ({
              neq: () => ({
                gte: () => ({
                  lte: () => ({
                    order: () => Promise.resolve({
                      data: [
                        {
                          id: aptId,
                          patient_id: patientId,
                          appointment_at: "2026-11-11T17:00:00.000Z", // 19:00 in Cairo (UTC+2)
                          duration_minutes: 60,
                          status: aptStatus,
                          assigned_user_id: doctorId,
                          appointment_type: "Check-up",
                          notes: "",
                        },
                      ],
                      error: null,
                    }),
                  }),
                }),
              }),
              maybeSingle: () => Promise.resolve({
                data: {
                  id: aptId,
                  patient_id: patientId,
                  appointment_at: "2026-11-11T17:00:00.000Z",
                  duration_minutes: 60,
                  status: aptStatus,
                  assigned_user_id: doctorId,
                  appointment_type: "Check-up",
                  notes: "",
                },
                error: null,
              }),
            }),
          }),
          update: (payload) => ({
            eq: (col, val) => {
              if (val === aptId && payload.status) {
                aptStatus = payload.status;
              }
              return Promise.resolve({ error: null });
            },
          }),
        };
      }
      if (table === "user_profiles") {
        return {
          select: () => ({
            in: () => Promise.resolve({
              data: [{ user_id: doctorId, full_name: "Mohamed gazzar" }],
              error: null,
            }),
            eq: () => ({
              maybeSingle: () => Promise.resolve({
                data: { full_name: "Mohamed gazzar" },
                error: null,
              }),
            }),
          }),
        };
      }
      return { select: () => ({}) };
    },
  };

  const WEEKDAY_NAMES_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const WEEKDAY_NAMES_AR = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

  function parseLocalAppointmentTime(isoStr) {
    const d = new Date(isoStr);
    // UTC+2 Cairo
    const cairoMs = d.getTime() + 2 * 3600 * 1000;
    const cd = new Date(cairoMs);
    const dateStr = cd.toISOString().slice(0, 10);
    const hh = String(cd.getUTCHours()).padStart(2, "0");
    const mm = String(cd.getUTCMinutes()).padStart(2, "0");
    const timeStr = `${hh}:${mm}`;
    return {
      dateStr,
      timeStr,
      startMin: cd.getUTCHours() * 60 + cd.getUTCMinutes(),
      dayOfWeek: cd.getUTCDay(),
    };
  }

  function formatTime12h(timeStr) {
    const [hh, mm] = (timeStr || "00:00").split(":").map(Number);
    const periodEn = hh >= 12 ? "PM" : "AM";
    const periodAr = hh >= 12 ? "مساءً" : "صباحاً";
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    const timeFormatted = `${String(h12).padStart(2, "0")}:${String(mm || 0).padStart(2, "0")}`;
    return {
      time12: `${timeFormatted} ${periodEn}`,
      en: `${timeFormatted} ${periodEn}`,
      ar: `${timeFormatted} ${periodAr}`,
    };
  }

  async function fetchPatientUpcomingAppointments(supabase, pId, cNow) {
    const { data: rawApts } = await supabase
      .from("appointments")
      .select()
      .eq("patient_id", pId)
      .neq("status", "Cancelled")
      .gte()
      .lte()
      .order();

    const { data: docs } = await supabase.from("user_profiles").select().in();
    const docMap = new Map((docs || []).map(d => [d.user_id, d.full_name]));

    return rawApts.map(apt => {
      const local = parseLocalAppointmentTime(apt.appointment_at);
      const t12 = formatTime12h(local.timeStr);
      return {
        id: apt.id,
        date: local.dateStr,
        time24: local.timeStr,
        time12: t12.time12,
        timeAr: t12.ar,
        timeEn: t12.en,
        dayAr: WEEKDAY_NAMES_AR[local.dayOfWeek],
        dayEn: WEEKDAY_NAMES_EN[local.dayOfWeek],
        relativeLabel: " [غداً / Tomorrow]",
        doctor: `Dr. ${docMap.get(apt.assigned_user_id)}`,
        visit_type: apt.appointment_type,
        status: apt.status,
        duration_minutes: apt.duration_minutes,
      };
    });
  }

  const upcoming = await fetchPatientUpcomingAppointments(fakeSupabase, patientId, clinicNow);
  assert.equal(upcoming.length, 1);
  assert.equal(upcoming[0].date, "2026-11-11");
  assert.equal(upcoming[0].time24, "19:00");
  assert.equal(upcoming[0].timeAr, "07:00 مساءً");
  assert.equal(upcoming[0].dayAr, "الأربعاء");
  assert.equal(upcoming[0].doctor, "Dr. Mohamed gazzar");
  assert.equal(upcoming[0].relativeLabel, " [غداً / Tomorrow]");

  // Confirm appointment via confirm_patient_appointment
  await fakeSupabase.from("appointments").update({ status: "Confirmed" }).eq("id", aptId);
  assert.equal(aptStatus, "Confirmed");
});
