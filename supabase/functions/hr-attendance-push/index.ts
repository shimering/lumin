import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

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

const validUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

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
  let oneSignalKey = normaliseOneSignalApiKey(
    Deno.env.get("ONESIGNAL_REST_API_KEY") || ""
  );
  const authorization = request.headers.get("Authorization") ?? "";
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse({ error: "The notification service is not configured." }, 500);
  }
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
  const attendanceSessionId = String(body.attendance_session_id ?? "");
  if (!validUuid(attendanceSessionId)) {
    return jsonResponse({ error: "A valid attendance session is required." }, 400);
  }
  // Older clients omit the action and only request check-in notifications.
  const action = body.action ?? "check_in";
  if (action !== "check_in" && action !== "check_out") {
    return jsonResponse({ error: "A valid attendance action is required." }, 400);
  }
  const isCheckOut = action === "check_out";

  const resolvedAppUrl = resolveAppUrl(request, body);
  const notificationUrl = resolvedAppUrl ? `${resolvedAppUrl}/?view=hr` : undefined;

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const [sessionResult, callerResult, rolePermissionsResult, adminRolesResult] = await Promise.all([
    adminClient
      .from("hr_attendance_sessions")
      .select("id,user_id,check_in_at,check_in_method,check_out_at,check_out_method")
      .eq("id", attendanceSessionId)
      .maybeSingle(),
    adminClient
      .from("user_profiles")
      .select("user_id,active,full_name,login_name")
      .eq("user_id", userData.user.id)
      .maybeSingle(),
    adminClient
      .from("role_permissions")
      .select("role_id")
      .eq("page_key", "hr")
      .eq("can_view", true),
    adminClient
      .from("access_roles")
      .select("id")
      .eq("is_admin", true),
  ]);

  const lookupError = sessionResult.error || callerResult.error || rolePermissionsResult.error || adminRolesResult.error;
  if (lookupError) {
    console.error("Could not validate the attendance notification request", lookupError);
    return jsonResponse({ error: "The attendance notification could not be validated." }, 500);
  }
  if (!sessionResult.data) return jsonResponse({ error: "Attendance session not found." }, 404);
  if (!callerResult.data?.active || sessionResult.data.user_id !== userData.user.id) {
    return jsonResponse({ error: "You can notify HR only about your own attendance." }, 403);
  }
  const attendanceMethod = isCheckOut ? sessionResult.data.check_out_method : sessionResult.data.check_in_method;
  if (attendanceMethod !== "mobile_geofence") {
    return jsonResponse({ error: "Only attendance recorded from the dashboard button can send this notification." }, 403);
  }
  const attendanceTimestamp = Date.parse(isCheckOut ? sessionResult.data.check_out_at : sessionResult.data.check_in_at);
  if (!Number.isFinite(attendanceTimestamp) || attendanceTimestamp > Date.now() + 60_000 || Date.now() - attendanceTimestamp > 30 * 60_000) {
    return jsonResponse({ error: "This attendance action is no longer eligible for a notification." }, 409);
  }
  const staffName = String(callerResult.data.full_name || "").trim()
    || String(callerResult.data.login_name || "").trim();

  const recipientRoleIds = [...new Set([
    ...(rolePermissionsResult.data ?? []).map((permission) => permission.role_id),
    ...(adminRolesResult.data ?? []).map((role) => role.id),
  ].filter(Boolean))];
  if (!recipientRoleIds.length) {
    return jsonResponse({ sent: false, skipped: true, reason: "No active role can access HR." });
  }

  const { data: recipientProfiles, error: recipientError } = await adminClient
    .from("user_profiles")
    .select("user_id")
    .eq("active", true)
    .in("role_id", recipientRoleIds)
    .neq("user_id", userData.user.id);
  if (recipientError) {
    console.error("Could not resolve HR notification recipients", recipientError);
    return jsonResponse({ error: "HR notification recipients could not be resolved." }, 500);
  }
  const recipientUserIds = [...new Set((recipientProfiles ?? []).map((profile) => String(profile.user_id)).filter(validUuid))];
  if (!recipientUserIds.length) {
    return jsonResponse({ sent: false, skipped: true, reason: "No other active user can access HR." });
  }
  if (!oneSignalKey) {
    const { data: settings, error: settingsError } = await adminClient
      .from("clinic_settings")
      .select("onesignal_rest_api_key")
      .eq("id", 1)
      .maybeSingle();
    if (settingsError) {
      console.error("Could not load the HR notification configuration", settingsError);
      return jsonResponse({ error: "The notification configuration could not be loaded." }, 500);
    }
    oneSignalKey = normaliseOneSignalApiKey(String(settings?.onesignal_rest_api_key || ""));
  }
  if (!oneSignalKey) return jsonResponse({ error: "ONESIGNAL_REST_API_KEY is not configured." }, 503);

  const usesCurrentOneSignalKey = oneSignalKey.startsWith("os_v2_");
  const oneSignalEndpoint = usesCurrentOneSignalKey
    ? "https://api.onesignal.com/notifications"
    : "https://onesignal.com/api/v1/notifications";

  let oneSignalResponse: Response;
  try {
    const oneSignalBody: Record<string, unknown> = {
      app_id: ONESIGNAL_APP_ID,
      include_external_user_ids: recipientUserIds,
      channel_for_external_user_ids: "push",
      headings: isCheckOut
        ? { en: "Staff check-out", ar: "تسجيل انصراف موظف" }
        : { en: "Staff check-in", ar: "تسجيل حضور موظف" },
      contents: {
        en: `${staffName || "A staff member"} checked ${isCheckOut ? "out" : "in"}. Open HR to review it.`,
        ar: `تم تسجيل ${isCheckOut ? "انصراف" : "حضور"} ${staffName || "أحد الموظفين"}. افتح صفحة الموارد البشرية للمراجعة.`,
      },
      data: { view: "hr", action, attendance_session_id: attendanceSessionId },
      priority: 10,
      ttl: 43_200,
      name: isCheckOut ? "Staff check-out" : "Staff check-in",
    };
    if (notificationUrl) {
      oneSignalBody.url = notificationUrl;
    }
    oneSignalResponse = await fetch(oneSignalEndpoint, {
      method: "POST",
      headers: {
        Authorization: `${usesCurrentOneSignalKey ? "Key" : "Basic"} ${oneSignalKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify(oneSignalBody),
    });
  } catch (error) {
    console.error("OneSignal HR attendance request failed", error);
    return jsonResponse({ error: "OneSignal could not be reached." }, 502);
  }

  const responseBody = await oneSignalResponse.json().catch(() => ({}));
  if (!oneSignalResponse.ok) {
    console.error("OneSignal HR attendance send failed", oneSignalResponse.status, responseBody);
    return jsonResponse({ error: "OneSignal could not send the HR notification." }, 502);
  }
  const recipientCount = responseBody?.recipients !== null
    && responseBody?.recipients !== undefined
    && Number.isFinite(Number(responseBody.recipients))
    ? Number(responseBody.recipients)
    : null;
  if (recipientCount === 0) {
    return jsonResponse({
      sent: false,
      skipped: true,
      reason: "HR-authorized users do not have an active push subscription.",
      eligible_recipient_count: recipientUserIds.length,
      recipient_count: 0,
    });
  }

  return jsonResponse({
    sent: true,
    eligible_recipient_count: recipientUserIds.length,
    recipient_count: recipientCount,
    message_id: responseBody?.id ?? null,
  });
});
