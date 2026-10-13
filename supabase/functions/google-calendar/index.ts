import "jsr:@supabase/functions-js@2.117.3/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];
const DEFAULT_APP_URL = Deno.env.get("CLINIC_APP_URL") || "";
const CLINIC_TIME_ZONE = "Africa/Cairo";

type AdminClient = ReturnType<typeof createClient<any>>;
type AppointmentRecord = {
  id?: string | number | null;
  patient_id?: string | null;
  assigned_user_id?: string | null;
  appointment_at?: string | null;
  appointment_type?: string | null;
  status?: string | null;
  duration_minutes?: string | number | null;
  patients?: { name?: string | null } | Array<{ name?: string | null }> | null;
};

class HttpError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = "REQUEST_FAILED") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function configuration() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://pqbayjkypzfxvnksgwwf.supabase.co";
  return {
    supabaseUrl,
    anonKey: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    clientId: Deno.env.get("GOOGLE_CALENDAR_CLIENT_ID") || "",
    clientSecret: Deno.env.get("GOOGLE_CALENDAR_CLIENT_SECRET") || "",
    encryptionKey: Deno.env.get("GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY") || "",
    redirectUri: Deno.env.get("GOOGLE_CALENDAR_REDIRECT_URI")
      ?? `${supabaseUrl}/functions/v1/google-calendar/callback`,
    appUrl: Deno.env.get("GOOGLE_CALENDAR_APP_URL") || DEFAULT_APP_URL,
  };
}

function providerConfigured(config = configuration()) {
  return Boolean(config.clientId && config.clientSecret && config.encryptionKey);
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function base64Url(bytes: Uint8Array) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

async function tokenCryptoKey(secret: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptToken(token: string, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await tokenCryptoKey(secret);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(token),
  );
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`;
}

async function decryptToken(value: string, secret: string) {
  const [version, ivValue, encryptedValue] = value.split(".");
  if (version !== "v1" || !ivValue || !encryptedValue) throw new HttpError("Stored Google credentials are invalid.", 500, "INVALID_CREDENTIALS");
  const key = await tokenCryptoKey(secret);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivValue) },
    key,
    base64ToBytes(encryptedValue),
  );
  return new TextDecoder().decode(decrypted);
}

function decodeJwtPayload(token: string) {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, "=");
    return JSON.parse(new TextDecoder().decode(base64ToBytes(padded)));
  } catch {
    return {};
  }
}

function appRedirect(config: ReturnType<typeof configuration>, result: "connected" | "error", message = "", customAppUrl?: string) {
  let targetBase = customAppUrl || config.appUrl || DEFAULT_APP_URL;
  if (targetBase) {
    try {
      const parsed = new URL(targetBase);
      if (parsed.hostname.toLowerCase().endsWith("lumin.pages.dev")) {
        targetBase = "";
      }
    } catch {
      targetBase = "";
    }
  }
  if (!targetBase) targetBase = "/";
  try {
    const url = new URL(targetBase, "https://localhost");
    url.searchParams.set("google_calendar", result);
    if (message) url.searchParams.set("google_calendar_message", message.slice(0, 180));
    url.hash = "settings";
    return targetBase.startsWith("http") ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return `/?google_calendar=${result}${message ? `&google_calendar_message=${encodeURIComponent(message.slice(0, 180))}` : ""}#settings`;
  }
}

async function tokenRequest(parameters: Record<string, string>) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(parameters),
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("Google OAuth token request failed", response.status, body?.error);
    throw new HttpError("Google authorization could not be completed.", 502, "GOOGLE_TOKEN_FAILED");
  }
  return body;
}

