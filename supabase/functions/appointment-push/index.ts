import "jsr:@supabase/functions-js@2.117.3/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const ONESIGNAL_APP_ID = "1796b727-661f-43cb-9770-1b3938e4db8c";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Cache-Control": "no-store", "Content-Type": "application/json" },
  });

const validUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const appointmentChangeTypes = ["created", "rescheduled", "reassigned", "status_changed", "cancelled", "deleted"] as const;
type AppointmentChangeType = typeof appointmentChangeTypes[number];

const arabicAppointmentStatuses: Record<string, string> = {
  Scheduled: "Ù…Ø¬Ø¯ÙˆÙ„",
  Confirmed: "Ù…Ø¤ÙƒØ¯",
  "Checked In": "ØªÙ… Ø§Ù„Ø­Ø¶ÙˆØ±",
  "In Progress": "Ù‚ÙŠØ¯ Ø§Ù„ØªÙ†ÙÙŠØ°",
  Completed: "Ù…ÙƒØªÙ…Ù„",
  Delayed: "Ù…ØªØ£Ø®Ø±",
  Cancelled: "Ù…Ù„ØºÙŠ",
  "No-show": "Ù„Ù… ÙŠØ­Ø¶Ø±",
  "No Show": "Ù„Ù… ÙŠØ­Ø¶Ø±",
};

const normaliseOneSignalApiKey = (value: string) => {
  let key = value
    .trim()
    .replace(/^ONESIGNAL_REST_API_KEY\s*=\s*/i, "")
    .replace(/^authorization\s*:\s*/i, "")
    .replace(/^(?:key|basic)\s+/i, "")
    .trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1).trim();
  }
  return key;
};

