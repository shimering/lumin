import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Cache-Control": "no-store", "Content-Type": "application/json" },
  });

function getSupabaseClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  return createClient(supabaseUrl, supabaseKey);
}

// Check if an identifier is a WhatsApp Business-Scoped User ID (BSUID) or username-protected ID
function isBsuid(val: string): boolean {
  if (!val || typeof val !== "string") return false;
  const s = val.trim();
  return /^[A-Za-z]{2}\.\d+$/i.test(s);
}

// Clean phone numbers to standard international format (digits only, e.g. 9647701234567)
function cleanPhone(raw: string): string {
  if (isBsuid(raw)) return String(raw).trim();
  return String(raw || "").replace(/[^\d]/g, "");
}

// Format phone for local matching (extract last 9-10 digits)
function getPhoneTail(phone: string): string {
  if (isBsuid(phone)) return String(phone).trim();
  const cleaned = cleanPhone(phone);
  return cleaned.length > 9 ? cleaned.slice(-9) : cleaned;
}

// Extract sender identifier from wamid (e.g. wamid.HBgTRUcu... -> EG.1016355928130143)
function extractIdentifierFromWamid(wamid: string): string | null {
  if (!wamid || typeof wamid !== "string" || !wamid.startsWith("wamid.HBg")) return null;
  try {
    const parts = wamid.split(".");
    if (!parts[1]) return null;
    const b64 = parts[1].replace(/^HBg[A-Za-z0-9]/, "");
    if (!b64) return null;
    const decoded = atob(b64);
    const bsuidMatch = decoded.match(/([A-Za-z]{2}\.\d+)/);
    if (bsuidMatch) return bsuidMatch[1];
    const phoneMatch = decoded.match(/(\d{9,15})/);
    if (phoneMatch) return phoneMatch[1];
  } catch {
    // ignore decode error
  }
  return null;
}

// Fetch WhatsApp and Gemini credentials from clinic_settings or environment
async function getClinicWhatsAppSettings(supabase: any) {
  const { data } = await supabase
    .from("clinic_settings")
    .select(
      "whatsapp_enabled, whatsapp_phone_number_id, whatsapp_business_account_id, whatsapp_access_token, whatsapp_verify_token, gemini_api_key, whatsapp_ai_instructions, whatsapp_ai_model, attendance_timezone, onesignal_rest_api_key"
    )
    .eq("id", 1)
    .maybeSingle();

  return {
    enabled: Boolean(data?.whatsapp_enabled ?? true),
    phoneId: String(data?.whatsapp_phone_number_id || Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") || "").trim(),
    wabaId: String(data?.whatsapp_business_account_id || Deno.env.get("WHATSAPP_BUSINESS_ACCOUNT_ID") || "").trim(),
    accessToken: String(data?.whatsapp_access_token || Deno.env.get("WHATSAPP_ACCESS_TOKEN") || "").trim(),
    verifyToken: String(data?.whatsapp_verify_token || Deno.env.get("WHATSAPP_VERIFY_TOKEN") || "lumin_secret_token").trim(),
    geminiApiKey: String(data?.gemini_api_key || Deno.env.get("GEMINI_API_KEY") || "").trim(),
    aiInstructions: String(data?.whatsapp_ai_instructions || "").trim(),
    aiModel: String(data?.whatsapp_ai_model || "gemini-3.5-flash-lite").trim(),
    attendanceTimezone: String(data?.attendance_timezone || "Africa/Cairo").trim(),
    oneSignalApiKey: String(data?.onesignal_rest_api_key || Deno.env.get("ONESIGNAL_REST_API_KEY") || "").trim(),
  };
}

// Send a WhatsApp text message via Meta Graph API
async function sendMetaWhatsAppMessage(
  phoneId: string,
  accessToken: string,
  toPhone: string,
  text: string,
  contextMessageId?: string | null
) {
  const isTargetBsuid = isBsuid(toPhone);
  const clean = isTargetBsuid ? toPhone.trim() : cleanPhone(toPhone);
  if (!phoneId || !accessToken || !clean || !text) {
    console.warn("sendMetaWhatsAppMessage: missing required parameter", {
      phoneId: Boolean(phoneId),
      accessToken: Boolean(accessToken),
      toPhone: Boolean(clean),
    });
    return null;
  }

  const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;
  const payload: any = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    type: "text",
    text: { body: text },
  };

  if (isTargetBsuid) {
    payload.recipient = clean;
  } else {
    payload.to = clean;
  }

  if (contextMessageId) {
    payload.context = { message_id: contextMessageId };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error("Meta Graph API error:", data);
    throw new Error(data?.error?.message || "Failed to send WhatsApp message via Meta API");
  }
  return data;
}

// Send a WhatsApp emoji reaction via Meta Graph API
async function sendMetaWhatsAppReaction(
  phoneId: string,
  accessToken: string,
  toPhone: string,
  messageId: string,
  emoji: string | null
) {
  const isTargetBsuid = isBsuid(toPhone);
  const clean = isTargetBsuid ? toPhone.trim() : cleanPhone(toPhone);
  if (!phoneId || !accessToken || !clean || !messageId) {
    console.warn("sendMetaWhatsAppReaction: missing required parameter", {
      phoneId: Boolean(phoneId),
      accessToken: Boolean(accessToken),
      toPhone: Boolean(clean),
      messageId: Boolean(messageId),
    });
    return null;
  }

  const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;
  const reactionPayload: any = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    type: "reaction",
    reaction: {
      message_id: messageId,
      emoji: emoji || "",
    },
  };

  if (isTargetBsuid) {
    reactionPayload.recipient = clean;
  } else {
    reactionPayload.to = clean;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(reactionPayload),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error("Meta Graph API reaction error:", data);
    throw new Error(data?.error?.message || "Failed to send reaction via Meta API");
  }
  return data;
}

// Send a WhatsApp audio message via Meta Graph API
async function sendMetaWhatsAppAudioMessage(
  phoneId: string,
  accessToken: string,
  toPhone: string,
  audioUrl: string
) {
  const isTargetBsuid = isBsuid(toPhone);
  const clean = isTargetBsuid ? toPhone.trim() : cleanPhone(toPhone);
  if (!phoneId || !accessToken || !clean || !audioUrl) {
    console.warn("sendMetaWhatsAppAudioMessage: missing required parameter", {
      phoneId: Boolean(phoneId),
      accessToken: Boolean(accessToken),
      toPhone: Boolean(clean),
      audioUrl: Boolean(audioUrl),
    });
    return null;
  }

  const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;
  const isOgg = audioUrl.toLowerCase().includes(".ogg");
  const audioPayload: any = { link: audioUrl };
  if (isOgg) {
    audioPayload.voice = true;
  }

  const payload: any = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    type: "audio",
    audio: audioPayload,
  };

  if (isTargetBsuid) {
    payload.recipient = clean;
  } else {
    payload.to = clean;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error("Meta Graph API audio error:", data);
    throw new Error(data?.error?.message || "Failed to send WhatsApp audio message via Meta API");
  }
  return data;
}

// Send a WhatsApp template message via Meta Graph API
async function sendMetaWhatsAppTemplate(
  phoneId: string,
  accessToken: string,
  toPhone: string,
  templateName: string,
  languageCode: string = "ar",
  components?: any[]
) {
  const isTargetBsuid = isBsuid(toPhone);
  const clean = isTargetBsuid ? toPhone.trim() : cleanPhone(toPhone);
  if (!phoneId || !accessToken || !clean || !templateName) {
    console.warn("sendMetaWhatsAppTemplate: missing required parameter", {
      phoneId: Boolean(phoneId),
      accessToken: Boolean(accessToken),
      toPhone: Boolean(clean),
      templateName: Boolean(templateName),
    });
    return null;
  }

  const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;
  const templateObj: any = {
    name: templateName,
    language: {
      code: languageCode || "ar",
    },
  };

  if (Array.isArray(components) && components.length > 0) {
    templateObj.components = components;
  }

  const payload: any = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    type: "template",
    template: templateObj,
  };

  if (isTargetBsuid) {
    payload.recipient = clean;
  } else {
    payload.to = clean;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error("Meta Graph API template error:", data);
    throw new Error(data?.error?.message || "Failed to send WhatsApp template via Meta API");
  }
  return data;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk as any);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const clean = base64.replace(/^data:[a-zA-Z0-9_\-\.\/]+;base64,/, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

interface ProcessedMediaResult {
  publicUrl: string | null;
  mimeType?: string;
  base64?: string;
}

// Download media from Meta Graph API and upload to Supabase Storage whatsapp-media bucket
async function processIncomingMedia(
  supabase: any,
  mediaId: string,
  accessToken: string,
  conversationId: string,
  suggestedFilename: string,
  includeBase64 = false
): Promise<ProcessedMediaResult> {
  try {
    if (!mediaId || !accessToken) return { publicUrl: null };

    // 1. Get media URL
    const metaMediaRes = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
      headers: { "Authorization": `Bearer ${accessToken}` },
    });
    if (!metaMediaRes.ok) return { publicUrl: null };
    const mediaMeta = await metaMediaRes.json();
    const directUrl = mediaMeta?.url;
    if (!directUrl) return { publicUrl: null };

    // 2. Download media binary
    const fileRes = await fetch(directUrl, {
      headers: { "Authorization": `Bearer ${accessToken}` },
    });
    if (!fileRes.ok) return { publicUrl: null };
    const arrayBuffer = await fileRes.arrayBuffer();

    // 3. Upload to Supabase Storage
    const ext = suggestedFilename.includes(".") ? suggestedFilename.split(".").pop() : "jpg";
    const storagePath = `conv_${conversationId}/${Date.now()}_${mediaId}.${ext}`;

    const contentType = mediaMeta.mime_type || (ext === "ogg" ? "audio/ogg" : "image/jpeg");

    const { error: uploadError } = await supabase.storage
      .from("whatsapp-media")
      .upload(storagePath, arrayBuffer, {
        contentType,
        upsert: true,
      });

    if (uploadError) {
      console.warn("Storage upload error:", uploadError);
      return { publicUrl: null };
    }

    const { data: publicUrlData } = supabase.storage
      .from("whatsapp-media")
      .getPublicUrl(storagePath);

    const publicUrl = publicUrlData?.publicUrl || null;
    const base64 = includeBase64 ? arrayBufferToBase64(arrayBuffer) : undefined;

    return { publicUrl, mimeType: contentType, base64 };
  } catch (err) {
    console.error("processIncomingMedia error:", err);
    return { publicUrl: null };
  }
}