async function googleApi(accessToken: string, path: string, options: RequestInit = {}) {
  const response = await fetch(`${GOOGLE_CALENDAR_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = String(body?.error?.message || `Google Calendar returned ${response.status}.`);
    const error = new HttpError(reason, [404, 409].includes(response.status) ? response.status : 502, "GOOGLE_CALENDAR_FAILED");
    throw error;
  }
  return body;
}

async function authenticatedUser(request: Request, admin: AdminClient) {
  const authorization = request.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) throw new HttpError("Authentication is required.", 401, "AUTH_REQUIRED");
  const { data, error } = await admin.auth.getUser(authorization.slice("Bearer ".length));
  if (error || !data.user) throw new HttpError("Invalid or expired session.", 401, "INVALID_SESSION");
  const { data: profile, error: profileError } = await admin
    .from("user_profiles")
    .select("user_id, active")
    .eq("user_id", data.user.id)
    .maybeSingle();
  if (profileError || !profile?.active) throw new HttpError("This account is not active.", 403, "ACCOUNT_INACTIVE");
  return data.user;
}

async function callerCanManageAppointments(userId: string, admin: AdminClient) {
  const { data, error } = await admin
    .from("user_profiles")
    .select("active, access_roles(is_admin, role_permissions(page_key, can_view, can_modify))")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data?.active) return false;
  const role = Array.isArray(data.access_roles) ? data.access_roles[0] : data.access_roles;
  return Boolean(role?.is_admin || role?.role_permissions?.some(
    (permission: { page_key: string; can_view: boolean; can_modify: boolean }) =>
      permission.page_key === "appointments" && permission.can_view && permission.can_modify,
  ));
}

async function accessTokenForUser(userId: string, admin: AdminClient, cache: Map<string, string>) {
  const cached = cache.get(userId);
  if (cached) return cached;
  const config = configuration();
  if (!providerConfigured(config)) throw new HttpError("Google Calendar is not configured by the clinic administrator.", 503, "PROVIDER_NOT_CONFIGURED");
  const { data: credentials, error } = await admin
    .from("google_calendar_credentials")
    .select("refresh_token_encrypted")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !credentials) throw new HttpError("Google Calendar is not connected for this user.", 404, "NOT_CONNECTED");
  const refreshToken = await decryptToken(credentials.refresh_token_encrypted, config.encryptionKey);
  const tokens = await tokenRequest({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  if (!tokens.access_token) throw new HttpError("Google did not return an access token.", 502, "GOOGLE_TOKEN_FAILED");
  cache.set(userId, tokens.access_token);
  return tokens.access_token as string;
}

async function listWritableCalendars(userId: string, admin: AdminClient, cache = new Map<string, string>()) {
  const accessToken = await accessTokenForUser(userId, admin, cache);
  const body = await googleApi(accessToken, "/users/me/calendarList?maxResults=250&minAccessRole=writer");
  return (body?.items || []).map((calendar: Record<string, unknown>) => ({
    id: String(calendar.id || ""),
    name: String(calendar.summaryOverride || calendar.summary || calendar.id || "Calendar"),
    primary: Boolean(calendar.primary),
    access_role: String(calendar.accessRole || "reader"),
  })).filter((calendar: { id: string }) => calendar.id);
}

async function deleteMappedEvent(mapping: Record<string, unknown>, admin: AdminClient, cache: Map<string, string>) {
  try {
    const accessToken = await accessTokenForUser(String(mapping.user_id), admin, cache);
    await googleApi(
      accessToken,
      `/calendars/${encodeURIComponent(String(mapping.calendar_id))}/events/${encodeURIComponent(String(mapping.event_id))}?sendUpdates=none`,
      { method: "DELETE" },
    );
  } catch (error) {
    if (!(error instanceof HttpError && [404].includes(error.status))) {
      console.warn("Could not remove a mapped Google Calendar event", error);
    }
  }
  await admin.from("google_calendar_events").delete().eq("appointment_id", String(mapping.appointment_id));
}

function googleEventPayload(appointment: AppointmentRecord) {
  const patientRelation = Array.isArray(appointment.patients) ? appointment.patients[0] : appointment.patients;
  const isCalendarNote = !appointment.patient_id;
  const patientName = String(patientRelation?.name || "Patient").trim().slice(0, 120) || "Patient";
  const type = String(appointment.appointment_type || "Appointment").trim().slice(0, 120) || "Appointment";
  const status = String(appointment.status || "Scheduled").trim().slice(0, 60) || "Scheduled";
  const start = new Date(String(appointment.appointment_at || ""));
  const end = new Date(start.getTime() + Math.max(15, Number(appointment.duration_minutes) || 30) * 60000);
  return {
    summary: `${status === "Cancelled" ? "Cancelled â€¢ " : ""}${isCalendarNote ? type : `${patientName} â€” ${type}`}`,
    description: isCalendarNote
      ? "Calendar note managed by Lumin Dental Clinic."
      : `Status: ${status}\nManaged by Lumin Dental Clinic.`,
    start: { dateTime: start.toISOString(), timeZone: CLINIC_TIME_ZONE },
    end: { dateTime: end.toISOString(), timeZone: CLINIC_TIME_ZONE },
    visibility: "private",
    transparency: status === "Cancelled" ? "transparent" : "opaque",
    extendedProperties: {
      private: {
        luminAppointmentId: String(appointment.id),
        luminAssignedUserId: String(appointment.assigned_user_id || ""),
      },
    },
  };
}

async function loadAppointment(appointmentId: string, admin: AdminClient) {
  const { data, error } = await admin
    .from("appointments")
    .select("id, patient_id, assigned_user_id, appointment_at, appointment_type, status, duration_minutes, updated_at, patients(name)")
    .eq("id", appointmentId)
    .maybeSingle();
  if (error) throw new HttpError("The appointment could not be loaded.", 500, "APPOINTMENT_LOAD_FAILED");
  return data;
}

async function syncAppointmentOnce(appointmentId: string, admin: AdminClient, cache: Map<string, string>) {
  const appointment = await loadAppointment(appointmentId, admin);
  const { data: existingMapping } = await admin
    .from("google_calendar_events")
    .select("appointment_id, user_id, calendar_id, event_id, appointment_version")
    .eq("appointment_id", appointmentId)
    .maybeSingle();

  if (!appointment?.assigned_user_id) {
    if (existingMapping) await deleteMappedEvent(existingMapping, admin, cache);
    return { version: null, synced: false };
  }

  const { data: connection, error: connectionError } = await admin
    .from("google_calendar_connections")
    .select("*")
    .eq("user_id", appointment.assigned_user_id)
    .maybeSingle();
  if (connectionError) throw connectionError;
  if (!connection?.enabled) {
    if (existingMapping && existingMapping.user_id !== appointment.assigned_user_id) {
      await deleteMappedEvent(existingMapping, admin, cache);
    }
    return { version: appointment.updated_at, synced: false };
  }

  if (existingMapping && (
    existingMapping.user_id !== appointment.assigned_user_id
    || existingMapping.calendar_id !== connection.calendar_id
  )) {
    await deleteMappedEvent(existingMapping, admin, cache);
  }

  const { data: currentMapping } = await admin
    .from("google_calendar_events")
    .select("appointment_id, user_id, calendar_id, event_id, appointment_version")
    .eq("appointment_id", appointmentId)
    .maybeSingle();
  const accessToken = await accessTokenForUser(appointment.assigned_user_id, admin, cache);
  const payload = googleEventPayload(appointment);
  let eventId = currentMapping?.event_id || "";

  if (eventId) {
    try {
      await googleApi(
        accessToken,
        `/calendars/${encodeURIComponent(connection.calendar_id)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
        { method: "PUT", body: JSON.stringify(payload) },
      );
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 404)) throw error;
      eventId = "";
    }
  }
  if (!eventId) {
    const deterministicEventId = `lumin${String(appointment.id).replace(/-/g, "")}`;
    try {
      const created = await googleApi(
        accessToken,
        `/calendars/${encodeURIComponent(connection.calendar_id)}/events?sendUpdates=none`,
        { method: "POST", body: JSON.stringify({ ...payload, id: deterministicEventId }) },
      );
      eventId = String(created?.id || deterministicEventId);
    } catch (error) {
      // A stable Google event ID makes simultaneous rapid app updates idempotent.
      // If another request created it first, update that same event instead.
      if (!(error instanceof HttpError && error.status === 409)) throw error;
      await googleApi(
        accessToken,
        `/calendars/${encodeURIComponent(connection.calendar_id)}/events/${encodeURIComponent(deterministicEventId)}?sendUpdates=none`,
        { method: "PUT", body: JSON.stringify(payload) },
      );
      eventId = deterministicEventId;
    }
    if (!eventId) throw new HttpError("Google did not return an event identifier.", 502, "GOOGLE_EVENT_FAILED");
  }

  await admin.from("google_calendar_events").upsert({
    appointment_id: appointmentId,
    user_id: appointment.assigned_user_id,
    calendar_id: connection.calendar_id,
    event_id: eventId,
    appointment_version: appointment.updated_at,
    synced_at: new Date().toISOString(),
    last_error: null,
  }, { onConflict: "appointment_id" });
  await admin.from("google_calendar_connections").update({
    last_sync_at: new Date().toISOString(),
    last_error: null,
    updated_at: new Date().toISOString(),
  }).eq("user_id", appointment.assigned_user_id);
  return { version: appointment.updated_at, synced: true };
}

