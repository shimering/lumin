import { createClient } from "npm:@supabase/supabase-js@2.105.0";
import "../../../lumin-quotation-model.js";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store, private",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status,headers});

// No clinic JWT is required: the 256-bit quotation token is the read capability.
// Neither the token nor raw patient source data is logged or returned.
Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null,{headers});
  if (request.method !== "POST") return respond({error:"Method not allowed."},405);
  try {
    if (Number(request.headers.get("content-length") || 0) > 2048) return respond({error:"Invalid request."},400);
    const raw = await request.text();
    if (raw.length > 2048) return respond({error:"Invalid request."},400);
    const body = JSON.parse(raw);
    if (typeof body?.token !== "string" || !/^[a-f0-9]{64}$/.test(body.token)) return respond({error:"Quotation unavailable."},404);
    const admin = createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false,autoRefreshToken:false}});
    const {data:source,error} = await admin.rpc("quotation_source",{p_token:body.token});
    if (error) return respond({error:"Could not load quotation."},503);
    if (!source) return respond({error:"Quotation unavailable."},404);
    const model = (globalThis as any).LuminQuotationModel;
    return respond({
      reference:"QT-" + source.id.slice(0,8).toUpperCase(),
      patientName:source.patient_name,language:source.language,expiresAt:source.expires_at,
      clinic:source.clinic,refreshedAt:new Date().toISOString(),
      ...model.publicProjection(source.chart_state,source.operations,source.selected_ids),
    });
  } catch {
    return respond({error:"Could not load quotation."},400);
  }
});