function resolveAppUrl(request: Request, body: Record<string, unknown>): string {
  const candidate = String(body?.app_url || "").trim()
    || String(request.headers.get("origin") || "").trim()
    || String(request.headers.get("referer") || "").trim()
    || String(Deno.env.get("CLINIC_APP_URL") || "").trim();

  if (candidate) {
    try {
      const parsed = new URL(candidate);
      if (!parsed.hostname.toLowerCase().endsWith("lumin.pages.dev")) {
        const cleanPath = parsed.pathname.replace(/\/index\.html$/i, "").replace(/\/$/, "");
        return `${parsed.origin}${cleanPath}`;
      }
    } catch {
      // ignore
    }
  }

  const envUrl = String(Deno.env.get("CLINIC_APP_URL") || "").trim();
  if (envUrl) {
    try {
      const parsed = new URL(envUrl);
      if (!parsed.hostname.toLowerCase().endsWith("lumin.pages.dev")) {
        const cleanPath = parsed.pathname.replace(/\/index\.html$/i, "").replace(/\/$/, "");
        return `${parsed.origin}${cleanPath}`;
      }
    } catch {}
  }

  return "";
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const oneSignalKey = normaliseOneSignalApiKey(
    Deno.env.get("ONESIGNAL_REST_API_KEY") || ""
  );
  const authorization = request.headers.get("Authorization") ?? "";
  if (!supabaseUrl || !anonKey || !serviceRoleKey) return jsonResponse({ error: "The notification service is not configured." }, 500);
  if (!authorization.startsWith("Bearer ")) return jsonResponse({ error: "Authentication is required." }, 401);

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const token = authorization.slice("Bearer ".length);
  const { data: userData, error: userError } = await userClient.auth.getUser(token);
  if (userError || !userData.user) return jsonResponse({ error: "Invalid or expired session." }, 401);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "A valid JSON request body is required." }, 400);
  }
  const appointmentId = String(body.appointment_id ?? "");
  const requestedChangeType = String(body.change_type ?? "");
  const changeType = appointmentChangeTypes.includes(requestedChangeType as AppointmentChangeType)
    ? requestedChangeType as AppointmentChangeType
    : null;
  const patientId = String(body.patient_id ?? "");
  const deletedAssignedUserId = String(body.assigned_user_id ?? "");
  const previousStatus = String(body.previous_status ?? "").trim().slice(0, 80);
  const newStatus = String(body.new_status ?? "").trim().slice(0, 80);
  const idempotencyKey = String(body.idempotency_key ?? "");
  if (
    !validUuid(appointmentId) ||
    !changeType ||
    !validUuid(idempotencyKey) ||
    (changeType === "deleted" && (!validUuid(patientId) || !validUuid(deletedAssignedUserId))) ||
    (changeType === "status_changed" && !newStatus)
  ) {
    return jsonResponse({ error: "Invalid appointment notification request." }, 400);
  }

  const resolvedAppUrl = resolveAppUrl(request, body);
  const notificationUrl = resolvedAppUrl ? `${resolvedAppUrl}/?view=appointments` : undefined;

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: callerProfile, error: callerError } = await adminClient
    .from("user_profiles")
    .select("user_id, active, access_roles!inner(is_admin, role_permissions(page_key, can_view, can_modify))")
    .eq("user_id", userData.user.id)
    .single();
  const callerRole = Array.isArray(callerProfile?.access_roles) ? callerProfile.access_roles[0] : callerProfile?.access_roles;
  const canModifyAppointments = Boolean(
    callerRole?.is_admin || callerRole?.role_permissions?.some(
      (permission: { page_key: string; can_view: boolean; can_modify: boolean }) =>
        permission.page_key === "appointments" && permission.can_view && permission.can_modify,
    ),
  );
  if (callerError || !callerProfile?.active || !canModifyAppointments) {
    return jsonResponse({ error: "Appointment modification access is required." }, 403);
  }

  let patientName = "";
  let recipientUserId = "";
  if (changeType === "deleted") {
    const { data: patient, error: patientError } = await adminClient
      .from("patients")
      .select("id, name")
      .eq("id", patientId)
      .maybeSingle();
    if (patientError || !patient) return jsonResponse({ error: "Patient not found." }, 404);
    patientName = String(patient.name ?? "").trim();
    recipientUserId = deletedAssignedUserId;
  } else {
    const { data: appointment, error: appointmentError } = await adminClient
      .from("appointments")
      .select("id, patient_id, assigned_user_id, patients(name)")
      .eq("id", appointmentId)
      .maybeSingle();
    if (appointmentError || !appointment) return jsonResponse({ error: "Appointment not found." }, 404);
    const relatedPatient = Array.isArray(appointment.patients) ? appointment.patients[0] : appointment.patients;
    patientName = String(relatedPatient?.name ?? "").trim();
    recipientUserId = String(appointment.assigned_user_id ?? "");
  }
  if (!validUuid(recipientUserId)) {
    return jsonResponse({ sent: false, skipped: true, reason: "The appointment has no assigned user." });
  }
  const { data: recipientProfile, error: recipientError } = await adminClient
    .from("user_profiles")
    .select("user_id, active")
    .eq("user_id", recipientUserId)
    .maybeSingle();
  if (recipientError) return jsonResponse({ error: "The assigned user could not be checked." }, 500);
  if (!recipientProfile?.active) {
    return jsonResponse({ sent: false, skipped: true, reason: "The assigned user is inactive." });
  }
  if (!oneSignalKey) return jsonResponse({ error: "ONESIGNAL_REST_API_KEY is not configured." }, 503);

  const displayPatientName = patientName.slice(0, 120) || "Patient";
  const displayPreviousStatus = previousStatus || "Previous status";
  const displayNewStatus = newStatus || "Updated";
  const arabicPreviousStatus = arabicAppointmentStatuses[previousStatus] || displayPreviousStatus;
  const arabicNewStatus = arabicAppointmentStatuses[newStatus] || displayNewStatus;
  const notificationCopy = ({
    created: {
      heading: { en: "New appointment", ar: "Ù…ÙˆØ¹Ø¯ Ø¬Ø¯ÙŠØ¯" },
      content: {
        en: `A new appointment was added for ${displayPatientName}.`,
        ar: `ØªÙ…Øª Ø¥Ø¶Ø§ÙØ© Ù…ÙˆØ¹Ø¯ Ø¬Ø¯ÙŠØ¯ Ù„Ù„Ù…Ø±ÙŠØ¶ ${displayPatientName}.`,
      },
      name: "Appointment created",
    },
    rescheduled: {
      heading: { en: "Appointment rescheduled", ar: "ØªÙ… ØªØ¹Ø¯ÙŠÙ„ Ù…ÙˆØ¹Ø¯" },
      content: {
        en: `The appointment date, time, or duration was changed for ${displayPatientName}.`,
        ar: `ØªÙ… ØªØºÙŠÙŠØ± ØªØ§Ø±ÙŠØ® Ø£Ùˆ ÙˆÙ‚Øª Ø£Ùˆ Ù…Ø¯Ø© Ù…ÙˆØ¹Ø¯ Ø§Ù„Ù…Ø±ÙŠØ¶ ${displayPatientName}.`,
      },
      name: "Appointment rescheduled",
    },
    reassigned: {
      heading: { en: "Appointment assigned to you", ar: "ØªÙ… Ø¥Ø³Ù†Ø§Ø¯ Ù…ÙˆØ¹Ø¯ Ø¥Ù„ÙŠÙƒ" },
      content: {
        en: `The appointment for ${displayPatientName} was assigned to you.`,
        ar: `ØªÙ… Ø¥Ø³Ù†Ø§Ø¯ Ù…ÙˆØ¹Ø¯ Ø§Ù„Ù…Ø±ÙŠØ¶ ${displayPatientName} Ø¥Ù„ÙŠÙƒ.`,
      },
      name: "Appointment reassigned",
    },
    status_changed: {
      heading: { en: "Appointment status updated", ar: "ØªÙ… ØªØ­Ø¯ÙŠØ« Ø­Ø§Ù„Ø© Ø§Ù„Ù…ÙˆØ¹Ø¯" },
      content: {
        en: `${displayPatientName}: ${displayPreviousStatus} â†’ ${displayNewStatus}.`,
        ar: `${displayPatientName}: ${arabicPreviousStatus} â† ${arabicNewStatus}.`,
      },
      name: "Appointment status updated",
    },
    cancelled: {
      heading: { en: "Appointment cancelled", ar: "ØªÙ… Ø¥Ù„ØºØ§Ø¡ Ù…ÙˆØ¹Ø¯" },
      content: {
        en: `The appointment for ${displayPatientName} was cancelled.`,
        ar: `ØªÙ… Ø¥Ù„ØºØ§Ø¡ Ù…ÙˆØ¹Ø¯ Ø§Ù„Ù…Ø±ÙŠØ¶ ${displayPatientName}.`,
      },
      name: "Appointment cancelled",
    },
    deleted: {
      heading: { en: "Appointment deleted", ar: "ØªÙ… Ø­Ø°Ù Ù…ÙˆØ¹Ø¯" },
      content: {
        en: `The appointment for ${displayPatientName} was deleted.`,
        ar: `ØªÙ… Ø­Ø°Ù Ù…ÙˆØ¹Ø¯ Ø§Ù„Ù…Ø±ÙŠØ¶ ${displayPatientName}.`,
      },
      name: "Appointment deleted",
    },
  } satisfies Record<AppointmentChangeType, {
    heading: { en: string; ar: string };
    content: { en: string; ar: string };
    name: string;
  }>)[changeType];
  const usesCurrentOneSignalKey = oneSignalKey.startsWith("os_v2_");
  const oneSignalEndpoint = usesCurrentOneSignalKey
    ? "https://api.onesignal.com/notifications"
    : "https://onesignal.com/api/v1/notifications";
  const oneSignalAuthorization = `${usesCurrentOneSignalKey ? "Key" : "Basic"} ${oneSignalKey}`;
  let oneSignalResponse: Response;
  try {
    const oneSignalBody: Record<string, unknown> = {
      app_id: ONESIGNAL_APP_ID,
      include_external_user_ids: [recipientUserId],
      channel_for_external_user_ids: "push",
      headings: notificationCopy.heading,
      contents: notificationCopy.content,
      data: {
        view: "appointments",
        appointment_id: appointmentId,
        change_type: changeType,
        recipient_user_id: recipientUserId,
      },
      priority: 10,
      ttl: 86400,
      idempotency_key: idempotencyKey,
      name: `${notificationCopy.name} ${appointmentId}`,
    };
    if (notificationUrl) {
      oneSignalBody.url = notificationUrl;
    }
    oneSignalResponse = await fetch(oneSignalEndpoint, {
      method: "POST",
      headers: {
        Authorization: oneSignalAuthorization,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify(oneSignalBody),
    });
  } catch (error) {
    console.error("OneSignal request failed before receiving a response", error);
    return jsonResponse({ error: "OneSignal could not be reached.", code: "ONESIGNAL_UNREACHABLE" }, 502);
  }
  const responseBody = await oneSignalResponse.json().catch(() => ({}));
  if (!oneSignalResponse.ok) {
    console.error("OneSignal send failed", oneSignalResponse.status, responseBody);
    const providerErrors = Array.isArray(responseBody?.errors)
      ? responseBody.errors.map((error: unknown) => String(error)).slice(0, 3)
      : [];
    return jsonResponse({
      error: "OneSignal could not send the notification.",
      code: "ONESIGNAL_REJECTED",
      provider_status: oneSignalResponse.status,
      provider_errors: providerErrors,
    }, 502);
  }
  const rawRecipientCount = responseBody?.recipients;
  const recipientCount = rawRecipientCount !== null && rawRecipientCount !== undefined && Number.isFinite(Number(rawRecipientCount))
    ? Number(rawRecipientCount)
    : null;
  if (recipientCount === 0) {
    console.warn("OneSignal accepted the request but found no active push subscription", {
      message_id: responseBody.id ?? null,
      recipient_user_id: recipientUserId,
      change_type: changeType,
    });
    return jsonResponse({
      sent: false,
      skipped: true,
      code: "NO_ACTIVE_PUSH_SUBSCRIPTION",
      reason: "The assigned user does not have an active push subscription.",
      message_id: responseBody.id ?? null,
      recipient_user_id: recipientUserId,
      recipient_count: 0,
    });
  }
  console.info("OneSignal appointment notification accepted", {
    message_id: responseBody.id ?? null,
    recipient_user_id: recipientUserId,
    recipient_count: recipientCount,
    change_type: changeType,
  });
  return jsonResponse({
    sent: true,
    message_id: responseBody.id ?? null,
    recipient_user_id: recipientUserId,
    recipient_count: recipientCount,
  });
});