async function syncAppointment(appointmentId: string, admin: AdminClient, cache = new Map<string, string>()) {
  let lastResult = { version: null as string | null, synced: false };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    lastResult = await syncAppointmentOnce(appointmentId, admin, cache);
    const latest = await loadAppointment(appointmentId, admin);
    const latestVersion = latest?.updated_at || null;
    if (latestVersion === lastResult.version) return lastResult;
  }
  return lastResult;
}

async function syncAllForUser(userId: string, admin: AdminClient) {
  const cache = new Map<string, string>();
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data: appointments, error } = await admin
    .from("appointments")
    .select("id")
    .eq("assigned_user_id", userId)
    .gte("appointment_at", cutoff)
    .order("appointment_at", { ascending: true })
    .limit(500);
  if (error) throw new HttpError("Appointments could not be loaded for synchronization.", 500, "APPOINTMENT_LOAD_FAILED");
  const activeIds = new Set((appointments || []).map((appointment: { id: string }) => appointment.id));
  const { data: mappings } = await admin
    .from("google_calendar_events")
    .select("appointment_id, user_id, calendar_id, event_id")
    .eq("user_id", userId);
  for (const mapping of mappings || []) {
    if (!activeIds.has(mapping.appointment_id)) await deleteMappedEvent(mapping, admin, cache);
  }
  let synced = 0;
  for (const appointment of appointments || []) {
    const result = await syncAppointment(appointment.id, admin, cache);
    if (result.synced) synced += 1;
  }
  return { synced, total: appointments?.length || 0 };
}

