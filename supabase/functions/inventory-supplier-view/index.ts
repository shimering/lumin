import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const headers = {
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"content-type, apikey, authorization, x-client-info",
  "Access-Control-Allow-Methods":"POST, OPTIONS",
  "Content-Type":"application/json",
  "Cache-Control":"no-store, private",
  "Referrer-Policy":"no-referrer",
  "X-Robots-Tag":"noindex, nofollow, noarchive",
};
const respond=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});
// Only this saved snapshot is accessible with the token. Never return live inventory.
export async function handleRequest(request:Request,client?:any){
  if(request.method==='OPTIONS')return new Response(null,{headers});
  if(request.method!=='POST')return respond({error:'Method not allowed.'},405);
  try{
    if(Number(request.headers.get('content-length')||0)>2048)return respond({error:'Invalid request.'},400);
    const raw=await request.text();if(raw.length>2048)return respond({error:'Invalid request.'},400);
    const body=JSON.parse(raw);
    if(typeof body?.token!=='string'||!/^[a-f0-9]{64}$/.test(body.token))return respond({error:'Supplier list unavailable.'},404);
    const admin=client||createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
    const {data,error}=await admin.rpc('inventory_supplier_source',{p_token:body.token});
    if(error)return respond({error:'Could not load supplier list.'},503);
    if(!data)return respond({error:'Supplier list unavailable.'},404);
    return respond(data);
  }catch(_){return respond({error:'Invalid request.'},400);}
}
if(import.meta.main)Deno.serve(request=>handleRequest(request));
