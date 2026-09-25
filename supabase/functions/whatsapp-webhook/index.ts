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

function compileWhatsAppAiInstructions(blocks: unknown, legacyInstructions: unknown): string {
  const compiledBlocks = (Array.isArray(blocks) ? blocks : [])
    .map((block: any, index: number) => {
      const title = String(block?.title || `Instruction ${index + 1}`).trim();
      const body = String(block?.body || "").trim();
      return body ? `### ${title}\n${body}` : "";
    })
    .filter(Boolean);

  return compiledBlocks.length
    ? compiledBlocks.join("\n\n")
    : String(legacyInstructions || "").trim();
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

// Find all patients registered with a given phone number (supports local/international format and duplicates)
async function findPatientsByPhone(supabase: any, rawPhone: string): Promise<any[]> {
  if (!rawPhone || isBsuid(rawPhone)) return [];
  const clean = cleanPhone(rawPhone);
  if (!clean || clean.length < 6) return [];
  const tail = getPhoneTail(clean);

  const orParts: string[] = [
    `phone.eq.${clean}`,
    `phone.eq.+${clean}`,
  ];

  if (clean.length > 9) {
    const last10 = clean.slice(-10);
    orParts.push(`phone.eq.${last10}`);
    orParts.push(`phone.eq.0${last10}`);
    orParts.push(`phone.eq.+${last10}`);
  }

  if (tail && tail.length >= 7) {
    orParts.push(`phone.ilike.%${tail}`);
  }

  const { data, error } = await supabase
    .from("patients")
    .select("id, name, first_name, last_name, phone, patient_number")
    .or(orParts.join(","))
    .order("created_at", { ascending: false });

  if (error) {
    console.warn("findPatientsByPhone error:", error.message || error);
    return [];
  }

  if (!Array.isArray(data)) return [];

  const uniqueMap = new Map();
  for (const p of data) {
    if (!p || !p.id || uniqueMap.has(p.id)) continue;
    const pClean = cleanPhone(p.phone || "");
    if (
      pClean === clean ||
      (tail && pClean.endsWith(tail)) ||
      (clean && pClean && (clean.endsWith(pClean) || pClean.endsWith(clean))) ||
      (p.phone && tail && p.phone.replace(/[^\d]/g, "").endsWith(tail))
    ) {
      uniqueMap.set(p.id, p);
    }
  }

  return Array.from(uniqueMap.values());
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
  let { data, error } = await supabase
    .from("clinic_settings")
    .select(
      "whatsapp_enabled, whatsapp_phone_number_id, whatsapp_business_account_id, whatsapp_access_token, whatsapp_verify_token, gemini_api_key, whatsapp_ai_instructions, whatsapp_ai_instruction_blocks, whatsapp_ai_model, attendance_timezone, onesignal_rest_api_key"
    )
    .eq("id", 1)
    .maybeSingle();

  // Keep deployments safe while the instruction-block migration is rolling out.
  if (error) {
    const fallback = await supabase
      .from("clinic_settings")
      .select(
        "whatsapp_enabled, whatsapp_phone_number_id, whatsapp_business_account_id, whatsapp_access_token, whatsapp_verify_token, gemini_api_key, whatsapp_ai_instructions, whatsapp_ai_model, attendance_timezone, onesignal_rest_api_key"
      )
      .eq("id", 1)
      .maybeSingle();
    data = fallback.data;
    error = fallback.error;
  }
  if (error) console.warn("Could not load WhatsApp clinic settings:", error.message || error);

  return {
    enabled: Boolean(data?.whatsapp_enabled ?? true),
    phoneId: String(data?.whatsapp_phone_number_id || Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") || "").trim(),
    wabaId: String(data?.whatsapp_business_account_id || Deno.env.get("WHATSAPP_BUSINESS_ACCOUNT_ID") || "").trim(),
    accessToken: String(data?.whatsapp_access_token || Deno.env.get("WHATSAPP_ACCESS_TOKEN") || "").trim(),
    verifyToken: String(data?.whatsapp_verify_token || Deno.env.get("WHATSAPP_VERIFY_TOKEN") || "lumin_secret_token").trim(),
    geminiApiKey: String(data?.gemini_api_key || Deno.env.get("GEMINI_API_KEY") || "").trim(),
    aiInstructions: compileWhatsAppAiInstructions(data?.whatsapp_ai_instruction_blocks, data?.whatsapp_ai_instructions),
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

type WhatsAppLocation = {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
};

function normaliseWhatsAppLocation(value: any): WhatsAppLocation | null {
  const rawLatitude = value?.latitude;
  const rawLongitude = value?.longitude;
  if (rawLatitude === null || rawLatitude === undefined || rawLatitude === "" || rawLongitude === null || rawLongitude === undefined || rawLongitude === "") {
    return null;
  }
  const latitude = Number(rawLatitude);
  const longitude = Number(rawLongitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return null;
  }
  const name = String(value?.name || "Current location").trim().slice(0, 160) || "Current location";
  const address = String(value?.address || "").trim().slice(0, 512);
  return { latitude, longitude, name, address };
}

function whatsappLocationContent(location: WhatsAppLocation): string {
  const query = encodeURIComponent(`${location.latitude},${location.longitude}`);
  return `📍 ${location.name || "Current location"}\nhttps://www.google.com/maps/search/?api=1&query=${query}`;
}

// Send a pinned location message via Meta Graph API.
async function sendMetaWhatsAppLocation(
  phoneId: string,
  accessToken: string,
  toPhone: string,
  location: WhatsAppLocation,
  contextMessageId?: string | null
) {
  const isTargetBsuid = isBsuid(toPhone);
  const clean = isTargetBsuid ? toPhone.trim() : cleanPhone(toPhone);
  if (!phoneId || !accessToken || !clean) {
    console.warn("sendMetaWhatsAppLocation: missing required parameter", {
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
    type: "location",
    location: {
      latitude: location.latitude,
      longitude: location.longitude,
      name: location.name,
      ...(location.address ? { address: location.address } : {}),
    },
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
    console.error("Meta Graph API location error:", data);
    throw new Error(data?.error?.message || "Failed to send WhatsApp location via Meta API");
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
    durationMinutes?: number;
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
    durationMinutes = 60,
  } = params;

  if (!assignedUserId) {
    console.log("sendAppointmentPushNotification: No assigned doctor user ID. Skipping notification to avoid broadcasting to all users.");
    return null;
  }

  const titleAr = "موعد جديد عبر واتساب 🦷";
  const titleEn = "New WhatsApp Appointment 🦷";

  const dateDisplayAr = dayAr ? `${dayAr} (${date})` : date;
  const dateDisplayEn = dayEn ? `${dayEn} (${date})` : date;
  const durAr = durationMinutes === 60 ? "ساعة واحدة" : `${durationMinutes} دقيقة`;
  const durEn = durationMinutes === 60 ? "1 hour" : `${durationMinutes} mins`;

  const bodyAr = `تم حجز موعد جديد عبر واتساب للمريض ${patientName} معك (${doctorName}) يوم ${dateDisplayAr} الساعة ${time} (${visitType} - المدة ${durAr}).`;
  const bodyEn = `New appointment booked via WhatsApp for ${patientName} with you (${doctorName}) on ${dateDisplayEn} at ${time} (${visitType} - ${durEn}).`;

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

// Clinic week chronological order: Saturday (6), Sunday (0), Monday (1), Tuesday (2), Wednesday (3), Thursday (4), Friday (5)
const CLINIC_WEEK_ORDER = [6, 0, 1, 2, 3, 4, 5];

function formatDoctorScheduleForPrompt(fullName: string, sched: any): string {
  const days: number[] = Array.isArray(sched?.days)
    ? sched.days
        .map(Number)
        .filter((d: number) => d >= 0 && d <= 6)
        .sort((a: number, b: number) => CLINIC_WEEK_ORDER.indexOf(a) - CLINIC_WEEK_ORDER.indexOf(b))
    : [6, 0, 1, 2, 3, 4];
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

// Resolve appointment duration in minutes. Default is 60 minutes (1 hour) unless specified in admin instructions or passed explicitly.
function resolveAppointmentDuration(
  visitType?: string | null,
  customInstructions?: string | null,
  explicitDuration?: number | null
): number {
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

  // Default duration is 60 minutes (1 hour)
  return 60;
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
          description: "Check available appointment slots for a specific date or across upcoming days (e.g. for a whole week or doctor's next vacancies) according to doctors' actual working days, shift hours, and already booked appointments.",
          parameters: {
            type: "OBJECT",
            properties: {
              date: {
                type: "STRING",
                description: "Start date or specific date in YYYY-MM-DD format (e.g. 2026-09-26)",
              },
              days_ahead: {
                type: "INTEGER",
                description: "Optional number of days to scan (1 to 7). Set to 7 when patient asks for next week, upcoming vacancies, or availability without specifying an exact day.",
              },
              doctor_name: {
                type: "STRING",
                description: `Optional preferred doctor name (e.g. ${docExamples})`,
              },
              duration_minutes: {
                type: "INTEGER",
                description: "Appointment duration in minutes to check slot availability for. Defaults to 60 (1 hour). Use an exception duration (e.g. 30, 45, 90) ONLY if specified in the admin instructions for this service.",
              },
              visit_type: {
                type: "STRING",
                description: `Optional visit type / service name (e.g. ${vtExamples}) to apply any custom duration rules from admin instructions`,
              },
            },
            required: ["date"],
          },
        },
        {
          name: "lookup_patient",
          description: "Search clinic database for existing registered patient(s) by mobile phone number. Use when the patient mentions or provides a phone number in the chat, or to check for existing profiles. Returns matching patient name(s) and alerts if duplicate records exist.",
          parameters: {
            type: "OBJECT",
            properties: {
              phone: {
                type: "STRING",
                description: "The mobile phone number to look up (e.g. 07701234567 or +9647701234567 or 01012345678).",
              },
            },
            required: ["phone"],
          },
        },
        {
          name: "assign_patient",
          description: "Assign and link an existing registered patient profile to this WhatsApp conversation. Call this when duplicate patients exist for a phone number and the patient specifies which one they are, or when confirming which existing profile this conversation belongs to.",
          parameters: {
            type: "OBJECT",
            properties: {
              patient_id: {
                type: "STRING",
                description: "The UUID of the existing patient to assign.",
              },
              patient_name: {
                type: "STRING",
                description: "The name of the patient being assigned.",
              },
            },
            required: ["patient_id"],
          },
        },
        {
          name: "create_patient",
          description: "Create a new patient record in the clinic database and assign this mobile number to them. CRITICAL: ONLY call this tool when the patient is confirmed to be a new patient (i.e. not one of the existing duplicate profiles and not already registered), after asking for and receiving their full name.",
          parameters: {
            type: "OBJECT",
            properties: {
              patient_name: {
                type: "STRING",
                description: "Full name of the new patient (e.g. 'عمر أحمد علي').",
              },
              phone: {
                type: "STRING",
                description: "Optional mobile number to assign to the new patient. If omitted, uses current conversation's phone number.",
              },
            },
            required: ["patient_name"],
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
              patient_id: {
                type: "STRING",
                description: "Optional ID of the patient if already selected or known among duplicates",
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
              duration_minutes: {
                type: "INTEGER",
                description: "Appointment duration in minutes to reserve on the clinic calendar. Defaults to 60 (1 hour). Use an exception duration (e.g. 30, 45, 90) ONLY if specified in the admin instructions for this service.",
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
  timeZone: string = "Africa/Cairo",
  customInstructions: string = ""
): Promise<any> {
  const { name, args } = call;

  if (name === "check_available_slots") {
    const rawTargetDate = String(args.date || "").trim();
    if (!rawTargetDate || !/^\d{4}-\d{2}-\d{2}$/.test(rawTargetDate)) {
      return {
        available: false,
        error: "Invalid date format. Please provide YYYY-MM-DD.",
        available_slots: [],
        occupied_slots: [],
      };
    }

    const durationMinutes = resolveAppointmentDuration(
      args.visit_type,
      customInstructions,
      Number(args.duration_minutes)
    );
    const daysAhead = Math.min(Math.max(Number(args.days_ahead) || 1, 1), 7);
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
        ? sched.days
            .map(Number)
            .filter((d: number) => d >= 0 && d <= 6)
            .sort((a: number, b: number) => CLINIC_WEEK_ORDER.indexOf(a) - CLINIC_WEEK_ORDER.indexOf(b))
        : [6, 0, 1, 2, 3, 4];
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
    }

    // Helper for computing slot availability for a single date
    const computeDateAvailability = async (targetDate: string) => {
      const targetDayOfWeek = new Date(`${targetDate}T12:00:00Z`).getUTCDay();
      const dayEn = WEEKDAY_NAMES_EN[targetDayOfWeek];
      const dayAr = WEEKDAY_NAMES_AR[targetDayOfWeek];

      if (selectedDoctor && !selectedDoctor.days.includes(targetDayOfWeek)) {
        return {
          available: false,
          doctorWorks: false,
          date: targetDate,
          day: `${dayAr} / ${dayEn}`,
          dayAr,
          dayEn,
          duration_minutes: durationMinutes,
          duration_formatted: durationMinutes === 60 ? "ساعة واحدة (1 hour)" : `${durationMinutes} دقيقة (${durationMinutes} mins)`,
          doctor: `Dr. ${selectedDoctor.fullName}`,
          available_slots: [],
          occupied_slots: [],
          total_free: 0,
          total_occupied: 0,
        };
      }

      const workingDoctors = selectedDoctor
        ? [selectedDoctor]
        : doctorList.filter((d: any) => d.days.includes(targetDayOfWeek));

      if (workingDoctors.length === 0) {
        return {
          available: false,
          doctorWorks: false,
          date: targetDate,
          day: `${dayAr} / ${dayEn}`,
          dayAr,
          dayEn,
          duration_minutes: durationMinutes,
          duration_formatted: durationMinutes === 60 ? "ساعة واحدة (1 hour)" : `${durationMinutes} دقيقة (${durationMinutes} mins)`,
          doctor: selectedDoctor ? `Dr. ${selectedDoctor.fullName}` : "All Available Doctors",
          available_slots: [],
          occupied_slots: [],
          total_free: 0,
          total_occupied: 0,
        };
      }

      const candidateSlotsSet = new Set<string>();
      let maxShiftEndMin = 0;
      const stepMin = durationMinutes >= 60 ? 60 : 30;
      for (const doc of workingDoctors) {
        const daySched = doc.daily[String(targetDayOfWeek)] || { start: doc.start, end: doc.end };
        const [sh, sm] = (daySched.start || "09:00").split(":").map(Number);
        const [eh, em] = (daySched.end || "17:00").split(":").map(Number);
        let m = sh * 60 + sm;
        const endM = eh * 60 + em;
        if (endM > maxShiftEndMin) maxShiftEndMin = endM;
        while (m + durationMinutes <= endM) {
          const hh = String(Math.floor(m / 60)).padStart(2, "0");
          const mm = String(m % 60).padStart(2, "0");
          candidateSlotsSet.add(`${hh}:${mm}`);
          m += stepMin;
        }
      }

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

      const bookedAppointments = (rawBookedAppointments || [])
        .map((apt: any) => {
          const local = parseLocalAppointmentTime(apt.appointment_at, timeZone);
          if (local.dateStr !== targetDate) return null;
          const duration = Number(apt.duration_minutes) || durationMinutes;
          return {
            assigned_user_id: apt.assigned_user_id,
            startMin: local.startMin,
            endMin: local.startMin + duration,
            timeStr: local.timeStr,
          };
        })
        .filter(Boolean);

      for (const b of bookedAppointments) {
        if (b && b.endMin + durationMinutes <= maxShiftEndMin) {
          const hh = String(Math.floor(b.endMin / 60)).padStart(2, "0");
          const mm = String(b.endMin % 60).padStart(2, "0");
          candidateSlotsSet.add(`${hh}:${mm}`);
        }
      }

      const allCandidateSlots = Array.from(candidateSlotsSet).sort();

      const availableSlots: string[] = [];
      const occupiedSlots: string[] = [];
      const isToday = targetDate === clinicNow.dateStr;

      for (const slot of allCandidateSlots) {
        const [h, min] = slot.split(":").map(Number);
        const slotStartMin = h * 60 + min;
        const slotEndMin = slotStartMin + durationMinutes;

        if (isToday && slotStartMin <= (clinicNow.minutesOfDay + 15)) {
          continue;
        }

        const docsAtThisSlot = workingDoctors.filter((doc: any) => {
          const daySched = doc.daily[String(targetDayOfWeek)] || { start: doc.start, end: doc.end };
          const [sh, sm] = (daySched.start || "09:00").split(":").map(Number);
          const [eh, em] = (daySched.end || "17:00").split(":").map(Number);
          return slotStartMin >= (sh * 60 + sm) && slotEndMin <= (eh * 60 + em);
        });

        if (docsAtThisSlot.length === 0) continue;

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
        doctorWorks: true,
        date: targetDate,
        day: `${dayAr} / ${dayEn}`,
        dayAr,
        dayEn,
        duration_minutes: durationMinutes,
        duration_formatted: durationMinutes === 60 ? "ساعة واحدة (1 hour)" : `${durationMinutes} دقيقة (${durationMinutes} mins)`,
        doctor: selectedDoctor ? `Dr. ${selectedDoctor.fullName}` : "All Available Doctors",
        morning_slots: morningSlots.slice(0, 5),
        evening_slots: eveningSlots.slice(0, 8),
        available_slots: availableSlots,
        occupied_slots: occupiedSlots,
        total_free: availableSlots.length,
        total_occupied: occupiedSlots.length,
      };
    };

    if (daysAhead === 1) {
      const singleDayRes = await computeDateAvailability(rawTargetDate);
      if (!singleDayRes.doctorWorks) {
        const workingDaysAr = selectedDoctor
          ? selectedDoctor.days.map((d: number) => WEEKDAY_NAMES_AR[d]).join(" و ")
          : "";
        const workingDaysEn = selectedDoctor
          ? selectedDoctor.days.map((d: number) => WEEKDAY_NAMES_EN[d]).join(", ")
          : "";
        return {
          available: false,
          date: rawTargetDate,
          day: singleDayRes.day,
          doctor: selectedDoctor ? `Dr. ${selectedDoctor.fullName}` : "All Available Doctors",
          message: selectedDoctor
            ? `د. ${selectedDoctor.fullName} لا يعمل يوم ${singleDayRes.day}. مواعيد عمله في العيادة هي: ${workingDaysAr} (${workingDaysEn}). هل ترغب بالحجز في أحد هذه الأيام، أو الحجز مع طبيب آخر متاح في العيادة يوم ${singleDayRes.day}؟`
            : `العيادة لا يتوفر بها أطباء مناوبون يوم ${singleDayRes.day}. يرجى اختيار يوم آخر من أيام العمل المتاحة.`,
          working_days: workingDaysAr,
          available_slots: [],
          occupied_slots: [],
        };
      }

      return {
        available: singleDayRes.available,
        date: singleDayRes.date,
        day: singleDayRes.day,
        duration_minutes: durationMinutes,
        duration_formatted: singleDayRes.duration_formatted,
        doctor: singleDayRes.doctor,
        morning_slots: singleDayRes.morning_slots,
        evening_slots: singleDayRes.evening_slots,
        available_slots: singleDayRes.available_slots,
        occupied_slots: singleDayRes.occupied_slots,
        total_free: singleDayRes.total_free,
        total_occupied: singleDayRes.total_occupied,
        rules_and_warnings: singleDayRes.occupied_slots.length > 0
          ? `IMPORTANT: The following slots are OCCUPIED/ALREADY BOOKED: ${singleDayRes.occupied_slots.join(", ")}. NEVER offer or book any occupied slot. If the patient requested an occupied slot, tell them it is taken and propose alternative slots from available_slots.`
          : `All scheduled ${durationMinutes}-minute slots on this date are currently available.`,
      };
    }

    // Multi-day scan (e.g. days_ahead: 7)
    const availableDays: any[] = [];
    const baseMs = Date.parse(`${rawTargetDate}T12:00:00Z`);

    for (let offset = 0; offset < daysAhead; offset++) {
      const d = new Date(baseMs + offset * 24 * 3600 * 1000);
      const currDateStr = d.toISOString().slice(0, 10);
      const dayRes = await computeDateAvailability(currDateStr);
      if (dayRes.doctorWorks && dayRes.available) {
        availableDays.push(dayRes);
      }
    }

    if (availableDays.length === 0) {
      const workingDaysAr = selectedDoctor
        ? selectedDoctor.days.map((d: number) => WEEKDAY_NAMES_AR[d]).join(" و ")
        : "";
      return {
        available: false,
        days_scanned: daysAhead,
        start_date: rawTargetDate,
        duration_minutes: durationMinutes,
        duration_formatted: durationMinutes === 60 ? "ساعة واحدة (1 hour)" : `${durationMinutes} دقيقة (${durationMinutes} mins)`,
        doctor: selectedDoctor ? `Dr. ${selectedDoctor.fullName}` : "All Available Doctors",
        message: selectedDoctor
          ? `لا توجد مواعيد متاحة مع د. ${selectedDoctor.fullName} خلال الأيام الـ ${daysAhead} القادمة بدءاً من ${rawTargetDate}. أيام عمله هي: ${workingDaysAr}.`
          : `لا توجد مواعيد متاحة في العيادة خلال الأيام الـ ${daysAhead} القادمة بدءاً من ${rawTargetDate}.`,
        available_days: [],
      };
    }

    const summaryParts = availableDays.map((d: any) => {
      const sample = d.available_slots.slice(0, 4).join(", ");
      return `${d.day} (${d.date}): ${sample}${d.total_free > 4 ? "..." : ""}`;
    });

    return {
      available: true,
      days_scanned: daysAhead,
      start_date: rawTargetDate,
      duration_minutes: durationMinutes,
      duration_formatted: durationMinutes === 60 ? "ساعة واحدة (1 hour)" : `${durationMinutes} دقيقة (${durationMinutes} mins)`,
      doctor: selectedDoctor ? `Dr. ${selectedDoctor.fullName}` : "All Available Doctors",
      available_days: availableDays.map((d: any) => ({
        date: d.date,
        day: d.day,
        total_free: d.total_free,
        available_slots: d.available_slots,
        morning_slots: d.morning_slots,
        evening_slots: d.evening_slots,
      })),
      summary: `Found vacancies on ${availableDays.length} day(s) for ${durationMinutes}-minute slots: ${summaryParts.join(" | ")}`,
      rules_and_warnings: `MANDATORY CHRONOLOGICAL ORDER: Offer the patient the EARLIEST available date first (${availableDays[0].day}), and also present all other available dates (${availableDays.map((d: any) => d.day).join(", ")}) so the patient can choose their preferred day. NEVER skip an earlier day (e.g. Saturday) to jump to a later day (e.g. Tuesday).`,
    };
  }

  if (name === "lookup_patient") {
    const rawPhone = String(args.phone || "").trim();
    if (!rawPhone) {
      return {
        found: false,
        count: 0,
        message: "يرجى تزويدنا برقم الهاتف للبحث عنه في سجلات العيادة.",
      };
    }

    const matches = await findPatientsByPhone(supabase, rawPhone);

    if (matches.length === 0) {
      return {
        found: false,
        count: 0,
        phone: rawPhone,
        message: `لم يتم العثور على أي ملف مريض مسجل برقم الهاتف (${rawPhone}). إذا كان المريض جديداً، اطلب اسمه الكامل، وفقط عندئذ قم بإنشاء ملف جديد عبر create_patient وربط هذا الرقم به.`,
      };
    }

    if (matches.length === 1) {
      const p = matches[0];
      if (!conversation.patient_id) {
        conversation.patient_id = p.id;
        conversation.patient_name = p.name;
        await supabase
          .from("whatsapp_conversations")
          .update({ patient_id: p.id, patient_name: p.name })
          .eq("id", conversation.id);
      }
      return {
        found: true,
        count: 1,
        patient: { id: p.id, name: p.name, phone: p.phone, patient_number: p.patient_number },
        message: `تم جلب ملف المريض بنجاح: الاسم "${p.name}" (معرّف المريض: ${p.id}). رحب بالمريض باسمه وأكد هويته واستخدم ملفه للحجز.`,
      };
    }

    // Multiple matches (Duplicates)
    return {
      found: true,
      count: matches.length,
      duplicates: matches.map((p: any) => ({ id: p.id, name: p.name, phone: p.phone })),
      message: `تنبيه: يوجد ${matches.length} مرضى مسجلين بنفس رقم الهاتف (${matches.map((p: any) => `"${p.name}"`).join("، ")}). يجب سؤال المريض: أي من هذه الأسماء المسجلة هو صاحب الطلب (أم أنه مريض جديد)، ولا تقم بتأكيد الحجز أو إنشاء مريض جديد حتى يحدد الاسم المطلوب عبر assign_patient أو يؤكد أنه مريض جديد عبر create_patient.`,
    };
  }

  if (name === "assign_patient") {
    const { patient_id, patient_name } = args;
    if (!patient_id) {
      return { success: false, error: "patient_id is required" };
    }

    const { data: p, error: pErr } = await supabase
      .from("patients")
      .select("id, name, phone")
      .eq("id", patient_id)
      .maybeSingle();

    if (pErr || !p) {
      return { success: false, error: `Patient not found with ID ${patient_id}` };
    }

    const finalName = p.name || patient_name || "Patient";

    await supabase
      .from("whatsapp_conversations")
      .update({
        patient_id: p.id,
        patient_name: finalName,
      })
      .eq("id", conversation.id);

    conversation.patient_id = p.id;
    conversation.patient_name = finalName;

    return {
      success: true,
      patient_id: p.id,
      patient_name: finalName,
      message: `تم تعيين وربط المحادثة بنجاح بالملف المسجل للمريض "${finalName}".`,
    };
  }

  if (name === "create_patient") {
    const patientName = String(args.patient_name || "").trim();
    if (!patientName) {
      return { success: false, error: "patient_name is required" };
    }

    const rawTargetPhone = args.phone || conversation.phone || "";
    const phoneToAssign = isBsuid(rawTargetPhone) ? "" : rawTargetPhone;

    const nameParts = patientName.split(/\s+/).filter(Boolean);
    const firstName = nameParts[0] || "Patient";
    const lastName = nameParts.slice(1).join(" ") || "";

    const { data: newPatient, error: createErr } = await supabase
      .from("patients")
      .insert({
        name: patientName,
        first_name: firstName,
        last_name: lastName,
        phone: phoneToAssign,
        chart_state: {},
      })
      .select("id, name, phone")
      .single();

    if (createErr) {
      console.error("create_patient error:", createErr);
      return { success: false, error: createErr.message };
    }

    await supabase
      .from("whatsapp_conversations")
      .update({
        patient_id: newPatient.id,
        patient_name: newPatient.name,
      })
      .eq("id", conversation.id);

    conversation.patient_id = newPatient.id;
    conversation.patient_name = newPatient.name;

    return {
      success: true,
      patient_id: newPatient.id,
      patient_name: newPatient.name,
      phone: newPatient.phone,
      message: `تم إنشاء ملف جديد بنجاح للمريض "${newPatient.name}" برقم هاتف "${newPatient.phone || "بدون رقم"}"، وتم ربط المحادثة به.`,
    };
  }

  if (name === "book_appointment") {
    const { patient_name, date, time, doctor_name, visit_type, notes, patient_id } = args;
    const duration = resolveAppointmentDuration(visit_type, customInstructions, Number(args.duration_minutes));
    const appointmentAtIso = localDateTimeToUtcIso(date, time, timeZone);
    const reqStartMs = Date.parse(appointmentAtIso);
    const reqEndMs = reqStartMs + duration * 60 * 1000;

    // 1. Resolve patient: prioritize provided patient_id or conversation.patient_id
    let patientId = patient_id || conversation.patient_id;
    let finalPatientName = (patient_name || conversation.patient_name || "").trim();

    if (!patientId) {
      if (!isBsuid(conversation.phone) && conversation.phone) {
        const matches = await findPatientsByPhone(supabase, conversation.phone);
        if (matches.length === 1) {
          patientId = matches[0].id;
          finalPatientName = matches[0].name || finalPatientName;
        } else if (matches.length > 1) {
          // Check if patient_name matches one of the duplicate names
          const reqNameLower = finalPatientName.toLowerCase();
          const matchedDup = matches.find((m: any) => {
            const mName = String(m.name || "").toLowerCase().trim();
            return mName && (mName === reqNameLower || reqNameLower.includes(mName) || mName.includes(reqNameLower));
          });
          if (matchedDup) {
            patientId = matchedDup.id;
            finalPatientName = matchedDup.name;
          } else {
            return {
              success: false,
              error: "DUPLICATE_PATIENTS_EXIST",
              duplicates: matches.map((m: any) => ({ id: m.id, name: m.name })),
              message: `يوجد أكثر من مريض مسجل بهذا الرقم (${matches.map((m: any) => m.name).join("، ")}). يرجى سؤال المريض عن الاسم المطلوب لتأكيد الحجز عبر assign_patient، أو توضيح ما إذا كان مريضاً جديداً.`,
            };
          }
        }
      }

      // If still no patientId, ONLY THEN create a new patient and assign this number
      if (!patientId) {
        const effectiveName = finalPatientName || "WhatsApp Patient";
        const nameParts = effectiveName.split(/\s+/).filter(Boolean);
        const firstName = nameParts[0] || "Patient";
        const lastName = nameParts.slice(1).join(" ") || "";
        const { data: newPatient, error: newPatientErr } = await supabase
          .from("patients")
          .insert({
            name: effectiveName,
            first_name: firstName,
            last_name: lastName,
            phone: isBsuid(conversation.phone) ? "" : conversation.phone,
            chart_state: {},
          })
          .select("id, name")
          .single();

        if (newPatientErr) {
          console.error("Failed to create new patient in book_appointment:", newPatientErr);
        } else if (newPatient) {
          patientId = newPatient.id;
          finalPatientName = newPatient.name;
        }
      }

      if (patientId) {
        await supabase
          .from("whatsapp_conversations")
          .update({ patient_id: patientId, patient_name: finalPatientName })
          .eq("id", conversation.id);
        conversation.patient_id = patientId;
        conversation.patient_name = finalPatientName;
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
        if (reqMin >= (sh * 60 + sm) && (reqMin + duration) <= (eh * 60 + em)) {
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
            const aEnd = aStart + (Number(apt.duration_minutes) || duration) * 60 * 1000;
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
        const aEnd = aStart + (Number(apt.duration_minutes) || duration) * 60 * 1000;
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
        duration_minutes: duration,
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
      durationMinutes: duration,
    }).catch((pushErr) => {
      console.warn("sendAppointmentPushNotification error:", pushErr);
    });

    return {
      success: true,
      appointment_id: apt.id,
      patient_name: patient_name || conversation.patient_name,
      date,
      time,
      duration_minutes: duration,
      duration: duration === 60 ? "ساعة واحدة (1 hour)" : `${duration} دقيقة (${duration} mins)`,
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
  timeZone: string = "Africa/Cairo",
  customInstructions: string = ""
): Promise<string> {
  const contents = JSON.parse(JSON.stringify(initialContents));

  for (let turn = 0; turn < 5; turn++) {
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

        const toolResult = await handleGeminiToolCall(supabase, call, conversation, timeZone, customInstructions);
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

  // 2. Patient Identity Auto-Sync: Fetch registered patient(s) by mobile number
  let matchedPatients: any[] = [];
  if (!isBsuid(conversation?.phone) && conversation?.phone) {
    matchedPatients = await findPatientsByPhone(supabase, conversation.phone);
  }

  // Auto-link conversation if exactly 1 patient is registered and conversation is unassigned
  if (matchedPatients.length === 1 && !conversation?.patient_id) {
    conversation.patient_id = matchedPatients[0].id;
    conversation.patient_name = matchedPatients[0].name || conversation.patient_name;
    await supabase
      .from("whatsapp_conversations")
      .update({ patient_id: matchedPatients[0].id, patient_name: conversation.patient_name })
      .eq("id", conversation.id);
  }

  let patientContextSection = "";
  if (isBsuid(conversation?.phone)) {
    patientContextSection = `PATIENT IDENTIFICATION STATUS (MASKED WHATSAPP USERNAME):
- This patient is contacting via a masked WhatsApp username (phone number hidden).
- Current contact name: "${conversation?.patient_name || "WhatsApp User"}"
- If the patient provides a mobile number in the chat, IMMEDIATELY call the \`lookup_patient\` tool with that number.
- When booking or registering, politely ask for their mobile phone number and full name.`;
  } else if (matchedPatients.length > 1) {
    const dupList = matchedPatients
      .map((p: any, idx: number) => `  ${idx + 1}. "${p.name}" (ID: ${p.id})`)
      .join("\n");
    const assignedNote = conversation?.patient_id
      ? `Currently assigned profile: "${conversation.patient_name}" (ID: ${conversation.patient_id})`
      : `Currently unassigned among duplicates`;

    patientContextSection = `CRITICAL PATIENT CONTEXT - DUPLICATE PATIENTS FOUND FOR PHONE +${conversation?.phone}:
- Status: There are MULTIPLE (${matchedPatients.length}) existing patient records registered with this phone number:
${dupList}
- ${assignedNote}

MANDATORY RULES FOR DUPLICATE PATIENTS:
1. ALWAYS ASK THE PATIENT WHICH ONE TO ASSIGN:
   ${!conversation?.patient_id ? `Because there are duplicate patient profiles registered under this mobile number, you MUST ask the patient which one of these duplicate profiles they are (or if they are contacting for someone new / a new patient).
   Ask warmly in their language, for example:
   "أهلاً بك في عيادة لومين لطب الأسنان! 🦷✨
   يوجد لدينا أكثر من ملف مسجل بهذا الرقم:
${matchedPatients.map((p: any, i: number) => `   ${i + 1}. ${p.name}`).join("\n")}
   هل التواصل بخصوص أحد هذه الأسماء، أم لشخص جديد؟"` : `If the patient indicates they are contacting or booking for another name on the list or a new person, update or create accordingly.`}
2. ASSIGNING AN EXISTING PROFILE:
   When the patient indicates which duplicate profile they are (by name or number):
   - Immediately call \`assign_patient\` with that patient's \`patient_id\` and \`patient_name\`.
   - Greet or confirm to them warmly by name, and proceed with their requested service.
3. CREATING A NEW PATIENT:
   - ONLY IF the patient explicitly clarifies that they are a NEW patient (i.e. not any of the duplicate profiles listed above):
     Ask for their full name (if not yet provided).
     ONLY THEN call \`create_patient\` to make a new patient record and assign this mobile number to them!
   - NEVER create a new patient profile if they match or choose one of the existing duplicate profiles!`;
  } else if (matchedPatients.length === 1) {
    const p = matchedPatients[0];
    patientContextSection = `PATIENT CONTEXT - REGISTERED PATIENT FOUND FOR PHONE +${conversation?.phone}:
- Fetched Patient Name: "${p.name}"
- Patient ID: ${p.id}
- Phone: ${p.phone || conversation?.phone}

RULES:
1. Address the patient warmly by their fetched name (e.g. "أهلاً بك أستاذ/ة ${p.name}! 🦷✨").
2. By default, use this patient profile (ID: ${p.id}) for any appointments.
3. If the patient explicitly states they are contacting on behalf of someone else or a new family member:
   Ask for that person's full name, and ONLY THEN call \`create_patient\` to register them.`;
  } else {
    patientContextSection = `PATIENT CONTEXT - UNREGISTERED PHONE (+${conversation?.phone || "None"}):
- Status: No existing patient record found with this phone number.
- Current WhatsApp chat name: "${conversation?.patient_name || "WhatsApp User"}"

RULES:
1. If the patient provides a different phone number in chat, call \`lookup_patient\` with that number.
2. If they want to book an appointment or register:
   Ask for their full name.
   ONLY THEN call \`create_patient\` (or \`book_appointment\`) to create a new patient record and assign this mobile number to them.`;
  }

  // 3. Precompute 10-day lookahead calendar reference (strictly Middle Eastern clinic week starting Saturday)
  const lookaheadDays: string[] = [];
  const baseLookaheadMs = Date.parse(`${clinicNow.dateStr}T12:00:00Z`);
  for (let i = 0; i <= 10; i++) {
    const d = new Date(baseLookaheadMs + i * 24 * 3600 * 1000);
    const dStr = d.toISOString().slice(0, 10);
    const dayOfWeek = d.getUTCDay();
    const label = i === 0 ? " [اليوم / Today]" : i === 1 ? " [غداً / Tomorrow]" : "";
    lookaheadDays.push(`- ${dStr}: ${WEEKDAY_NAMES_AR[dayOfWeek]} (${WEEKDAY_NAMES_EN[dayOfWeek]})${label}`);
  }
  const upcomingCalendarStr = lookaheadDays.join("\n");

  const systemInstruction = `You are the polite, welcoming, and efficient AI receptionist for Lumin Dental Clinic (عيادة لومين لطب الأسنان).
Current clinic date & day of the week: ${todayStr}.
Current clinic local time: ${clinicNow.timeStr}.

Upcoming 10-Day Clinic Calendar Reference (Use this exact table for accurate date calculations):
${upcomingCalendarStr}

Clinic operating hours: Saturday to Thursday from 10:00 AM to 8:00 PM (10:00 to 20:00). Closed on Fridays.
Middle Eastern Clinic Week: The working week begins on SATURDAY (السبت) and ends on THURSDAY (الخميس).

Active Clinic Doctors & Live Working Schedules (Directly from Clinic HR Staff Settings):
${doctorsScheduleStr}

Rules for Doctor Schedules, Working Hours & Vacancies:
- Working Week Order: The clinic working week begins on SATURDAY. Saturday is day 1, followed by Sunday, Monday, Tuesday, Wednesday, Thursday.
- Chronological Order: When a patient asks for a doctor's availability, "next week" (الأسبوع القادم), or general open appointments:
  1. Call \`check_available_slots\` with \`days_ahead: 7\` to scan all upcoming working days.
  2. You MUST present vacancies in strict chronological order: Offer SATURDAY first if available, followed by subsequent days (e.g. Saturday before Tuesday). NEVER skip Saturday to jump to Tuesday!
  3. Clearly state the day name and date for each option (e.g. "يوم السبت 26 سبتمبر أو يوم الثلاثاء 29 سبتمبر").
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

================================================================================
PATIENT IDENTITY & PROFILE RULES:
${patientContextSection}

PHONE NUMBER LOOKUP & ASSIGNMENT RULES:
1. When a patient provides a mobile number in the chat (or if the sender's phone is masked and they provide their phone number):
   - You MUST call \`lookup_patient(phone)\` with the provided mobile number.
   - If 1 patient is found: fetch their name, greet them warmly by name, and call \`assign_patient\`.
   - If duplicate patients are found: you MUST ask the patient which one of the duplicate patients to assign (or if they are a new patient). When they clarify, call \`assign_patient\`.
   - ONLY IF they clarify that they are a new patient, ask for their full name, and ONLY THEN call \`create_patient\` to make a new patient and assign this number to him.
================================================================================

================================================================================
CRITICAL APPOINTMENT DURATION RULES (1 HOUR DEFAULT):
1. DEFAULT APPOINTMENT DURATION IS 1 HOUR (60 MINUTES):
   - By default, ALL appointments given, proposed, and booked by the AI receptionist MUST be 1 HOUR (60 minutes).
   - When calling \`check_available_slots\`, pass \`duration_minutes: 60\` by default.
   - When calling \`book_appointment\`, pass \`duration_minutes: 60\` by default.
   - When offering slots to the patient, propose them with 1 hour duration (e.g. "الساعة 11:00 صباحاً (المدة: ساعة كاملة / من 11:00 إلى 12:00)").

2. EXCEPTIONS SPECIFIED IN THE ADMIN INSTRUCTIONS:
   - Carefully check the "Additional clinic instruction sections" below (configured in the clinic admin settings).
   - IF the admin instructions specify a different duration for a specific service or visit type (such as "الكشف 30 دقيقة" / "Consultation is 30 minutes", "التنظيف 45 دقيقة", "علاج العصب 90 دقيقة", etc.):
     * You MUST follow that specific duration as an exception instead of 1 hour!
     * Pass that duration in \`check_available_slots(duration_minutes: ...)\` and \`book_appointment(duration_minutes: ...)\`.
   - IF NO specific duration is mentioned in the admin instructions for a service, ALWAYS default to 1 hour (60 minutes).
================================================================================

General Rules:
1. Speak in the patient's language naturally (Arabic or English). If the patient speaks Arabic or Iraqi/Egyptian dialect, respond in warm, polite Arabic.
2. If the patient wants to book an appointment or asks about availability:
   - Determine the appointment duration: check the admin instructions below for any custom duration specified for this service (e.g. consultation 30 mins). If no exception is specified in the admin instructions, the duration MUST be 1 hour (60 minutes).
   - For general availability, a doctor's schedule, or "next week", call \`check_available_slots\` with \`days_ahead: 7\` and \`duration_minutes\` (default 60). Propose the earliest available working day first (e.g. Saturday before Tuesday), offering 2-3 day options so the patient can choose.
   - For a specific date, call \`check_available_slots\` with that YYYY-MM-DD date and \`duration_minutes\`.
   - Propose 3 to 5 convenient vacant slots (from available_slots) to the patient.
   - Ask for their full name if not already known.
   - When the patient agrees on a specific date and time, call \`book_appointment\` with \`duration_minutes\` to save it to the system with the appropriate doctor and visit type.
   - Once booked, provide a clear, warm confirmation message summarizing the date, time, duration (e.g. 1 hour / ساعة واحدة), doctor, and service.
3. If the patient has severe medical emergencies, pain that requires immediate triage, or requests to speak to a person, call \`request_human_support\` and politely inform the patient that our clinic team will reply shortly.
4. Keep your responses concise, friendly, and formatted nicely for WhatsApp (use *bold* and bullet points sparingly). Do not use long markdown tables.

${customInstructions ? `Additional clinic instruction sections:\n${customInstructions}` : ""}`;

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
        timeZone,
        customInstructions
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
          location,
          reply_to_id,
          reply_to_text,
          reply_to_sender,
        } = body;

        const isAudio = message_type === "audio" && Boolean(audio_base64);
        const isLocation = message_type === "location";
        const safeLocation = isLocation ? normaliseWhatsAppLocation(location) : null;
        if (isLocation && !safeLocation) {
          return jsonResponse({ error: "A valid latitude and longitude are required for a location message" }, 400);
        }
        if ((!conversation_id && !phone) || (!content && !isAudio && !safeLocation)) {
          return jsonResponse({ error: "conversation_id or phone, and content, audio_base64, or location are required" }, 400);
        }
        const displayContent = safeLocation ? whatsappLocationContent(safeLocation) : (content || (isAudio ? "🎤 Voice Message" : ""));

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
              const matchedPatients = await findPatientsByPhone(supabase, clean);
              if (matchedPatients.length === 1) {
                linkedPatientId = matchedPatients[0].id;
                linkedPatientName = matchedPatients[0].name || linkedPatientName;
              }
            }

            const { data: newConv, error: createConvErr } = await supabase
              .from("whatsapp_conversations")
              .insert({
                phone: clean,
                patient_id: linkedPatientId,
                patient_name: linkedPatientName,
                ai_enabled: true,
                last_message: displayContent,
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
        const finalContent = displayContent;

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
        } else if (safeLocation) {
          if (settings.phoneId && settings.accessToken) {
            metaSendResult = await sendMetaWhatsAppLocation(
              settings.phoneId,
              settings.accessToken,
              conv.phone,
              safeLocation,
              contextWamid
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
            message_type: isAudio ? "audio" : (safeLocation ? "location" : "text"),
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
              const matchedPatients = await findPatientsByPhone(supabase, clean);
              if (matchedPatients.length === 1) {
                linkedPatientId = matchedPatients[0].id;
                linkedPatientName = matchedPatients[0].name || linkedPatientName;
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
                } else if (incoming.type === "location") {
                  messageType = "location";
                  const incomingLocation = normaliseWhatsAppLocation(incoming.location);
                  textContent = incomingLocation ? whatsappLocationContent(incomingLocation) : "📍 Location";
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
                    const matchedPatients = await findPatientsByPhone(supabase, fromPhone);
                    if (matchedPatients.length === 1) {
                      patientName = matchedPatients[0].name || contactName;
                      patientId = matchedPatients[0].id;
                    } else if (matchedPatients.length > 1) {
                      // Duplicates exist! Leave patientId null so AI agent can prompt user to clarify which one to assign.
                      patientId = null;
                      patientName = contactName || `+${fromPhone}`;
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
                  const updatePayload: any = {
                    last_message: textContent,
                    last_message_at: new Date().toISOString(),
                    unread_count: (conv.unread_count || 0) + 1,
                  };

                  if (!conv.patient_id && !isMaskedProfile && fromPhone) {
                    const matchedPatients = await findPatientsByPhone(supabase, fromPhone);
                    if (matchedPatients.length === 1) {
                      updatePayload.patient_id = matchedPatients[0].id;
                      if (matchedPatients[0].name) {
                        updatePayload.patient_name = matchedPatients[0].name;
                      }
                    }
                  }

                  const { data: updatedConv } = await supabase
                    .from("whatsapp_conversations")
                    .update(updatePayload)
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
