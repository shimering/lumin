import { createClient } from "npm:@supabase/supabase-js@2.105.0";
import "../../../lumin-quotation-model.js";

const headers = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type, x-client-info","Access-Control-Allow-Methods":"POST, OPTIONS","Content-Type":"application/json","Cache-Control":"no-store, private"};
const respond = (body: unknown,status=200) => new Response(JSON.stringify(body),{status,headers});
const model = (globalThis as any).LuminQuotationModel;
const settingColumns = "id,clinic_name,logo_data_url,whatsapp_phone,updated_at";
const quoteColumns = "id,patient_id,selected_ids,token,language,expires_at,revoked_at,revision,created_at,updated_at";

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null,{headers});
  if (request.method !== "POST") return respond({error:"Method not allowed."},405);
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) return respond({error:"Authentication required."},401);
  try {
    const userClient = createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_ANON_KEY")!,{global:{headers:{Authorization:authorization}},auth:{persistSession:false,autoRefreshToken:false}});
    const {data:auth,error:authError} = await userClient.auth.getUser(authorization.slice(7));
    if (authError || !auth.user) return respond({error:"Authentication required."},401);
    const admin = createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false,autoRefreshToken:false}});
    const {data:profile,error:profileError} = await admin.from("user_profiles").select("active,access_roles!inner(is_admin,role_permissions(page_key,can_view))").eq("user_id",auth.user.id).maybeSingle();
    const role = Array.isArray(profile?.access_roles) ? profile.access_roles[0] : profile?.access_roles;
    if (profileError) return respond({error:"Could not check access."},503);
    const canChart = profile?.active && (role?.is_admin || role?.role_permissions?.some((permission: any) => permission.page_key === "chart" && permission.can_view));
    if (!canChart) return respond({error:"Chart access required."},403);
    const raw = await request.text();
    if (raw.length > 350000) return respond({error:"Request too large."},413);
    const body = JSON.parse(raw);
    if (body.action === "settings") {
      const result = await userClient.from("quotation_settings").select(settingColumns).eq("id",1).single();
      if (result.error) return respond({error:"Could not load quotation settings."},503);
      return respond({settings:result.data});
    }
    if (body.action === "save_settings") {
      if (!role?.is_admin) return respond({error:"Administrator access required."},403);
      const name = String(body.clinic_name || "").trim();
      const logo = String(body.logo_data_url || "");
      const phone = String(body.whatsapp_phone || "").replace(/[\s+()-]/g,"");
      if (!name || name.length > 120 || !/^[1-9][0-9]{6,14}$/.test(phone) || logo.length > 300000 || (logo && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(logo))) return respond({error:"Enter a clinic name, an international WhatsApp number, and a valid PNG, JPEG, or WebP logo."},400);
      const result = await admin.from("quotation_settings").update({clinic_name:name,logo_data_url:logo,whatsapp_phone:phone,updated_at:new Date().toISOString()}).eq("id",1).select(settingColumns).single();
      if (result.error) return respond({error:"Could not save quotation settings."},503);
      return respond({settings:result.data});
    }
    if (!model.validId(body.patient_id)) return respond({error:"Invalid patient."},400);
    // Read through the caller's RLS, even though writes below use the service role.
    const {data:patient,error:patientError} = await userClient.from("patients").select("id,chart_state").eq("id",body.patient_id).maybeSingle();
    if (patientError || !patient) return respond({error:"Patient unavailable."},404);
    if (body.action === "list") {
      const result = await userClient.from("patient_quotations").select(quoteColumns).eq("patient_id",patient.id).order("created_at",{ascending:false}).limit(100);
      if (result.error) return respond({error:"Could not load quotations."},503);
      return respond({quotations:result.data});
    }
    if (!["create","update","revoke"].includes(body.action)) return respond({error:"Invalid action."},400);
    let previous: any = null;
    if (body.action !== "create") {
      if (!model.validId(body.id)) return respond({error:"Invalid quotation."},400);
      const result = await userClient.from("patient_quotations").select(quoteColumns).eq("id",body.id).eq("patient_id",patient.id).maybeSingle();
      if (result.error || !result.data) return respond({error:"Quotation unavailable."},404);
      previous = result.data;
      if (!Number.isSafeInteger(body.revision) || Number(previous.revision) !== body.revision) return respond({error:"This quotation changed. Reopen it before saving."},409);
      if (previous.revoked_at) return respond({error:"This quotation was disabled. Create a new link."},409);
    }
    let changes: any = {updated_at:new Date().toISOString()};
    if (body.action === "revoke") changes.revoked_at = new Date().toISOString();
    else {
      const ids = [...new Set(Array.isArray(body.selected_ids) ? body.selected_ids : [])];
      if (!ids.length || ids.length > 1000 || !ids.every(model.validId)) return respond({error:"Select planned procedures."},400);
      const expires = new Date(body.expires_at);
      if (!Number.isFinite(expires.getTime()) || expires.getTime() <= Date.now()) return respond({error:"Choose a future expiry date."},400);
      const {data:operations,error:operationError} = await userClient.from("dental_operations").select("code,name,price,action_scope,visual_code");
      if (operationError) return respond({error:"Could not load procedure prices."},503);
      const planned = model.project(patient.chart_state,operations,ids,"create").eligibleIds;
      const existing = new Set(previous?.selected_ids || []);
      // Previously selected IDs may be completed/deleted; the live view omits them.
      // Preserve them on expiry-only edits, but only add newly selected Plan items.
      if (ids.some(id => !planned.includes(id) && !existing.has(id))) return respond({error:"Some selected procedures are no longer planned. Refresh the chart and try again."},409);
      const {data:settings,error:settingsError} = await admin.from("quotation_settings").select("whatsapp_phone").eq("id",1).single();
      if (settingsError || !settings?.whatsapp_phone) return respond({error:"An administrator must set the clinic WhatsApp number in Quotation settings first."},409);
      changes = {...changes,selected_ids:ids,expires_at:expires.toISOString(),language:body.language === "ar" ? "ar" : "en"};
    }
    let result;
    if (body.action === "create") {
      const token = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2,"0")).join("");
      result = await admin.from("patient_quotations").insert({...changes,patient_id:patient.id,token,created_by:auth.user.id}).select(quoteColumns).single();
    } else {
      result = await admin.from("patient_quotations").update({...changes,revision:Number(previous.revision)+1}).eq("id",previous.id).eq("patient_id",patient.id).eq("revision",body.revision).is("revoked_at",null).select(quoteColumns).maybeSingle();
    }
    if (result.error) return respond({error:"Could not save quotation."},503);
    if (!result.data) return respond({error:"This quotation changed. Reopen it before saving."},409);
    return respond({quotation:result.data});
  } catch {
    return respond({error:"Could not process quotation."},400);
  }
});
