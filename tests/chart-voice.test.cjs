const assert = require('node:assert/strict');
const test = require('node:test');

test('Gemma chart drafts require every operation to use supported Palmer teeth and values', async () => {
  const { parseVoiceDraft, voiceCatalogOptions } = await import('../lumin-chart-voice.mjs');
  const operation = { tooth: 'UR6', procedure: 'composite', status: '', surfaces: ['occlusal', 'occlusal'] };
  const result = { action: 'add_procedure', heard: 'sample', operations: [operation, { ...operation, tooth: 'UR7' }] };
  assert.deepEqual(parseVoiceDraft(JSON.stringify(result)).operations, [
    { ...operation, surfaces: ['occlusal'] }, { ...operation, tooth: 'UR7', surfaces: ['occlusal'] }
  ]);
  assert.throws(() => parseVoiceDraft(JSON.stringify({ ...result, operations: [operation, { ...operation, tooth: '6' }] })));
  assert.deepEqual(parseVoiceDraft(JSON.stringify({ action: 'clarify', heard: 'six', message: 'Which quadrant?' })),
    { heard: 'six', message: 'Which quadrant?' });
  const crown = { active: true, actionScope: 'whole', visualCode: 'zirconia_crown' };
  assert.deepEqual(voiceCatalogOptions('crown', [crown, { ...crown, active: false }, { ...crown, trackImplantProgress: true }]), [crown]);
});

test('chart voice Worker verifies access and forwards only the command to the configured HTTPS bridge', async () => {
  const { handleChartVoice } = await import('../workers/chart-voice.mjs');
  const origin = 'https://lumin.example';
  const request = (body, headers = {}) => new Request(origin + '/api/chart-voice', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', Authorization: 'Bearer staff-session', ...headers },
    body: JSON.stringify(body)
  });
  const env = { GEMMA_BRIDGE_URL: 'https://bridge.example/gemma-bridge/', GEMMA_BRIDGE_TOKEN: 'bridge-secret' };
  const authorize = async (incoming, _fetcher, scope) => {
    assert.equal(scope, 'chart');
    assert.equal(incoming.headers.get('Authorization'), 'Bearer staff-session');
  };
  const denied = async () => { throw Object.assign(new Error(), { status: 403 }); };
  const never = () => assert.fail('Bridge must not receive the command');
  assert.equal((await handleChartVoice(request({ prompt: 'sample' }), env, never, denied)).status, 403);
  assert.equal((await handleChartVoice(request({ prompt: 'sample' }, { Origin: 'https://elsewhere.example' }), env, never, authorize)).status, 403);
  assert.equal((await handleChartVoice(request({ prompt: 'x'.repeat(2001) }), env, never, authorize)).status, 400);
  assert.equal((await handleChartVoice(request({ prompt: 'sample' }), {}, never, authorize)).status, 503);
  const lines = '{"text":"draft"}\n{"done":true}\n';
  const upstream = async (url, options) => {
    assert.equal(url.href, 'https://bridge.example/gemma-bridge/api/chart');
    assert.equal(options.headers.Authorization, 'Bearer bridge-secret');
    assert.deepEqual(JSON.parse(options.body), { prompt: 'sample' });
    return new Response(lines, { headers: { 'Content-Type': 'application/x-ndjson' } });
  };
  const forwarded = await handleChartVoice(request({ prompt: 'sample', patientId: 'omitted' }), env, upstream, authorize);
  assert.equal(forwarded.status, 200);
  assert.equal(forwarded.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(await forwarded.text(), lines);
});