async function handleCallback(request: Request, admin: AdminClient) {
  const config = configuration();
  const url = new URL(request.url);
  if (!providerConfigured(config)) return Response.redirect(appRedirect(config, "error", "Google Calendar is not configured."), 302);
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const providerError = url.searchParams.get("error") || "";
  let customAppUrl: string | undefined;
  if (state.includes(".")) {
    const encodedUrl = state.split(".")[1];
    try {
      customAppUrl = new TextDecoder().decode(base64ToBytes(encodedUrl));
    } catch {}
  }
  if (!state || providerError || !code) {
    return Response.redirect(appRedirect(config, "error", providerError === "access_denied" ? "Google connection was cancelled." : "Google authorization was not completed.", customAppUrl), 302);
  }
  try {
    const stateHash = await sha256(state);
    const { data: storedState } = await admin
      .from("google_calendar_oauth_states")
      .select("state_hash, user_id, expires_at")
      .eq("state_hash", stateHash)
      .maybeSingle();
    await admin.from("google_calendar_oauth_states").delete().eq("state_hash", stateHash);
    if (!storedState || new Date(storedState.expires_at).getTime() <= Date.now()) {
      throw new HttpError("The Google authorization request expired.", 400, "OAUTH_STATE_INVALID");
    }
    const tokens = await tokenRequest({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    });
    const { data: currentCredentials } = await admin
      .from("google_calendar_credentials")
      .select("refresh_token_encrypted")
      .eq("user_id", storedState.user_id)
      .maybeSingle();
    const encryptedRefreshToken = tokens.refresh_token
      ? await encryptToken(tokens.refresh_token, config.encryptionKey)
      : currentCredentials?.refresh_token_encrypted;
    if (!encryptedRefreshToken) throw new HttpError("Google did not provide offline calendar access. Please connect again.", 400, "REFRESH_TOKEN_MISSING");
    const jwtPayload = decodeJwtPayload(String(tokens.id_token || ""));
    const calendarBody = await googleApi(String(tokens.access_token), "/users/me/calendarList?maxResults=250&minAccessRole=writer");
    const calendars = calendarBody?.items || [];
    const primary = calendars.find((calendar: Record<string, unknown>) => calendar.primary) || calendars[0];
    if (!primary?.id) throw new HttpError("No writable Google Calendar was found.", 400, "NO_WRITABLE_CALENDAR");
    const now = new Date().toISOString();
    await admin.from("google_calendar_credentials").upsert({
      user_id: storedState.user_id,
      refresh_token_encrypted: encryptedRefreshToken,
      granted_scopes: String(tokens.scope || "").split(" ").filter(Boolean),
      updated_at: now,
    }, { onConflict: "user_id" });
    await admin.from("google_calendar_connections").upsert({
      user_id: storedState.user_id,
      google_email: String(jwtPayload.email || primary.id || ""),
      calendar_id: String(primary.id),
      calendar_name: String(primary.summaryOverride || primary.summary || primary.id),
      enabled: true,
      connected_at: now,
      updated_at: now,
      last_error: null,
    }, { onConflict: "user_id" });
    return Response.redirect(appRedirect(config, "connected", "", customAppUrl), 302);
  } catch (error) {
    console.error("Google Calendar OAuth callback failed", error);
    const message = error instanceof Error ? error.message : "Google Calendar connection failed.";
    return Response.redirect(appRedirect(config, "error", message, customAppUrl), 302);
  }
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const config = configuration();
  if (!config.supabaseUrl || !config.serviceRoleKey) return jsonResponse({ error: "The calendar service is not configured." }, 500);
  const admin = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (request.method === "GET") return handleCallback(request, admin);
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);

  try {
    const user = await authenticatedUser(request, admin);
    const body = await request.json().catch(() => ({}));
    const action = String(body?.action || "status");
    const configured = providerConfigured(config);

    if (action === "status") {
      const { data: connection, error } = await admin
        .from("google_calendar_connections")
        .select("user_id, google_email, calendar_id, calendar_name, enabled, connected_at, updated_at, last_sync_at, last_error")
        .eq("user_id", user.id)
        .maybeSingle();
      if (error) throw error;
      return jsonResponse({ provider_configured: configured, connected: Boolean(connection), connection });
    }

    if (!configured) throw new HttpError("Google Calendar is not configured by the clinic administrator.", 503, "PROVIDER_NOT_CONFIGURED");

    if (action === "begin-connect") {
      const requestedAppUrl = String(body?.app_url || "").trim();
      const stateBytes = crypto.getRandomValues(new Uint8Array(24));
      const randomPrefix = base64Url(stateBytes);
      const state = requestedAppUrl
        ? `${randomPrefix}.${base64Url(new TextEncoder().encode(requestedAppUrl))}`
        : randomPrefix;
      const stateHash = await sha256(state);
      await admin.from("google_calendar_oauth_states").delete().lt("expires_at", new Date().toISOString());
      const { error } = await admin.from("google_calendar_oauth_states").insert({
        state_hash: stateHash,
        user_id: user.id,
        expires_at: new Date(Date.now() + 10 * 60000).toISOString(),
      });
      if (error) throw error;
      const authorizationUrl = new URL(GOOGLE_AUTH_URL);
      authorizationUrl.searchParams.set("client_id", config.clientId);
      authorizationUrl.searchParams.set("redirect_uri", config.redirectUri);
      authorizationUrl.searchParams.set("response_type", "code");
      authorizationUrl.searchParams.set("access_type", "offline");
      authorizationUrl.searchParams.set("prompt", "consent");
      authorizationUrl.searchParams.set("include_granted_scopes", "true");
      authorizationUrl.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
      authorizationUrl.searchParams.set("state", state);
      return jsonResponse({ authorization_url: authorizationUrl.toString(), redirect_uri: config.redirectUri });
    }

    if (action === "disconnect") {
      await admin.from("google_calendar_oauth_states").delete().eq("user_id", user.id);
      await admin.from("google_calendar_events").delete().eq("user_id", user.id);
      await admin.from("google_calendar_credentials").delete().eq("user_id", user.id);
      await admin.from("google_calendar_connections").delete().eq("user_id", user.id);
      return jsonResponse({ disconnected: true });
    }

    if (action === "list-calendars") {
      return jsonResponse({ calendars: await listWritableCalendars(user.id, admin) });
    }

    if (action === "select-calendar") {
      const calendarId = String(body?.calendar_id || "");
      const calendars = await listWritableCalendars(user.id, admin);
      const selected = calendars.find((calendar: { id: string }) => calendar.id === calendarId);
      if (!selected) throw new HttpError("Choose a writable Google Calendar.", 400, "INVALID_CALENDAR");
      const { data: oldConnection } = await admin.from("google_calendar_connections").select("calendar_id").eq("user_id", user.id).maybeSingle();
      if (oldConnection?.calendar_id && oldConnection.calendar_id !== selected.id) {
        const cache = new Map<string, string>();
        const { data: mappings } = await admin.from("google_calendar_events").select("appointment_id, user_id, calendar_id, event_id").eq("user_id", user.id);
        for (const mapping of mappings || []) await deleteMappedEvent(mapping, admin, cache);
      }
      await admin.from("google_calendar_connections").update({
        calendar_id: selected.id,
        calendar_name: selected.name,
        updated_at: new Date().toISOString(),
        last_error: null,
      }).eq("user_id", user.id);
      const result = await syncAllForUser(user.id, admin);
      return jsonResponse({ selected, ...result });
    }

    if (action === "set-enabled") {
      const enabled = Boolean(body?.enabled);
      const { error } = await admin.from("google_calendar_connections").update({
        enabled,
        updated_at: new Date().toISOString(),
        last_error: null,
      }).eq("user_id", user.id);
      if (error) throw error;
      const result = enabled ? await syncAllForUser(user.id, admin) : { synced: 0, total: 0 };
      return jsonResponse({ enabled, ...result });
    }

    if (action === "sync-all") {
      const result = await syncAllForUser(user.id, admin);
      return jsonResponse(result);
    }

    if (action === "sync-appointment") {
      if (!(await callerCanManageAppointments(user.id, admin))) throw new HttpError("Appointment modification access is required.", 403, "APPOINTMENTS_MODIFY_ACCESS_REQUIRED");
      const appointmentId = String(body?.appointment_id || "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(appointmentId)) {
        throw new HttpError("A valid appointment identifier is required.", 400, "INVALID_APPOINTMENT");
      }
      const result = await syncAppointment(appointmentId, admin);
      return jsonResponse(result);
    }

    throw new HttpError("Unknown Google Calendar action.", 400, "UNKNOWN_ACTION");
  } catch (error) {
    console.error("Google Calendar function failed", error);
    const status = error instanceof HttpError ? error.status : 500;
    const code = error instanceof HttpError ? error.code : "INTERNAL_ERROR";
    const message = error instanceof Error ? error.message : "Google Calendar request failed.";
    return jsonResponse({ error: message, code }, status);
  }
});
