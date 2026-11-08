const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { webcrypto, createHmac } = require('node:crypto');

const source = stripTypeScriptTypes(fs.readFileSync('supabase/functions/whatsapp-webhook/index.ts', 'utf8').replace(/^import .*;\r?\n/gm, ''));

function fixture(options = {}) {
  let handler, sequence = 0;
  const rows = (options.history || []).map(row => ({ conversation_id: 'conversation', ...row }));
  const pending = [], calls = { generated: [], sent: [], pushes: 0, downloads: 0, previews: 0 };
  const conversation = { id: 'conversation', phone: '201000000000', patient_id: 'patient', patient_name: 'Fixture', ai_enabled: true, status: 'active', unread_count: 0 };
  const database = { from(table) {
    let operation = 'select', payload, columns, maximum = Infinity;
    const predicates = [], orderings = [];
    function execute(single = false) {
      if (table === 'whatsapp_conversations') {
        if (operation === 'update') {
          if (Object.hasOwn(payload, 'last_message')) calls.previews++;
          Object.assign(conversation, payload);
        }
        return { data: { ...conversation }, error: null };
      }
      assert.equal(table, 'whatsapp_messages');
      if (operation === 'insert') {
        if (payload.sender === 'patient' && options.insertError) return { data: null, error: { code: 'fixture', message: 'Save failed' } };
        if (payload.sender === 'patient' && (options.insertDuplicate || rows.some(row => row.whatsapp_message_id === payload.whatsapp_message_id))) return { data: null, error: null };
        const row = { id: `row-${++sequence}`, created_at: new Date(Date.now() + sequence).toISOString(), ...payload };
        rows.push(row);
        return { data: row, error: null };
      }
      if (operation === 'update') {
        rows.filter(row => predicates.every(predicate => predicate(row))).forEach(row => Object.assign(row, payload));
        return { data: null, error: null };
      }
      if (options.guardError && columns === 'id, sender, status, ai_eligible') return { data: null, error: { message: 'Read failed' } };
      if (options.historyError && columns.includes('content')) return { data: null, error: { message: 'History failed' } };
      let data = rows.filter(row => predicates.every(predicate => predicate(row)));
      data.sort((a, b) => {
        for (const [key, ascending] of orderings) {
          if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * (ascending ? 1 : -1);
        }
        return 0;
      });
      data = data.slice(0, maximum);
      return { data: single ? data[0] || null : data, error: null };
    }
    return {
      select(value = '') { columns = value; return this; },
      eq(key, value) { predicates.push(row => row[key] === value); return this; },
      gte(key, value) { predicates.push(row => row[key] >= value); return this; },
      lte(key, value) { predicates.push(row => row[key] <= value); return this; },
      or() { return this; },
      order(key, { ascending }) { orderings.push([key, ascending]); return this; },
      limit(value) { maximum = value; return this; },
      insert(value) { operation = 'insert'; payload = value; return this; },
      update(value) { operation = 'update'; payload = value; return this; },
      async maybeSingle() { return execute(true); },
      async single() { return execute(true); },
      then(resolve, reject) { return Promise.resolve(execute()).then(resolve, reject); },
    };
  } };
  const context = vm.createContext({ Request, Response, URL, TextEncoder, TextDecoder, AbortSignal, crypto: webcrypto,
    console: { log() {}, warn() {}, error() {} }, createClient: () => database,
    Deno: { env: { get: name => name === 'WHATSAPP_APP_SECRET' ? 'fixture-secret' : 'fixture' }, serve: value => { handler = value; } },
    setTimeout(callback) { options.duringDebounce?.({ conversation, rows }); callback(); return 0; },
    EdgeRuntime: { waitUntil: promise => pending.push(promise) },
  });
  new vm.Script(source).runInContext(context);
  context.getClinicWhatsAppSettings = async () => ({ enabled: true, geminiApiKey: 'fixture', phoneId: 'fixture', accessToken: 'fixture' });
  context.runGeminiAgent = async (...args) => {
    calls.generated.push(args[4]);
    options.duringGeneration?.({ conversation, rows });
    if (options.generationError) throw Error('Generation failed');
    return 'Fixture reply';
  };
  context.sendMetaWhatsAppMessage = async (...args) => { calls.sent.push(args); return { messages: [{ id: `outgoing-${calls.sent.length}` }] }; };
  context.sendIncomingWhatsAppPushNotification = async () => { calls.pushes++; };
  context.processIncomingMedia = async () => { calls.downloads++; return { publicUrl: 'https://fixture.invalid/media', base64: options.audioMissing ? null : 'fixture', mimeType: 'audio/ogg' }; };
  return { calls, rows, context, conversation, async event(incoming = {}) {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: {
      messages: [{ id: 'wamid-fixture', from: '201000000000', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Any appointments today?' }, ...incoming }],
    } }] }] });
    const signature = 'sha256=' + createHmac('sha256', 'fixture-secret').update(body).digest('hex');
    const response = await handler(new Request('https://fixture.invalid', { method: 'POST', headers: { 'x-hub-signature-256': signature }, body }));
    await Promise.all(pending);
    return response;
  } };
}

test('fresh patient text generates one reply and preserves the original timestamp', async () => {
  const f = fixture();
  assert.equal((await f.event()).status, 200);
  assert.equal(f.calls.generated.length, 1);
  assert.equal(f.calls.sent.length, 1);
  assert.equal(f.calls.pushes, 1);
  assert.equal(f.rows[0].ai_eligible, true);
  assert.ok(f.rows[0].provider_sent_at);
});

