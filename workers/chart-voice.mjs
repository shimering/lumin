const maxBytes = 672000;
const reply = (error, status) => Response.json({ error }, {
  status,
  headers: { 'Cache-Control': 'private, no-store' }
});

async function readCommand(request) {
  if (!request.body || Number(request.headers.get('Content-Length')) > maxBytes) return null;
  const reader = request.body.getReader();
  const bytes = new Uint8Array(maxBytes);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.length > maxBytes) {
        await reader.cancel();
        return null;
      }
      bytes.set(value, length);
      length += value.length;
    }
    const command = JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
    const prompt = typeof command?.prompt === 'string' ? command.prompt.trim() : '';
    if (command?.audio === undefined && prompt && prompt.length <= 2000) return { prompt };
    if (!prompt && typeof command?.audio === 'string' && command.audio.length <= 666728
        && command.audio.startsWith('UklGR') && /^[A-Za-z0-9+/]+={0,2}$/.test(command.audio)) {
      return { audio: command.audio };
    }
  } catch (_) {}
  return null;
}

export async function handleChartVoice(request, env, fetcher, authorize) {
  if (request.method !== 'POST') return reply('method', 405);
  if (request.headers.get('Origin') !== new URL(request.url).origin) return reply('forbidden', 403);
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '')) return reply('input', 415);
  try {
    await authorize(request, fetcher, 'chart');
  } catch (error) {
    return error.status === 401 || error.status === 403
      ? reply('access', error.status) : reply('unavailable', 503);
  }
  const command = await readCommand(request);
  if (!command) return reply('input', 400);
  if (!env.GEMMA_BRIDGE_URL || !env.GEMMA_BRIDGE_TOKEN) return reply('unconfigured', 503);
  try {
    const bridge = new URL(env.GEMMA_BRIDGE_URL.replace(/\/$/, '') + '/api/chart');
    if (bridge.protocol !== 'https:') return reply('unconfigured', 503);
    const result = await fetcher(bridge, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.GEMMA_BRIDGE_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
      redirect: 'error',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(115000)])
    });
    if (!result.ok || !result.headers.get('Content-Type')?.startsWith('application/x-ndjson')) {
      await result.body?.cancel();
      return result.status === 429 ? reply('busy', 429) : reply('unavailable', 502);
    }
    return new Response(result.body, { headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    } });
  } catch (_) {
    return reply('unavailable', 502);
  }
}