const WEEKDAY_NAMES_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_NAMES_AR = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

// Parse any UTC ISO date string into clinic local parts (YYYY-MM-DD, HH:mm, minutesOfDay, dayOfWeek)
function parseLocalAppointmentTime(
  isoStr: string,
  timeZone: string = "Africa/Cairo"
): { dateStr: string; timeStr: string; startMin: number; dayOfWeek: number } {
  const date = new Date(isoStr);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });

  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      parts[part.type] = part.value;
    }
  }

  let hour = parts.hour || "00";
  if (hour === "24") hour = "00";
  const minute = parts.minute || "00";
  const year = parts.year || "";
  const month = parts.month || "";
  const day = parts.day || "";

  const dateStr = `${year}-${month}-${day}`;
  const timeStr = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  const startMin = parseInt(hour, 10) * 60 + parseInt(minute, 10);

  const shortDays: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const dayOfWeek = shortDays[parts.weekday] ?? date.getUTCDay();

  return { dateStr, timeStr, startMin, dayOfWeek };
}

// Losslessly convert local clinic date & time to exact UTC ISO string for DB storage
function localDateTimeToUtcIso(
  dateStr: string,
  timeStr: string,
  timeZone: string = "Africa/Cairo"
): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  let utcMs = Date.UTC(y, m - 1, d, hh, mm, 0);

  for (let i = 0; i < 3; i++) {
    const parsed = parseLocalAppointmentTime(new Date(utcMs).toISOString(), timeZone);
    const [pY, pM, pD] = parsed.dateStr.split("-").map(Number);
    const [pH, pMin] = parsed.timeStr.split(":").map(Number);

    const formattedUtcMs = Date.UTC(pY, pM - 1, pD, pH, pMin, 0);
    const desiredUtcMs = Date.UTC(y, m - 1, d, hh, mm, 0);
    const diff = formattedUtcMs - desiredUtcMs;
    if (diff === 0) break;
    utcMs -= diff;
  }
  return new Date(utcMs).toISOString();
}

// Get current date, time, and day of week in clinic local timezone
function getClinicNow(timeZone: string = "Africa/Cairo") {
  const now = new Date();
  const { dateStr, timeStr, startMin, dayOfWeek } = parseLocalAppointmentTime(now.toISOString(), timeZone);
  const dayEn = WEEKDAY_NAMES_EN[dayOfWeek];
  const dayAr = WEEKDAY_NAMES_AR[dayOfWeek];
  return {
    dateStr,
    timeStr,
    minutesOfDay: startMin,
    dayOfWeek,
    dayEn,
    dayAr,
    display: `${dateStr} (${dayEn} / ${dayAr})`,
  };
}