test('stale, missing, invalid and future timestamps are archived without replies, previews or notifications', async () => {
  for (const timestamp of [String(Math.floor(Date.now() / 1000) - 3 * 86400), undefined, 'invalid', String(Math.floor(Date.now() / 1000) + 3600)]) {
    const f = fixture();
    assert.equal((await f.event({ timestamp })).status, 200);
    assert.equal(f.rows.length, 1);
    assert.equal(f.rows[0].ai_eligible, false);
    assert.equal(f.calls.generated.length, 0);
    assert.equal(f.calls.sent.length, 0);
    assert.equal(f.calls.pushes, 0);
    assert.equal(f.calls.previews, 0);
  }
});

test('replayed messages and concurrent duplicate inserts never generate a second reply', async () => {
  const f = fixture();
  await f.event();
  const before = JSON.stringify(f.calls);
  await f.event();
  assert.equal(JSON.stringify(f.calls), before);
  const concurrent = fixture({ insertDuplicate: true });
  await concurrent.event();
  assert.equal(concurrent.calls.generated.length, 0);
  assert.equal(concurrent.calls.previews, 0);
  assert.equal(concurrent.calls.pushes, 0);
});

test('a failed incoming save returns a retryable error without any AI or notification', async () => {
  const f = fixture({ insertError: true });
  assert.equal((await f.event()).status, 500);
  assert.equal(f.calls.generated.length, 0);
  assert.equal(f.calls.sent.length, 0);
  assert.equal(f.calls.pushes, 0);
  assert.equal(f.calls.previews, 0);
});

test('photos, videos, documents, stickers and unsupported events without captions never restart the agent', async () => {
  for (const type of ['image', 'video', 'document', 'sticker', 'unsupported']) {
    const f = fixture();
    await f.event({ type, [type]: { id: 'media', filename: 'report.pdf' } });
    assert.equal(f.calls.generated.length, 0, type);
    assert.equal(f.calls.sent.length, 0, type);
    assert.equal(f.rows[0].ai_eligible, false, type);
    assert.equal(f.calls.pushes, 1, type);
  }
});

test('explicit media captions and usable voice audio still receive replies', async () => {
  for (const type of ['image', 'video', 'document', 'audio']) {
    const f = fixture();
    await f.event({ type, [type]: { id: 'media', caption: 'Can I book an appointment?' } });
    assert.equal(f.calls.generated.length, 1, type);
    assert.equal(f.calls.sent.length, 1, type);
  }
  const missing = fixture({ audioMissing: true });
  await missing.event({ type: 'audio', audio: { id: 'media' } });
  assert.equal(missing.calls.generated.length, 0);
});

test('failed replies and placeholders are excluded from history while patient text and delivered replies remain', async () => {
  const created_at = new Date(Date.now() - 60000).toISOString();
  const f = fixture({ history: [
    { id: 'old-patient', sender: 'patient', content: 'Earlier question', created_at, status: 'received' },
    { id: 'failed', sender: 'ai', content: 'Undelivered reply', created_at, status: 'failed' },
    { id: 'recorded', sender: 'ai', content: 'Never sent', created_at, status: 'recorded' },
    { id: 'photo', sender: 'patient', content: '📷 Photo', created_at, status: 'received' },
    { id: 'success', sender: 'staff', content: 'Delivered staff reply', created_at, status: 'read' },
  ] });
  await f.event();
  const history = JSON.parse(JSON.stringify(f.calls.generated[0]));
  assert.deepEqual(history.map(row => row.id).sort(), ['old-patient', 'row-1', 'success']);
});

test('staff takeover, staff replies and newer questions suppress obsolete normal and fallback replies', async () => {
  const changes = [
    ({ conversation }) => { conversation.ai_enabled = false; },
    ({ conversation }) => { conversation.status = 'human_needed'; },
    ({ rows }) => { rows.push({ id: 'staff', conversation_id: 'conversation', sender: 'staff', status: 'sent', created_at: new Date(Date.now() + 1000).toISOString() }); },
    ({ rows }) => { rows.push({ id: 'newer', conversation_id: 'conversation', sender: 'patient', ai_eligible: true, created_at: new Date(Date.now() + 1000).toISOString() }); },
  ];
  for (const change of changes) {
    for (const generationError of [false, true]) {
      const f = fixture({ duringGeneration: change, generationError });
      await f.event();
      assert.equal(f.calls.generated.length, 1);
      assert.equal(f.calls.sent.length, 0);
    }
    const f = fixture({ duringDebounce: change });
    await f.event();
    assert.equal(f.calls.generated.length, 0);
  }
});

test('an uncaptioned photo does not cancel the preceding text request', async () => {
  const f = fixture({ duringDebounce: ({ rows }) => rows.push({ id: 'photo', conversation_id: 'conversation', sender: 'patient', ai_eligible: false, content: '📷 Photo', created_at: new Date(Date.now() + 1000).toISOString() }) });
  await f.event();
  assert.equal(f.calls.generated.length, 1);
  assert.equal(f.calls.sent.length, 1);
});

test('eligibility and history read failures never cause an unverified fallback reply', async () => {
  for (const option of ['guardError', 'historyError']) {
    const f = fixture({ [option]: true });
    await f.event();
    assert.equal(f.calls.generated.length, 0);
    assert.equal(f.calls.sent.length, 0);
  }
});

test('a genuine generation failure can send one fallback while the request is still current', async () => {
  const f = fixture({ generationError: true });
  await f.event();
  assert.equal(f.calls.sent.length, 1);
  assert.match(f.calls.sent[0][3], /تم استلام رسالتك بنجاح/);
});
