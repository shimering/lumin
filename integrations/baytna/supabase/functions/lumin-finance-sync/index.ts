import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.0";

// Each request is authenticated with an event-specific HMAC, never a reusable credential.
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const signature = req.headers.get("x-lumin-sync-signature");
  if (!signature || !/^[a-f0-9]{64}$/.test(signature)) return new Response("Unauthorized", { status: 401 });
  const body = await req.text();
  if (body.length > 16384) return new Response("Payload too large", { status: 413 });
  let event;
  try { event = JSON.parse(body); } catch { return new Response("Invalid JSON", { status: 400 }); }
  const client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data, error } = await client.rpc("receive_lumin_finance", { p_token: signature, p_event: event });
  if (error) {
    const status = error.code === "28000" ? 401 : 422;
    // Do not log the source payload or database details.
    return Response.json({ ok: false, error: status === 401 ? "Unauthorized" : "Account, category, or event could not be accepted." }, { status });
  }
  return Response.json(data, { headers: { "Cache-Control": "no-store" } });
});
