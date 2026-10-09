import '../lumin-public-config.js';

const config = globalThis.LuminPublicConfig;
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const privateHeaders = {
  'Cache-Control':'no-store, private',
  'Referrer-Policy':'no-referrer',
  'X-Robots-Tag':'noindex, nofollow, noarchive',
  'X-Content-Type-Options':'nosniff',
};

async function quotation(token, fetcher) {
  if (!/^[a-f0-9]{64}$/.test(token || '')) return {status:404};
  try {
    const response = await fetcher(`${config.supabaseUrl}/functions/v1/quotation-view`, {
      method:'POST', headers:{'Content-Type':'application/json',apikey:config.supabaseAnonKey},
      body:JSON.stringify({token}), cache:'no-store', credentials:'omit', referrerPolicy:'no-referrer',
      signal:AbortSignal.timeout(10000),
    });
    if (!response.ok) return {status:response.status === 404 ? 404 : 503};
    const data = await response.json();
    if (typeof data.patientName !== 'string' || !Number.isFinite(data.total) || !Number.isFinite(Date.parse(data.expiresAt)) || Date.parse(data.expiresAt) <= Date.now()) return {status:404};
    return {status:200,data};
  } catch (_) { return {status:503}; }
}

function logoImage(value) {
  if (typeof value !== 'string' || value.length > 700000) return null;
  const match = value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return null;
  try {
    const bytes = Uint8Array.from(atob(match[2]), char => char.charCodeAt(0));
    const png = [137,80,78,71,13,10,26,10].every((value,index) => bytes[index] === value);
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const webp = String.fromCharCode(...bytes.slice(0,4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8,12)) === 'WEBP';
    if (!(match[1] === 'image/png' && png || match[1] === 'image/jpeg' && jpeg || match[1] === 'image/webp' && webp)) return null;
    return {bytes,type:match[1]};
  } catch (_) { return null; }
}

function brandedHtml(html, data, url) {
  const clinic = data.clinic?.name || 'Lumin';
  const total = new Intl.NumberFormat('ar-EG',{style:'currency',currency:'EGP',minimumFractionDigits:0,maximumFractionDigits:0}).format(data.total);
  const title = `عرض أسعار العلاج · ${clinic}`;
  const description = `عرض أسعار العلاج للمريض ${data.patientName}. الإجمالي ${total}.`;
  const canonical = new URL('/quotation.html',url);
  canonical.searchParams.set('q',url.searchParams.get('q'));
  const image = logoImage(data.clinic?.logo);
  const logo = image ? new URL('/quotation-logo',url) : new URL('/icons/dental-icon-v1-512.png',url);
  if (image) logo.searchParams.set('q',url.searchParams.get('q'));
  const metadata = {
    'og:type':'website', 'og:locale':'ar_EG', 'og:title':title, 'og:description':description,
    'og:site_name':clinic, 'og:url':canonical.href, 'og:image':logo.href,
    'og:image:secure_url':logo.href, 'og:image:type':image?.type || 'image/png',
    'og:image:alt':`شعار ${clinic}`,
  };
  // Emit crawler-readable metadata without embedding the patient API response.
  html = html.replace(/<meta\b[^>]*\bproperty=["']og:[^"']+["'][^>]*>/gi,'');
  html = html.replace(/<title>[\s\S]*?<\/title>/i,`<title>${escape(title)}</title>`);
  html = html.replace(/<link\b[^>]*\bid=["']quotation-favicon["'][^>]*>/i,`<link id="quotation-favicon" rel="icon" type="${image?.type || 'image/png'}" href="${escape(logo.href)}"/>`);
  return html.replace('</head>',Object.entries(metadata).map(([property,content]) => `<meta property="${property}" content="${escape(content)}"/>`).join('\n')+'\n</head>');
}

export async function handleRequest(request, env, fetcher = fetch) {
  const url = new URL(request.url);
  const page = ['/quotation','/quotation/','/quotation.html'].includes(url.pathname);
  const image = url.pathname === '/quotation-logo';
  if (!page && !image) return env.ASSETS.fetch(request);
  if (!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed.',{status:405,headers:{...privateHeaders,Allow:'GET, HEAD'}});
  if (url.pathname === '/quotation/') {
    const target = new URL('/quotation.html',url);target.search=url.search;
    return new Response(null,{status:308,headers:{...privateHeaders,Location:target.href}});
  }
  const token = url.searchParams.get('q');
  const result = token || image ? await quotation(token,fetcher) : {status:200};
  if (image) {
    const logo = result.data && logoImage(result.data.clinic?.logo);
    if (!logo) return new Response(request.method === 'HEAD' ? null : 'Clinic logo unavailable.',{status:result.status === 503 ? 503 : 404,headers:privateHeaders});
    return new Response(request.method === 'HEAD' ? null : logo.bytes,{headers:{...privateHeaders,'Content-Type':logo.type}});
  }
  const assetUrl = new URL('/quotation.html',url);
  const asset = await env.ASSETS.fetch(new Request(assetUrl,{headers:{Accept:'text/html'}}));
  if (!asset.ok) return new Response('Quotation unavailable.',{status:503,headers:privateHeaders});
  let html = await asset.text();
  if (result.data) html = brandedHtml(html,result.data,url);
  return new Response(request.method === 'HEAD' ? null : html,{status:result.status,headers:{...privateHeaders,'Content-Type':'text/html; charset=utf-8'}});
}

export default {fetch(request,env) { return handleRequest(request,env); }};