// Send OneSignal push notification to all subscribed clinic staff and doctors
async function sendAppointmentPushNotification(
  supabase: any,
  params: {
    appointmentId: string;
    patientName: string;
    doctorName: string;
    date: string;
    time: string;
    visitType: string;
    assignedUserId?: string | null;
    dayAr?: string;
    dayEn?: string;
  }
): Promise<any> {
  const appId = "1796b727-661f-43cb-9770-1b3938e4db8c";
  let apiKey = (Deno.env.get("ONESIGNAL_REST_API_KEY") || "").trim();

  if (!apiKey && supabase) {
    try {
      const { data } = await supabase
        .from("clinic_settings")
        .select("onesignal_rest_api_key")
        .eq("id", 1)
        .maybeSingle();
      if (data?.onesignal_rest_api_key) {
        apiKey = String(data.onesignal_rest_api_key).trim();
      }
    } catch (e) {
      console.warn("Could not load onesignal_rest_api_key from clinic_settings:", e);
    }
  }

  if (!apiKey) {
    console.warn("sendAppointmentPushNotification: No OneSignal API key found.");
    return null;
  }

  const {
    appointmentId,
    patientName,
    doctorName,
    date,
    time,
    visitType,
    assignedUserId,
    dayAr = "",
    dayEn = "",
  } = params;

  if (!assignedUserId) {
    console.log("sendAppointmentPushNotification: No assigned doctor user ID. Skipping notification to avoid broadcasting to all users.");
    return null;
  }

  const titleAr = "موعد جديد عبر واتساب 🦷";
  const titleEn = "New WhatsApp Appointment 🦷";

  const dateDisplayAr = dayAr ? `${dayAr} (${date})` : date;
  const dateDisplayEn = dayEn ? `${dayEn} (${date})` : date;

  const bodyAr = `تم حجز موعد جديد عبر واتساب للمريض ${patientName} معك (${doctorName}) يوم ${dateDisplayAr} الساعة ${time} (${visitType}).`;
  const bodyEn = `New appointment booked via WhatsApp for ${patientName} with you (${doctorName}) on ${dateDisplayEn} at ${time} (${visitType}).`;

  const payload: Record<string, unknown> = {
    app_id: appId,
    include_external_user_ids: [assignedUserId],
    channel_for_external_user_ids: "push",
    headings: {
      ar: titleAr,
      en: titleEn,
    },
    contents: {
      ar: bodyAr,
      en: bodyEn,
    },
    data: {
      view: "appointments",
      appointment_id: appointmentId,
      source: "whatsapp_ai",
      assigned_user_id: assignedUserId,
      date,
      time,
      patient_name: patientName,
      doctor_name: doctorName,
      visit_type: visitType,
    },
    url: "https://lumin.pages.dev/?view=appointments",
    priority: 10,
    ttl: 86400,
  };

  try {
    const res = await fetch("https://api.onesignal.com/notifications", {
      method: "POST",
      headers: {
        "Authorization": `Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const result = await res.json();
    if (!res.ok) {
      console.warn("OneSignal push notification error:", result);
    } else {
      console.log(`OneSignal push notification sent to assigned doctor [${assignedUserId}]:`, result?.id);
    }
    return result;
  } catch (err) {
    console.error("sendAppointmentPushNotification failed:", err);
    return null;
  }
}

// Send OneSignal push notification for incoming WhatsApp messages to subscribed user types
async function sendIncomingWhatsAppPushNotification(
  supabase: any,
  params: {
    conversationId: string;
    patientName: string;
    phone: string;
    messageContent: string;
    messageType: string;
  }
): Promise<any> {
  const appId = "1796b727-661f-43cb-9770-1b3938e4db8c";
  let apiKey = (Deno.env.get("ONESIGNAL_REST_API_KEY") || "").trim();

  if (!apiKey && supabase) {
    try {
      const { data } = await supabase
        .from("clinic_settings")
        .select("onesignal_rest_api_key")
        .eq("id", 1)
        .maybeSingle();
      if (data?.onesignal_rest_api_key) {
        apiKey = String(data.onesignal_rest_api_key).trim();
      }
    } catch (_) {}
  }

  if (!apiKey) return null;

  // Find all active user IDs whose user type / role has whatsapp_notifications enabled
  const { data: users, error: usersErr } = await supabase
    .from("user_profiles")
    .select(`
      user_id,
      access_roles(id, whatsapp_notifications, role_permissions(page_key, can_view))
    `)
    .eq("active", true);

  if (usersErr || !users || users.length === 0) return null;

  const recipientUserIds: string[] = users
    .filter((u: any) => {
      const role = u.access_roles;
      if (!role) return false;
      if (role.whatsapp_notifications === true) return true;
      const hasPerm = Array.isArray(role.role_permissions) && role.role_permissions.some(
        (p: any) => p.page_key === "whatsapp_notifications" && p.can_view === true
      );
      return hasPerm;
    })
    .map((u: any) => u.user_id);

  if (recipientUserIds.length === 0) {
    return null;
  }

  const { conversationId, patientName, phone, messageContent, messageType } = params;

  const preview = messageType === "audio"
    ? "🎤 رسالة صوتية (Voice Note)"
    : messageType === "image"
    ? "📷 صورة (Photo)"
    : messageType === "document"
    ? "📄 مستند (Document)"
    : (messageContent || "").slice(0, 100);

  const payload: Record<string, unknown> = {
    app_id: appId,
    include_external_user_ids: recipientUserIds,
    channel_for_external_user_ids: "push",
    headings: {
      ar: `رسالة واتساب من ${patientName} 💬`,
      en: `WhatsApp message from ${patientName} 💬`,
    },
    contents: {
      ar: preview,
      en: preview,
    },
    data: {
      view: "whatsapp",
      conversation_id: conversationId,
      phone,
      patient_name: patientName,
    },
    url: `https://lumin.pages.dev/?view=whatsapp&conversation_id=${conversationId}`,
    priority: 10,
    ttl: 86400,
  };

  try {
    const res = await fetch("https://api.onesignal.com/notifications", {
      method: "POST",
      headers: {
        "Authorization": `Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const result = await res.json();
    if (!res.ok) {
      console.warn("OneSignal incoming WhatsApp push error:", result);
    } else {
      console.log(`OneSignal incoming WhatsApp push sent to ${recipientUserIds.length} user(s):`, result?.id);
    }
    return result;
  } catch (err) {
    console.error("sendIncomingWhatsAppPushNotification failed:", err);
    return null;
  }
}

function formatDoctorScheduleForPrompt(fullName: string, sched: any): string {
  const days: number[] = Array.isArray(sched?.days)
    ? sched.days.map(Number).filter((d: number) => d >= 0 && d <= 6).sort()
    : [0, 1, 2, 3, 4];
  if (!days.length) return `- Dr. ${fullName}: No scheduled clinic shifts`;

  const legacyStart = sched?.start || "09:00";
  const legacyEnd = sched?.end || "17:00";
  const daily = (sched?.daily && typeof sched.daily === "object") ? sched.daily : {};

  const shifts = days.map((d: number) => {
    const daySched = daily[String(d)] || { start: legacyStart, end: legacyEnd };
    return `${WEEKDAY_NAMES_AR[d]} / ${WEEKDAY_NAMES_EN[d]} (${daySched.start} - ${daySched.end})`;
  });

  return `- Dr. ${fullName}:\n  * ` + shifts.join("\n  * ");
}

// Gemini Tools Schema Builder (Dynamically populated with active clinic doctors and services)
function buildGeminiTools(doctorNames: string[] = [], visitTypeNames: string[] = []) {
  const docExamples = doctorNames.length > 0 ? doctorNames.slice(0, 5).join(", ") : "Mohamed Gazzar, Salma, Mariam";
  const vtExamples = visitTypeNames.length > 0 ? visitTypeNames.slice(0, 8).join(", ") : "Check-up, Cleaning, Consultation, Extraction";

  return [
    {
      functionDeclarations: [
        {
          name: "check_available_slots",
          description: "Check available appointment slots for a given date according to doctors' actual working days, shift hours, and already booked appointments.",
          parameters: {
            type: "OBJECT",
            properties: {
              date: {
                type: "STRING",
                description: "Date in YYYY-MM-DD format (e.g. 2026-09-20)",
              },
              doctor_name: {
                type: "STRING",
                description: `Optional preferred doctor name (e.g. ${docExamples})`,
              },
            },
            required: ["date"],
          },
        },
        {
          name: "book_appointment",
          description: "Book an appointment for a patient in the clinic calendar. ONLY call this tool after verifying that the requested slot is present in available_slots and NOT in occupied_slots.",
          parameters: {
            type: "OBJECT",
            properties: {
              patient_name: {
                type: "STRING",
                description: "Full name of the patient",
              },
              date: {
                type: "STRING",
                description: "Date in YYYY-MM-DD format",
              },
              time: {
                type: "STRING",
                description: "Time in 24-hour HH:mm format (e.g. 11:00, 16:30)",
              },
              doctor_name: {
                type: "STRING",
                description: `Doctor name if specified by patient (e.g. ${docExamples})`,
              },
              visit_type: {
                type: "STRING",
                description: `Type of visit / service (e.g. ${vtExamples})`,
              },
              notes: {
                type: "STRING",
                description: "Any extra notes or symptoms provided by the patient",
              },
            },
            required: ["patient_name", "date", "time"],
          },
        },
        {
          name: "request_human_support",
          description: "Call this when the patient has a complex medical question, complains about an emergency, or explicitly requests to speak with a human receptionist/doctor.",
          parameters: {
            type: "OBJECT",
            properties: {
              reason: {
                type: "STRING",
                description: "Short reason why human intervention is required",
              },
            },
            required: ["reason"],
          },
        },
      ],
    },
  ];
}

// Execute tool calls against Supabase DB
async function handleGeminiToolCall(
  supabase: any,
  call: { name: string; args: any },
  conversation: any,
  timeZone: string = "Africa/Cairo"
): Promise<any> {
  const { name, args } = call;

  if (name === "check_available_slots") {
    const targetDate = String(args.date || "").trim();
    if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      return {
        available: false,
        error: "Invalid date format. Please provide YYYY-MM-DD.",
        available_slots: [],
        occupied_slots: [],
      };
    }

    // Target day of week: 0 = Sun, 1 = Mon, ..., 6 = Sat
    // Noon UTC guarantees correct calendar day in all timezones
    const targetDayOfWeek = new Date(`${targetDate}T12:00:00Z`).getUTCDay();
    const dayEn = WEEKDAY_NAMES_EN[targetDayOfWeek];
    const dayAr = WEEKDAY_NAMES_AR[targetDayOfWeek];
    const clinicNow = getClinicNow(timeZone);

    // Fetch active doctors and their HR staff settings (weekly_schedule) in parallel
    const [{ data: activeDoctors }, { data: staffSettings }] = await Promise.all([
      supabase
        .from("user_profiles")
        .select("user_id, full_name")
        .eq("is_doctor", true)
        .eq("active", true),
      supabase
        .from("hr_staff_settings")
        .select("user_id, weekly_schedule"),
    ]);

    const settingsMap = new Map((staffSettings || []).map((s: any) => [s.user_id, s.weekly_schedule]));

    const doctorList = (activeDoctors || []).map((doc: any) => {
      const sched = settingsMap.get(doc.user_id) || {};
      const days: number[] = Array.isArray(sched.days)
        ? sched.days.map(Number).filter((d: number) => d >= 0 && d <= 6).sort()
        : [0, 1, 2, 3, 4];
      const daily = (sched.daily && typeof sched.daily === "object") ? sched.daily : {};
      return {
        userId: doc.user_id,
        fullName: doc.full_name,
        days,
        daily,
        start: sched.start || "09:00",
        end: sched.end || "17:00",
      };
    });

    let selectedDoctor: any = null;
    if (args.doctor_name) {
      const search = String(args.doctor_name).toLowerCase().replace(/^dr\.?\s*/i, "").trim();
      selectedDoctor = doctorList.find((d: any) => d.fullName.toLowerCase().includes(search));

      if (selectedDoctor) {
        // If doctor is not scheduled to work on requested day
        if (!selectedDoctor.days.includes(targetDayOfWeek)) {
          const workingDaysAr = selectedDoctor.days.map((d: number) => WEEKDAY_NAMES_AR[d]).join(" و ");
          const workingDaysEn = selectedDoctor.days.map((d: number) => WEEKDAY_NAMES_EN[d]).join(", ");
          return {
            available: false,
            date: targetDate,
            day: `${dayAr} / ${dayEn}`,
            doctor: `Dr. ${selectedDoctor.fullName}`,
            message: `د. ${selectedDoctor.fullName} لا يعمل يوم ${dayAr} (${dayEn}). مواعيد عمله في العيادة هي: ${workingDaysAr} (${workingDaysEn}). هل ترغب بالحجز في أحد هذه الأيام، أو الحجز مع طبيب آخر متاح في العيادة يوم ${dayAr}؟`,
            working_days: workingDaysAr,
            available_slots: [],
            occupied_slots: [],
          };
        }
      }
    }

    // Doctors working on target day
    const workingDoctors = selectedDoctor
      ? [selectedDoctor]
      : doctorList.filter((d: any) => d.days.includes(targetDayOfWeek));

    if (workingDoctors.length === 0) {
      return {
        available: false,
        date: targetDate,
        day: `${dayAr} / ${dayEn}`,
        message: `العيادة لا يتوفر بها أطباء مناوبون يوم ${dayAr} (${dayEn}). يرجى اختيار يوم آخر من أيام العمل المتاحة.`,
        available_slots: [],
        occupied_slots: [],
      };
    }

    // Generate candidate 30-min slots from working doctors
    const candidateSlotsSet = new Set<string>();
    for (const doc of workingDoctors) {
      const daySched = doc.daily[String(targetDayOfWeek)] || { start: doc.start, end: doc.end };
      const [sh, sm] = (daySched.start || "09:00").split(":").map(Number);
      const [eh, em] = (daySched.end || "17:00").split(":").map(Number);
      let m = sh * 60 + sm;
      const endM = eh * 60 + em;
      while (m + 30 <= endM) {
        const hh = String(Math.floor(m / 60)).padStart(2, "0");
        const mm = String(m % 60).padStart(2, "0");
        candidateSlotsSet.add(`${hh}:${mm}`);
        m += 30;
      }
    }

    const allCandidateSlots = Array.from(candidateSlotsSet).sort();

    // Query booked appointments for target date across a wide UTC window
    const queryStartUtc = new Date(Date.parse(`${targetDate}T00:00:00Z`) - 24 * 3600 * 1000).toISOString();
    const queryEndUtc = new Date(Date.parse(`${targetDate}T23:59:59Z`) + 24 * 3600 * 1000).toISOString();

    let aptQuery = supabase
      .from("appointments")
      .select("id, appointment_at, duration_minutes, status, assigned_user_id, appointment_type")
      .gte("appointment_at", queryStartUtc)
      .lte("appointment_at", queryEndUtc)
      .neq("status", "Cancelled");

    if (selectedDoctor) {
      aptQuery = aptQuery.eq("assigned_user_id", selectedDoctor.userId);
    }

    const { data: rawBookedAppointments } = await aptQuery;

    // Convert raw booked appointments to local clinic day minutes
    const bookedAppointments = (rawBookedAppointments || [])
      .map((apt: any) => {
        const local = parseLocalAppointmentTime(apt.appointment_at, timeZone);
        if (local.dateStr !== targetDate) return null;
        const duration = Number(apt.duration_minutes) || 30;
        return {
          assigned_user_id: apt.assigned_user_id,
          startMin: local.startMin,
          endMin: local.startMin + duration,
          timeStr: local.timeStr,
        };
      })
      .filter(Boolean);

    // Calculate available and occupied slots
    const availableSlots: string[] = [];
    const occupiedSlots: string[] = [];
    const isToday = targetDate === clinicNow.dateStr;

    for (const slot of allCandidateSlots) {
      const [h, min] = slot.split(":").map(Number);
      const slotStartMin = h * 60 + min;
      const slotEndMin = slotStartMin + 30;

      // Filter out past slots if requested for today (allow at least 15 min buffer)
      if (isToday && slotStartMin <= (clinicNow.minutesOfDay + 15)) {
        continue;
      }

      // Find doctors scheduled to work during this specific slot
      const docsAtThisSlot = workingDoctors.filter((doc: any) => {
        const daySched = doc.daily[String(targetDayOfWeek)] || { start: doc.start, end: doc.end };
        const [sh, sm] = (daySched.start || "09:00").split(":").map(Number);
        const [eh, em] = (daySched.end || "17:00").split(":").map(Number);
        return slotStartMin >= (sh * 60 + sm) && slotEndMin <= (eh * 60 + em);
      });

      if (docsAtThisSlot.length === 0) continue;

      // Check if at least one doctor has no overlapping appointment at this slot
      const hasFreeDoctor = docsAtThisSlot.some((doc: any) => {
        const docApts = bookedAppointments.filter((apt: any) => apt.assigned_user_id === doc.userId);
        const isConflict = docApts.some((apt: any) => slotStartMin < apt.endMin && slotEndMin > apt.startMin);
        return !isConflict;
      });

      if (hasFreeDoctor) {
        availableSlots.push(slot);
      } else {
        occupiedSlots.push(slot);
      }
    }

    const morningSlots = availableSlots.filter((s) => parseInt(s.split(":")[0], 10) < 14);
    const eveningSlots = availableSlots.filter((s) => parseInt(s.split(":")[0], 10) >= 14);

    return {
      available: availableSlots.length > 0,
      date: targetDate,
      day: `${dayAr} / ${dayEn}`,
      doctor: selectedDoctor ? `Dr. ${selectedDoctor.fullName}` : "All Available Doctors",
      morning_slots: morningSlots.slice(0, 5),
      evening_slots: eveningSlots.slice(0, 8),
      available_slots: availableSlots,
      occupied_slots: occupiedSlots,
      total_free: availableSlots.length,
      total_occupied: occupiedSlots.length,
      rules_and_warnings: occupiedSlots.length > 0
        ? `IMPORTANT: The following slots are OCCUPIED/ALREADY BOOKED: ${occupiedSlots.join(", ")}. NEVER offer or book any occupied slot. If the patient requested an occupied slot, tell them it is taken and propose alternative slots from available_slots.`
        : "All scheduled slots on this date are currently available.",
    };
  }

  if (name === "book_appointment") {
    const { patient_name, date, time, doctor_name, visit_type, notes } = args;
    const appointmentAtIso = localDateTimeToUtcIso(date, time, timeZone);
    const reqStartMs = Date.parse(appointmentAtIso);
    const reqEndMs = reqStartMs + 30 * 60 * 1000;

    // 1. Find or create patient
    let patientId = conversation.patient_id;
    if (!patientId) {
      let existingPatient = null;
      if (!isBsuid(conversation.phone) && conversation.phone) {
        const tail = getPhoneTail(conversation.phone);
        const { data } = await supabase
          .from("patients")
          .select("id, name")
          .or(`phone.eq.${conversation.phone},phone.ilike.%${tail}`)
          .maybeSingle();
        existingPatient = data;
      }

      if (existingPatient) {
        patientId = existingPatient.id;
      } else {
        const nameParts = (patient_name || conversation.patient_name || "WhatsApp Patient").trim().split(" ");
        const firstName = nameParts[0] || "Patient";
        const lastName = nameParts.slice(1).join(" ") || "";
        const { data: newPatient } = await supabase
          .from("patients")
          .insert({
            name: patient_name || conversation.patient_name,
            first_name: firstName,
            last_name: lastName,
            phone: isBsuid(conversation.phone) ? "" : conversation.phone,
          })
          .select("id")
          .single();
        patientId = newPatient?.id;
      }

      if (patientId) {
        await supabase
          .from("whatsapp_conversations")
          .update({ patient_id: patientId, patient_name: patient_name || conversation.patient_name })
          .eq("id", conversation.id);
      }
    }

    // 2. Find doctor if specified or resolve to working doctor
    let assignedUserId = null;
    let confirmedDoctorName = "General Clinic";
    if (doctor_name) {
      const cleanDocName = String(doctor_name)
        .replace(/^(dr\.?|د\.?|دكتور|دكتورة)\s+/i, "")
        .trim();
      const { data: doctorUser } = await supabase
        .from("user_profiles")
        .select("user_id, full_name")
        .eq("is_doctor", true)
        .or(`full_name.ilike.%${cleanDocName}%,full_name.ilike.%${doctor_name}%`)
        .maybeSingle();
      if (doctorUser) {
        assignedUserId = doctorUser.user_id;
        confirmedDoctorName = `Dr. ${doctorUser.full_name}`;
      }
    }

    // If doctor not specified or not matched, automatically resolve to active doctor scheduled to work at this time
    if (!assignedUserId) {
      const [{ data: activeDocs }, { data: staffSettings }] = await Promise.all([
        supabase
          .from("user_profiles")
          .select("user_id, full_name")
          .eq("is_doctor", true)
          .eq("active", true),
        supabase
          .from("hr_staff_settings")
          .select("user_id, weekly_schedule"),
      ]);

      const settingsMap = new Map((staffSettings || []).map((s: any) => [s.user_id, s.weekly_schedule]));
      const dayOfWeek = new Date(`${date}T12:00:00Z`).getUTCDay();
      const [th, tm] = time.split(":").map(Number);
      const reqMin = th * 60 + tm;

      for (const doc of (activeDocs || [])) {
        const sched = settingsMap.get(doc.user_id) || {};
        const days: number[] = Array.isArray(sched.days) ? sched.days.map(Number) : [0, 1, 2, 3, 4];
        if (!days.includes(dayOfWeek)) continue;
        const daily = (sched.daily && typeof sched.daily === "object") ? sched.daily : {};
        const daySched = daily[String(dayOfWeek)] || { start: sched.start || "09:00", end: sched.end || "17:00" };
        const [sh, sm] = (daySched.start || "09:00").split(":").map(Number);
        const [eh, em] = (daySched.end || "17:00").split(":").map(Number);
        if (reqMin >= (sh * 60 + sm) && (reqMin + 30) <= (eh * 60 + em)) {
          const checkStartIso = new Date(reqStartMs - 4 * 3600 * 1000).toISOString();
          const checkEndIso = new Date(reqEndMs + 4 * 3600 * 1000).toISOString();
          const { data: conflicts } = await supabase
            .from("appointments")
            .select("id, appointment_at, duration_minutes, status")
            .eq("assigned_user_id", doc.user_id)
            .neq("status", "Cancelled")
            .gte("appointment_at", checkStartIso)
            .lte("appointment_at", checkEndIso);

          const hasConflict = (conflicts || []).some((apt: any) => {
            const aStart = Date.parse(apt.appointment_at);
            const aEnd = aStart + (Number(apt.duration_minutes) || 30) * 60 * 1000;
            return reqStartMs < aEnd && reqEndMs > aStart;
          });

          if (!hasConflict) {
            assignedUserId = doc.user_id;
            confirmedDoctorName = `Dr. ${doc.full_name}`;
            break;
          }
        }
      }
    }

    // 3. Collision guard: Ensure doctor doesn't already have an overlapping booking
    if (assignedUserId) {
      const checkStartIso = new Date(reqStartMs - 4 * 3600 * 1000).toISOString();
      const checkEndIso = new Date(reqEndMs + 4 * 3600 * 1000).toISOString();

      const { data: existingApts } = await supabase
        .from("appointments")
        .select("id, appointment_at, duration_minutes, status")
        .eq("assigned_user_id", assignedUserId)
        .neq("status", "Cancelled")
        .gte("appointment_at", checkStartIso)
        .lte("appointment_at", checkEndIso);

      const hasConflict = (existingApts || []).some((apt: any) => {
        const aStart = Date.parse(apt.appointment_at);
        const aEnd = aStart + (Number(apt.duration_minutes) || 30) * 60 * 1000;
        return reqStartMs < aEnd && reqEndMs > aStart;
      });

      if (hasConflict) {
        return {
          success: false,
          error: "SLOT_OCCUPIED",
          message: `عذراً، الموعد الساعة ${time} محجوز بالفعل مع ${confirmedDoctorName}. يرجى إبلاغ المريض واقتراح موعد آخر متاح من available_slots.`,
        };
      }
    }

    // 4. Find visit type if specified
    let visitTypeId = null;
    let confirmedVisitType = visit_type || "Check-up";
    if (visit_type) {
      const { data: vt } = await supabase
        .from("appointment_visit_types")
        .select("id, name")
        .ilike("name", `%${visit_type}%`)
        .maybeSingle();
      if (vt) {
        visitTypeId = vt.id;
        confirmedVisitType = vt.name;
      }
    }

    // 5. Create appointment
    const { data: apt, error: aptError } = await supabase
      .from("appointments")
      .insert({
        patient_id: patientId,
        appointment_at: appointmentAtIso,
        appointment_type: confirmedVisitType,
        visit_type_id: visitTypeId,
        assigned_user_id: assignedUserId,
        status: "Scheduled",
        notes: `Booked via WhatsApp AI Agent. ${notes || ""}`.trim(),
        duration_minutes: 30,
      })
      .select("id")
      .single();

    if (aptError) {
      console.error("Appointment creation error:", aptError);
      return { success: false, error: aptError.message };
    }

    // 6. Trigger OneSignal Push Notification to Clinic Staff & Doctors
    const aptDayOfWeek = new Date(`${date}T12:00:00Z`).getUTCDay();
    const aptDayAr = WEEKDAY_NAMES_AR[aptDayOfWeek] || "";
    const aptDayEn = WEEKDAY_NAMES_EN[aptDayOfWeek] || "";

    // Fire push notification asynchronously without blocking AI response
    sendAppointmentPushNotification(supabase, {
      appointmentId: apt.id,
      patientName: patient_name || conversation.patient_name || "Patient",
      doctorName: confirmedDoctorName,
      date,
      time,
      visitType: confirmedVisitType,
      assignedUserId,
      dayAr: aptDayAr,
      dayEn: aptDayEn,
    }).catch((pushErr) => {
      console.warn("sendAppointmentPushNotification error:", pushErr);
    });

    return {
      success: true,
      appointment_id: apt.id,
      patient_name: patient_name || conversation.patient_name,
      date,
      time,
      doctor: confirmedDoctorName,
      visit_type: confirmedVisitType,
      status: "Confirmed",
    };
  }

  if (name === "request_human_support") {
    const { reason } = args;
    await supabase
      .from("whatsapp_conversations")
      .update({
        ai_enabled: false,
        status: "human_needed",
      })
      .eq("id", conversation.id);

    return {
      success: true,
      message: "AI disabled. Conversation marked for human receptionist assistance.",
      reason,
    };
  }

  return { error: `Unknown tool: ${name}` };
}

// Call Google Gemini API with timeout and model-specific configs
async function callGeminiApi(
  model: string,
  apiKey: string,
  systemInstruction: string,
  contents: any[],
  tools: any[],
  timeoutMs = 45000
): Promise<any> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const generationConfig: any = {
      temperature: 0.3,
      maxOutputTokens: 600,
    };
    if (model.includes("3.8")) {
      generationConfig.thinkingConfig = { thinkingLevel: "low" };
    }

    const reqBody = {
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents,
      tools,
      generationConfig,
    };

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody),
      signal: controller.signal,
    });

    const data = await res.json();
    if (!res.ok) {
      console.error(`Gemini API error [${model}] (${res.status}):`, data);
      throw new Error(data?.error?.message || `Gemini API request failed with status ${res.status}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function runGeminiAgentWithModel(
  supabase: any,
  model: string,
  apiKey: string,
  systemInstruction: string,
  conversation: any,
  initialContents: any[],
  tools: any[],
  timeZone: string = "Africa/Cairo"
): Promise<string> {
  const contents = JSON.parse(JSON.stringify(initialContents));

  for (let turn = 0; turn < 3; turn++) {
    const data = await callGeminiApi(model, apiKey, systemInstruction, contents, tools, 45000);

    const candidate = data.candidates?.[0];
    const candidateContent = candidate?.content;
    const parts = candidateContent?.parts || [];
    const functionCalls = parts.filter((p: any) => p.functionCall);

    if (functionCalls.length > 0) {
      // Retain candidate.content exactly as returned by Gemini.
      // This preserves thoughtSignature and internal thought reasoning required for turn validation.
      contents.push(candidateContent);

      const functionResponses = [];
      for (const fcPart of functionCalls) {
        const call = fcPart.functionCall;
        console.log(`[${model}] Gemini tool call:`, call.name, call.args);

        const toolResult = await handleGeminiToolCall(supabase, call, conversation, timeZone);
        console.log(`[${model}] Tool result:`, toolResult);

        functionResponses.push({
          functionResponse: {
            name: call.name,
            response: toolResult,
          },
        });
      }

      contents.push({
        role: "user",
        parts: functionResponses,
      });
    } else {
      const textPart = parts.find((p: any) => p.text);
      return textPart?.text || "شكراً لتواصلك معنا. سنقوم بالرد عليك في أقرب وقت.";
    }
  }

  return "تم تسجيل طلبك وسيقوم فريق العيادة بالتواصل معك لتأكيد الموعد.";
}

// Call Google Gemini API with multi-turn tool calling and automatic fallback
async function runGeminiAgent(
  supabase: any,
  apiKey: string,
  customInstructions: string,
  conversation: any,
  conversationHistory: any[],
  preferredModel: string = "gemini-3.5-flash-lite",
  incomingAudioPart: any = null,
  timeZone: string = "Africa/Cairo"
): Promise<string> {
  const clinicNow = getClinicNow(timeZone);
  const todayStr = clinicNow.display;

  // 1. Dynamic Auto-Sync: Fetch active doctors, their working schedules, and visit types in parallel
  const [{ data: activeDoctors }, { data: activeVisitTypes }, { data: staffSettings }] = await Promise.all([
    supabase
      .from("user_profiles")
      .select("user_id, full_name")
      .eq("is_doctor", true)
      .eq("active", true)
      .order("full_name", { ascending: true }),
    supabase
      .from("appointment_visit_types")
      .select("id, name")
      .eq("active", true)
      .order("sort_order", { ascending: true }),
    supabase
      .from("hr_staff_settings")
      .select("user_id, weekly_schedule"),
  ]);

  const settingsMap = new Map((staffSettings || []).map((s: any) => [s.user_id, s.weekly_schedule]));

  const doctorNames: string[] = (activeDoctors && activeDoctors.length > 0)
    ? activeDoctors.map((d: any) => d.full_name)
    : ["Mohamed Gazzar", "Abdel Reheem Elsayed", "Mariam Soliman", "Salma El Sayed", "Mohamed Magdy"];

  const doctorScheduleLines: string[] = (activeDoctors || []).map((doc: any) => {
    return formatDoctorScheduleForPrompt(doc.full_name, settingsMap.get(doc.user_id));
  });
  const doctorsScheduleStr = doctorScheduleLines.join("\n");

  const visitTypeNames: string[] = (activeVisitTypes && activeVisitTypes.length > 0)
    ? activeVisitTypes.map((v: any) => v.name)
    : ["Cleaning", "Consultation", "Procedure", "Follow-up", "Endo", "Extraction", "Restoration", "Check-up", "Ortho"];

  const servicesListStr = visitTypeNames.join(", ");

  const dynamicTools = buildGeminiTools(doctorNames, visitTypeNames);

  const systemInstruction = `You are the polite, welcoming, and efficient AI receptionist for Lumin Dental Clinic (عيادة لومين لطب الأسنان).
Current clinic date & day of the week: ${todayStr}.
Current clinic local time: ${clinicNow.timeStr}.
When a patient asks about a specific day (such as "غداً" / tomorrow, "يوم الأربعاء" / Wednesday, etc.), accurately calculate the exact date based on today (${todayStr}). For example, if today is Monday, tomorrow is Tuesday, and the day after is Wednesday.
Clinic operating hours: Saturday to Thursday from 10:00 AM to 8:00 PM (10:00 to 20:00). Closed on Fridays.

Active Clinic Doctors & Live Working Schedules (Directly from Clinic HR Staff Settings):
${doctorsScheduleStr}

Rules for Doctor Schedules & Working Hours:
- Each doctor only accepts appointments on their scheduled days and during their shift hours listed above.
- If a patient asks for a doctor on a day they do NOT work, inform them politely of the doctor's exact working days, and suggest booking on one of their working days or seeing another doctor available on that day.

CRITICAL CALENDAR & OCCUPIED APPOINTMENTS RULES:
1. NEVER assume or guess slot availability. You MUST ALWAYS call \`check_available_slots\` before proposing or confirming any slot.
2. In the \`check_available_slots\` response, strictly observe \`available_slots\` and \`occupied_slots\`.
3. NEVER suggest, offer, or book any time listed in \`occupied_slots\` or absent from \`available_slots\`.
4. If a patient asks for an occupied or already-booked slot:
   - Explicitly tell the patient that this time is already booked / occupied (e.g. "عذراً، هذا الموعد محجوز مسبقاً" / "Sorry, this time slot is already booked").
   - Offer them the nearest vacant slots from \`available_slots\`.
5. ONLY call \`book_appointment\` for a slot that is confirmed present in \`available_slots\`.

Available Clinic Services & Visit Types (Live from clinic service catalog):
${servicesListStr}
Common Arabic translations:
- كشف / فحص / استشارة = Consultation / Check-up
- تنظيف وتلميع أسنان = Cleaning
- حشو تجميلي / عادي = Restoration
- علاج عصب وجذور = Endo
- خلع أسنان = Extraction
- تقويم أسنان = Ortho
- تركيبات وتيجان = Crown prep / Procedure
- متابعة = Follow-up

Rules:
1. Speak in the patient's language naturally (Arabic or English). If the patient speaks Arabic or Iraqi/Egyptian dialect, respond in warm, polite Arabic.
2. If the patient wants to book an appointment or asks about availability:
   - Always call \`check_available_slots\` with the calculated YYYY-MM-DD date to check real-time open slots (and provide doctor_name if the patient asked for a specific doctor).
   - Propose 3 to 5 convenient vacant slots (from available_slots) to the patient.
   - Ask for their full name if not already known.
   - When the patient agrees on a specific date and time, call \`book_appointment\` to save it to the system with the appropriate doctor and visit type.
   - Once booked, provide a clear, warm confirmation message summarizing the date, time, doctor, and service.
3. If the patient has severe medical emergencies, pain that requires immediate triage, or requests to speak to a person, call \`request_human_support\` and politely inform the patient that our clinic team will reply shortly.
4. Keep your responses concise, friendly, and formatted nicely for WhatsApp (use *bold* and bullet points sparingly). Do not use long markdown tables.
${isBsuid(conversation?.phone) ? "\n5. SPECIAL PATIENT NOTICE (MASKED WHATSAPP USERNAME): This patient is contacting via a masked WhatsApp Username (their phone number is protected). During the conversation, politely ask them to provide their mobile phone number so the clinic reception can confirm their reservation and contact them if needed." : ""}

${customInstructions ? `Additional clinic instructions & doctor shift rules: ${customInstructions}` : ""}`;

  // Build Gemini contents array from history, merging consecutive turns of the same role
  const initialContents: any[] = [];

  for (const msg of conversationHistory) {
    const role = msg.sender === "patient" ? "user" : "model";
    const text = String(msg.content || (msg.media_url ? "[Media Attachment]" : "")).trim();
    if (!text) continue;

    const last = initialContents[initialContents.length - 1];
    if (last && last.role === role) {
      last.parts.push({ text });
    } else {
      initialContents.push({
        role,
        parts: [{ text }],
      });
    }
  }

  // Ensure conversation ends with a user turn
  if (initialContents.length === 0 || initialContents[initialContents.length - 1].role !== "user") {
    initialContents.push({
      role: "user",
      parts: [{ text: "أهلاً بك، أود الاستفسار عن حجز موعد في العيادة." }],
    });
  }

  // If incoming message is an audio voice note, append audio inlineData to user parts
  if (incomingAudioPart) {
    const lastUser = initialContents[initialContents.length - 1];
    if (lastUser && lastUser.role === "user") {
      lastUser.parts.push(incomingAudioPart);
      lastUser.parts.push({
        text: "The patient sent a voice message above. Listen carefully to their spoken words (they may speak Arabic, Iraqi/Egyptian dialect, or English), extract their inquiry, doctor or date preference, and respond helpfully and warmly in their language.",
      });
    }
  }

  // Resilient multi-model fallback chain prioritizing multimodal audio understanding & fast models
  const modelsToTry = [
    preferredModel,
    "gemini-3.5-flash",
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite",
    "gemini-flash-lite-latest",
    "gemini-3-flash-preview",
    "gemini-3.6-flash",
  ].filter((v, i, a) => v && a.indexOf(v) === i);

  let lastError: any = null;
  for (const model of modelsToTry) {
    try {
      console.log(`Executing Gemini agent with model: ${model}`);
      return await runGeminiAgentWithModel(
        supabase,
        model,
        apiKey,
        systemInstruction,
        conversation,
        initialContents,
        dynamicTools,
        timeZone
      );
    } catch (err: any) {
      console.warn(`Model ${model} failed (attempting next in chain):`, err?.message || err);
      lastError = err;
    }
  }

  throw lastError || new Error("All configured Gemini models failed to generate response");
}

// Main Edge Function Handler
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = getSupabaseClient();
  const settings = await getClinicWhatsAppSettings(supabase);

  // 1. GET: Webhook Verification by Meta
  if (req.method === "GET") {
    const url = new URL(req.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === settings.verifyToken) {
      console.log("Meta webhook verified successfully!");
      return new Response(challenge, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    console.warn("Meta webhook verification failed: token mismatch", { expected: settings.verifyToken, received: token });
    return new Response("Forbidden", { status: 403 });
  }

  // 2. POST: Handle Events or Manual Outbound Send
  if (req.method === "POST") {
    try {
      const body = await req.json();

      // Case A: Staff Manual Outbound Message from Lumin Webapp
      if (body.action === "send_manual_message") {
        const {
          conversation_id,
          content,
          phone,
          patient_name,
          patient_id,
          message_type = "text",
          audio_base64,
          audio_mime_type,
          reply_to_id,
          reply_to_text,
          reply_to_sender,
        } = body;

        const isAudio = message_type === "audio" && Boolean(audio_base64);
        if ((!conversation_id && !phone) || (!content && !isAudio)) {
          return jsonResponse({ error: "conversation_id or phone, and content or audio_base64 are required" }, 400);
        }

        let conv: any = null;
        if (conversation_id) {
          const { data, error: convErr } = await supabase
            .from("whatsapp_conversations")
            .select("*")
            .eq("id", conversation_id)
            .single();

          if (convErr || !data) {
            return jsonResponse({ error: "Conversation not found" }, 404);
          }
          conv = data;
        } else if (phone) {
          const targetIsBsuid = isBsuid(phone);
          const clean = targetIsBsuid ? phone.trim() : cleanPhone(phone);
          const tail = getPhoneTail(clean);

          // Try to find existing conversation
          let query = supabase.from("whatsapp_conversations").select("*");
          if (targetIsBsuid) {
            query = query.eq("phone", clean);
          } else {
            query = query.or(`phone.eq.${clean},phone.ilike.%${tail}`);
          }
          const { data: existingConv } = await query.maybeSingle();

          if (existingConv) {
            conv = existingConv;
          } else {
            // Find or link patient if exists
            let linkedPatientId = patient_id || null;
            let linkedPatientName = patient_name || (targetIsBsuid ? "WhatsApp User" : `+${clean}`);
            if (!linkedPatientId && !targetIsBsuid) {
              const { data: p } = await supabase
                .from("patients")
                .select("id, name")
                .or(`phone.eq.${clean},phone.ilike.%${tail}`)
                .maybeSingle();
              if (p) {
                linkedPatientId = p.id;
                linkedPatientName = p.name || linkedPatientName;
              }
            }

            const { data: newConv, error: createConvErr } = await supabase
              .from("whatsapp_conversations")
              .insert({
                phone: clean,
                patient_id: linkedPatientId,
                patient_name: linkedPatientName,
                ai_enabled: true,
                last_message: content || (isAudio ? "🎤 Voice Message" : ""),
                last_message_at: new Date().toISOString(),
                unread_count: 0,
                status: "active",
              })
              .select()
              .single();

            if (createConvErr) throw createConvErr;
            conv = newConv;
          }
        }

        let metaSendResult = null;
        let mediaUrl: string | null = null;
        const finalContent = content || (isAudio ? "🎤 Voice Message" : "");

        let contextWamid: string | null = null;
        if (reply_to_id) {
          const { data: parentMsg } = await supabase
            .from("whatsapp_messages")
            .select("whatsapp_message_id")
            .eq("id", reply_to_id)
            .maybeSingle();
          if (parentMsg?.whatsapp_message_id) {
            contextWamid = parentMsg.whatsapp_message_id;
          }
        }

        if (isAudio) {
          const mime = audio_mime_type || "audio/mp4";
          let ext = "m4a";
          if (mime.includes("ogg")) ext = "ogg";
          else if (mime.includes("mp4") || mime.includes("m4a")) ext = "m4a";
          else if (mime.includes("webm")) ext = "webm";
          else if (mime.includes("mpeg") || mime.includes("mp3")) ext = "mp3";
          else if (mime.includes("aac")) ext = "aac";

          const audioBytes = base64ToUint8Array(audio_base64);
          const storagePath = `conv_${conv.id}/${Date.now()}_staff_voice.${ext}`;

          const { error: uploadErr } = await supabase.storage
            .from("whatsapp-media")
            .upload(storagePath, audioBytes, {
              contentType: mime,
              upsert: true,
            });

          if (uploadErr) {
            console.error("Failed to upload staff voice note to storage:", uploadErr);
            throw new Error(`Failed to upload audio to storage: ${uploadErr.message}`);
          }

          const { data: pUrlData } = supabase.storage
            .from("whatsapp-media")
            .getPublicUrl(storagePath);
          mediaUrl = pUrlData?.publicUrl || null;

          if (settings.phoneId && settings.accessToken && mediaUrl) {
            metaSendResult = await sendMetaWhatsAppAudioMessage(
              settings.phoneId,
              settings.accessToken,
              conv.phone,
              mediaUrl
            );
          }
        } else {
          if (settings.phoneId && settings.accessToken) {
            metaSendResult = await sendMetaWhatsAppMessage(
              settings.phoneId,
              settings.accessToken,
              conv.phone,
              content,
              contextWamid
            );
          }
        }

        const { data: newMsg, error: msgErr } = await supabase
          .from("whatsapp_messages")
          .insert({
            conversation_id: conv.id,
            sender: "staff",
            sender_name: "Clinic Staff",
            content: finalContent,
            message_type: isAudio ? "audio" : "text",
            media_url: mediaUrl,
            whatsapp_message_id: metaSendResult?.messages?.[0]?.id || null,
            status: metaSendResult ? "sent" : "recorded",
            reply_to_id: reply_to_id || null,
            reply_to_text: reply_to_text || null,
            reply_to_sender: reply_to_sender || null,
          })
          .select()
          .single();

        if (msgErr) throw msgErr;

        await supabase
          .from("whatsapp_conversations")
          .update({
            last_message: finalContent,
            last_message_at: new Date().toISOString(),
            unread_count: 0,
          })
          .eq("id", conv.id);

        return jsonResponse({ success: true, message: newMsg, conversation_id: conv.id, media_url: mediaUrl });
      }

      // Case A.2: Staff Emoji Reaction to a WhatsApp Message
      if (body.action === "send_reaction") {
        const { conversation_id, message_id, emoji } = body;
        if (!conversation_id || !message_id) {
          return jsonResponse({ error: "conversation_id and message_id are required" }, 400);
        }

        const { data: targetMsg, error: msgErr } = await supabase
          .from("whatsapp_messages")
          .select("id, whatsapp_message_id, conversation_id")
          .eq("id", message_id)
          .maybeSingle();

        if (msgErr || !targetMsg) {
          return jsonResponse({ error: "Message not found" }, 404);
        }

        const { data: conv } = await supabase
          .from("whatsapp_conversations")
          .select("phone")
          .eq("id", conversation_id)
          .maybeSingle();

        if (targetMsg.whatsapp_message_id && conv?.phone && settings.phoneId && settings.accessToken) {
          try {
            await sendMetaWhatsAppReaction(
              settings.phoneId,
              settings.accessToken,
              conv.phone,
              targetMsg.whatsapp_message_id,
              emoji || ""
            );
          } catch (metaErr: any) {
            console.warn("Failed to dispatch reaction to Meta API (proceeding with local DB update):", metaErr?.message || metaErr);
          }
        }

        const { data: updatedMsg, error: updateErr } = await supabase
          .from("whatsapp_messages")
          .update({ reaction: emoji || null })
          .eq("id", message_id)
          .select()
          .single();

        if (updateErr) throw updateErr;

        return jsonResponse({ success: true, message: updatedMsg, reaction: emoji || null });
      }

      // Case A.3: List Approved Meta WhatsApp Templates
      if (body.action === "list_templates") {
        if (!settings.wabaId || !settings.accessToken) {
          return jsonResponse({
            templates: [],
            error: "Missing WhatsApp Business Account ID (WABA ID) or Access Token in clinic settings",
          }, 400);
        }

        try {
          const url = `https://graph.facebook.com/v21.0/${settings.wabaId}/message_templates?fields=name,status,category,language,components&limit=100`;
          const res = await fetch(url, {
            headers: {
              "Authorization": `Bearer ${settings.accessToken}`,
            },
          });
          const data = await res.json();
          if (!res.ok) {
            console.error("Meta list_templates error:", data);
            return jsonResponse({
              templates: [],
              error: data?.error?.message || "Failed to fetch templates from Meta",
            }, res.status);
          }

          return jsonResponse({
            success: true,
            templates: data.data || [],
          });
        } catch (err: any) {
          console.error("Failed to list templates:", err);
          return jsonResponse({ templates: [], error: err.message || "Failed to list templates" }, 500);
        }
      }

      // Case A.4: Staff Send Meta Approved Template
      if (body.action === "send_template") {
        const {
          conversation_id,
          phone,
          patient_name,
          patient_id,
          template_name,
          language_code = "ar",
          components = [],
          rendered_text,
        } = body;

        if ((!conversation_id && !phone) || !template_name) {
          return jsonResponse({ error: "conversation_id or phone, and template_name are required" }, 400);
        }

        if (!settings.phoneId || !settings.accessToken) {
          return jsonResponse({ error: "WhatsApp credentials not configured in clinic settings" }, 400);
        }

        let conv: any = null;
        if (conversation_id) {
          const { data, error: convErr } = await supabase
            .from("whatsapp_conversations")
            .select("*")
            .eq("id", conversation_id)
            .maybeSingle();
          if (convErr) throw convErr;
          conv = data;
        }

        if (!conv && phone) {
          const targetIsBsuid = isBsuid(phone);
          const clean = targetIsBsuid ? phone.trim() : cleanPhone(phone);
          const tail = getPhoneTail(clean);
          let query = supabase.from("whatsapp_conversations").select("*");
          if (targetIsBsuid) {
            query = query.eq("phone", clean);
          } else {
            query = query.or(`phone.eq.${clean},phone.ilike.%${tail}`);
          }
          const { data: existingConv } = await query.maybeSingle();

          if (existingConv) {
            conv = existingConv;
          } else {
            let linkedPatientId = patient_id || null;
            let linkedPatientName = patient_name || (targetIsBsuid ? "WhatsApp User" : `+${clean}`);
            if (!linkedPatientId && !targetIsBsuid) {
              const { data: p } = await supabase
                .from("patients")
                .select("id, name")
                .or(`phone.eq.${clean},phone.ilike.%${tail}`)
                .maybeSingle();
              if (p) {
                linkedPatientId = p.id;
                linkedPatientName = p.name || linkedPatientName;
              }
            }

            const { data: newConv, error: createConvErr } = await supabase
              .from("whatsapp_conversations")
              .insert({
                phone: clean,
                patient_id: linkedPatientId,
                patient_name: linkedPatientName,
                ai_enabled: true,
                last_message: rendered_text || `📋 Template: ${template_name}`,
                last_message_at: new Date().toISOString(),
                unread_count: 0,
                status: "active",
              })
              .select()
              .single();

            if (createConvErr) throw createConvErr;
            conv = newConv;
          }
        }

        if (!conv) {
          return jsonResponse({ error: "Conversation not found" }, 404);
        }

        let metaResult = null;
        try {
          metaResult = await sendMetaWhatsAppTemplate(
            settings.phoneId,
            settings.accessToken,
            conv.phone,
            template_name,
            language_code,
            components
          );
        } catch (metaErr: any) {
          console.error("sendMetaWhatsAppTemplate error:", metaErr);
          let friendlyError = metaErr.message || "Failed to send WhatsApp template via Meta API";
          if (friendlyError.includes("131058") || friendlyError.toLowerCase().includes("hello world")) {
            friendlyError = "قالب 'hello_world' مخصص لأرقام الاختبار من Meta فقط ولا تسمح Meta بإرساله من رقم العيادة الحقيقي. يرجى اعتماد قالب العيادة الخاص.";
          }
          return jsonResponse({
            success: false,
            error: friendlyError,
            meta_error: metaErr.message
          }, 200);
        }

        const targetWamid = metaResult?.messages?.[0]?.id || null;
        const displayText = rendered_text || `📋 Template: ${template_name}`;

        const { data: newMsg, error: msgErr } = await supabase
          .from("whatsapp_messages")
          .insert({
            conversation_id: conv.id,
            sender: "staff",
            sender_name: "Clinic Staff",
            content: displayText,
            message_type: "template",
            status: targetWamid ? "sent" : "failed",
            whatsapp_message_id: targetWamid,
          })
          .select()
          .single();

        if (msgErr) throw msgErr;

        await supabase
          .from("whatsapp_conversations")
          .update({
            last_message: displayText,
            last_message_at: new Date().toISOString(),
            unread_count: 0,
          })
          .eq("id", conv.id);

        return jsonResponse({
          success: true,
          message: newMsg,
          conversation_id: conv.id,
          wamid: targetWamid,
        });
      }

      // Case B: Incoming Webhook Event from Meta
      if (body.object === "whatsapp_business_account" && Array.isArray(body.entry)) {
        for (const entry of body.entry) {
          const changes = entry.changes || [];
          for (const change of changes) {
            const value = change.value || {};

            // Status updates (delivered, read)
            if (Array.isArray(value.statuses)) {
              for (const st of value.statuses) {
                if (st.id && st.status) {
                  await supabase
                    .from("whatsapp_messages")
                    .update({ status: st.status })
                    .eq("whatsapp_message_id", st.id);
                }
              }
            }

            // Incoming messages
            if (Array.isArray(value.messages)) {
              for (const incoming of value.messages) {
                // Check if this is an emoji reaction from patient
                if (incoming.type === "reaction") {
                  const targetWamid = incoming.reaction?.message_id;
                  const emoji = incoming.reaction?.emoji || null;
                  if (targetWamid) {
                    await supabase
                      .from("whatsapp_messages")
                      .update({ reaction: emoji })
                      .eq("whatsapp_message_id", targetWamid);
                  }
                  continue;
                }

                const messageId = incoming.id;
                const contact = (value.contacts || []).find((c: any) => c.wa_id === incoming.from || (incoming.from && c.wa_id?.includes(incoming.from))) || value.contacts?.[0] || {};

                let resolvedIdentifier = "";
                if (isBsuid(incoming.from)) {
                  resolvedIdentifier = incoming.from.trim();
                } else if (isBsuid(incoming.user_id)) {
                  resolvedIdentifier = incoming.user_id.trim();
                } else if (isBsuid(contact.user_id)) {
                  resolvedIdentifier = contact.user_id.trim();
                } else if (isBsuid(contact.wa_id)) {
                  resolvedIdentifier = contact.wa_id.trim();
                } else {
                  const cleaned = cleanPhone(incoming.from || contact.wa_id);
                  if (cleaned) {
                    resolvedIdentifier = cleaned;
                  } else {
                    const fromWamid = extractIdentifierFromWamid(messageId);
                    if (fromWamid) {
                      resolvedIdentifier = fromWamid;
                    }
                  }
                }
                const fromPhone = resolvedIdentifier;
                const isMaskedProfile = isBsuid(fromPhone);
                const contactName = contact.profile?.name || (isMaskedProfile ? "WhatsApp User" : `+${fromPhone}`);

                let messageType = "text";
                let textContent = "";
                let mediaUrl: string | null = null;
                let currentAudioPart: any = null;

                // Check if incoming message is quoting/replying to an earlier message
                let replyToId: string | null = null;
                let replyToText: string | null = null;
                let replyToSender: string | null = null;

                if (incoming.context?.id) {
                  const { data: parentMsg } = await supabase
                    .from("whatsapp_messages")
                    .select("id, content, sender_name, sender")
                    .eq("whatsapp_message_id", incoming.context.id)
                    .maybeSingle();

                  if (parentMsg) {
                    replyToId = parentMsg.id;
                    replyToText = parentMsg.content ? parentMsg.content.slice(0, 200) : "";
                    replyToSender = parentMsg.sender_name || (parentMsg.sender === "patient" ? "Patient" : "Clinic Staff");
                  }
                }

                if (incoming.type === "text") {
                  messageType = "text";
                  textContent = incoming.text?.body || "";
                } else if (incoming.type === "image") {
                  messageType = "image";
                  textContent = incoming.image?.caption || "📷 Photo";
                  const mediaRes = await processIncomingMedia(
                    supabase,
                    incoming.image?.id,
                    settings.accessToken,
                    fromPhone,
                    "image.jpg"
                  );
                  mediaUrl = mediaRes.publicUrl;
                } else if (incoming.type === "document") {
                  messageType = "document";
                  textContent = incoming.document?.filename || "📄 Document";
                  const mediaRes = await processIncomingMedia(
                    supabase,
                    incoming.document?.id,
                    settings.accessToken,
                    fromPhone,
                    incoming.document?.filename || "document.pdf"
                  );
                  mediaUrl = mediaRes.publicUrl;
                } else if (incoming.type === "audio" || incoming.type === "voice") {
                  messageType = "audio";
                  textContent = "🎤 Voice Message";
                  const mediaRes = await processIncomingMedia(
                    supabase,
                    incoming.audio?.id || incoming.voice?.id,
                    settings.accessToken,
                    fromPhone,
                    "audio.ogg",
                    true // include base64 for Gemini
                  );
                  mediaUrl = mediaRes.publicUrl;
                  if (mediaRes.base64) {
                    const rawMime = (mediaRes.mimeType || "audio/ogg").split(";")[0].trim();
                    currentAudioPart = {
                      inlineData: {
                        mimeType: rawMime,
                        data: mediaRes.base64,
                      },
                    };
                  }
                } else {
                  messageType = "text";
                  textContent = `[${incoming.type || "message"}]`;
                }

                // 1. Find or create conversation in whatsapp_conversations
                let { data: conv } = await supabase
                  .from("whatsapp_conversations")
                  .select("*")
                  .eq("phone", fromPhone)
                  .maybeSingle();

                if (!conv) {
                  let patientName = contactName;
                  let patientId = null;

                  if (!isMaskedProfile && fromPhone) {
                    const tail = getPhoneTail(fromPhone);
                    const { data: patient } = await supabase
                      .from("patients")
                      .select("id, name")
                      .or(`phone.eq.${fromPhone},phone.ilike.%${tail}`)
                      .maybeSingle();

                    if (patient) {
                      patientName = patient.name || contactName;
                      patientId = patient.id || null;
                    }
                  }

                  const { data: newConv, error: insertConvErr } = await supabase
                    .from("whatsapp_conversations")
                    .insert({
                      phone: fromPhone,
                      patient_id: patientId,
                      patient_name: patientName,
                      ai_enabled: true,
                      last_message: textContent,
                      last_message_at: new Date().toISOString(),
                      unread_count: 1,
                      status: "active",
                    })
                    .select()
                    .single();

                  if (insertConvErr) {
                    console.error("Failed to insert conversation:", insertConvErr);
                    continue;
                  }
                  conv = newConv;
                } else {
                  const { data: updatedConv } = await supabase
                    .from("whatsapp_conversations")
                    .update({
                      last_message: textContent,
                      last_message_at: new Date().toISOString(),
                      unread_count: (conv.unread_count || 0) + 1,
                    })
                    .eq("id", conv.id)
                    .select()
                    .single();
                  if (updatedConv) conv = updatedConv;
                }

                // 2. Insert incoming message into whatsapp_messages
                const { error: msgInsertErr } = await supabase
                  .from("whatsapp_messages")
                  .insert({
                    conversation_id: conv.id,
                    sender: "patient",
                    sender_name: conv.patient_name,
                    content: textContent,
                    message_type: messageType,
                    media_url: mediaUrl,
                    whatsapp_message_id: messageId,
                    status: "received",
                    reply_to_id: replyToId,
                    reply_to_text: replyToText,
                    reply_to_sender: replyToSender,
                  });

                if (msgInsertErr) {
                  console.error("Failed to insert whatsapp message:", msgInsertErr);
                }

                // Dispatch push notification to users whose user type has WhatsApp incoming notifications enabled
                sendIncomingWhatsAppPushNotification(supabase, {
                  conversationId: conv.id,
                  patientName: conv.patient_name || contactName || "Patient",
                  phone: fromPhone,
                  messageContent: textContent,
                  messageType,
                }).catch((pushErr) => {
                  console.warn("sendIncomingWhatsAppPushNotification error:", pushErr);
                });

                // 3. Trigger AI Agent if enabled
                const isAiActive = settings.enabled && conv.ai_enabled && conv.status !== "human_needed" && settings.geminiApiKey;

                if (isAiActive) {
                  const aiTask = (async () => {
                    try {
                      const { data: rawHistory } = await supabase
                        .from("whatsapp_messages")
                        .select("sender, content, media_url")
                        .eq("conversation_id", conv.id)
                        .order("created_at", { ascending: false })
                        .limit(8);

                      const history = (rawHistory || [])
                        .reverse()
                        .filter((m: any) => !m.content?.includes("أهلاً بك في عيادة لومين لطب الأسنان! 🦷✨"));

                      const aiResponse = await runGeminiAgent(
                        supabase,
                        settings.geminiApiKey,
                        settings.aiInstructions,
                        conv,
                        history.length > 0 ? history : [{ sender: "patient", content: textContent }],
                        settings.aiModel || "gemini-3.5-flash-lite",
                        currentAudioPart,
                        settings.attendanceTimezone || "Africa/Cairo"
                      );

                      let metaAiSend = null;
                      if (settings.phoneId && settings.accessToken) {
                        try {
                          metaAiSend = await sendMetaWhatsAppMessage(
                            settings.phoneId,
                            settings.accessToken,
                            fromPhone,
                            aiResponse
                          );
                        } catch (sendErr) {
                          console.warn("sendMetaWhatsAppMessage outbound failed:", sendErr);
                        }
                      }

                      await supabase.from("whatsapp_messages").insert({
                        conversation_id: conv.id,
                        sender: "ai",
                        sender_name: "Lumin AI Agent",
                        content: aiResponse,
                        message_type: "text",
                        whatsapp_message_id: metaAiSend?.messages?.[0]?.id || null,
                        status: metaAiSend ? "sent" : "recorded",
                      });

                      await supabase
                        .from("whatsapp_conversations")
                        .update({
                          last_message: aiResponse,
                          last_message_at: new Date().toISOString(),
                        })
                        .eq("id", conv.id);
                    } catch (aiErr: any) {
                      console.error("AI Agent processing error:", aiErr);
                      try {
                        const fallbackMsg = "أهلاً بك في عيادة لومين لطب الأسنان! 🦷✨ تم استلام رسالتك بنجاح وسيقوم فريق الاستقبال بالتواصل معك والمتابعة في أقرب وقت.";
                        let metaFallbackSend = null;
                        if (settings.phoneId && settings.accessToken) {
                          try {
                            metaFallbackSend = await sendMetaWhatsAppMessage(
                              settings.phoneId,
                              settings.accessToken,
                              fromPhone,
                              fallbackMsg
                            );
                          } catch (fallbackSendErr) {
                            console.warn("sendMetaWhatsAppMessage fallback failed:", fallbackSendErr);
                          }
                        }
                        await supabase.from("whatsapp_messages").insert({
                          conversation_id: conv.id,
                          sender: "ai",
                          sender_name: "Lumin AI Agent",
                          content: fallbackMsg,
                          message_type: "text",
                          whatsapp_message_id: metaFallbackSend?.messages?.[0]?.id || null,
                          status: metaFallbackSend ? "sent" : "recorded",
                        });
                        await supabase
                          .from("whatsapp_conversations")
                          .update({
                            last_message: fallbackMsg,
                            last_message_at: new Date().toISOString(),
                          })
                          .eq("id", conv.id);
                      } catch (fallbackErr) {
                        console.error("Failed to store or send fallback message:", fallbackErr);
                      }
                    }
                  })();

                  if (typeof (globalThis as any).EdgeRuntime?.waitUntil === "function") {
                    (globalThis as any).EdgeRuntime.waitUntil(aiTask);
                  } else {
                    await aiTask;
                  }
                }
              }
            }
          }
        }

        return jsonResponse({ status: "success" });
      }

      return jsonResponse({ status: "ignored" });
    } catch (err: any) {
      console.error("Webhook processing error:", err);
      return jsonResponse({ error: err.message }, 500);
    }
  }

  return new Response("Method not allowed", { status: 405 });
});
