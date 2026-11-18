const assert = require('node:assert/strict');
const test = require('node:test');

test('Gemma chart drafts keep valid operations and require clarification for invalid rows', async () => {
  const { parseVoiceDraft, voiceCatalogOptions } = await import('../lumin-chart-voice.mjs');
  const operation = { tooth: 'UR6', procedure: 'composite', status: '', surfaces: ['occlusal', 'occlusal'] };
  const result = { action: 'add_procedure', heard: 'sample', operations: [operation, { ...operation, tooth: 'UR7' }] };
  assert.deepEqual(parseVoiceDraft(JSON.stringify(result)).operations, [
    { ...operation, surfaces: ['occlusal'] }, { ...operation, tooth: 'UR7', surfaces: ['occlusal'] }
  ]);
  const partial = parseVoiceDraft(JSON.stringify({ ...result, operations: [operation, { ...operation, tooth: '6' }] }));
  assert.equal(partial.needsDetails, true);
  assert.deepEqual(partial.operations, [{ ...operation, surfaces: ['occlusal'] }]);
  assert.deepEqual(parseVoiceDraft(JSON.stringify({ action: 'clarify', heard: 'six', message: 'Which quadrant?' })),
    { heard: 'six', message: 'Which quadrant?', needsDetails: true, operations: [] });
  assert.throws(() => parseVoiceDraft(JSON.stringify({ ...result, operations: Array(9).fill(operation) })));
  const crown = { active: true, actionScope: 'whole', visualCode: 'zirconia_crown' };
  assert.deepEqual(voiceCatalogOptions('crown', [crown, { ...crown, active: false }, { ...crown, trackImplantProgress: true }]), [crown]);
});

test('spoken confirmation accepts explicit answers without treating mixed speech as approval', async () => {
  const { voiceReply } = await import('../lumin-chart-voice.mjs');
  for (const phrase of ['Confirm.', 'Yes, confirm!', '“yes”', 'Yes, go ahead.', 'أكّد', 'أيوه. احفظ']) {
    assert.equal(voiceReply(phrase), 'confirm', phrase);
  }
  for (const phrase of ['Cancel.', 'No, cancel!', 'لا', 'مش موافق']) {
    assert.equal(voiceReply(phrase), 'cancel', phrase);
  }
  for (const phrase of ['Do you confirm?', 'Yes, but not that tooth', 'Do not confirm', 'No, yes', '[unclear]', '']) {
    assert.equal(voiceReply(phrase), null, phrase);
  }
});

test('a command and its confirmation reuse one local model worker', async t => {
  const { createLocalChartEngine, modelBytes } = await import('../lumin-chart-voice-model.mjs');
  const workers = [];
  const globals = {
    isSecureContext: true,
    BroadcastChannel: undefined,
    navigator: {
      gpu: {},
      storage: { getDirectory: async () => ({
        getFileHandle: async () => ({ getFile: async () => ({ size: modelBytes }) })
      }) },
      locks: { request: async (_name, _options, callback) => callback({}) }
    },
    caches: { match: async () => new Response('worker') },
    Worker: class {
      constructor() { workers.push(this); }
      postMessage({ type }) {
        queueMicrotask(() => this.onmessage({ data: { result: type } }));
      }
      terminate() { this.terminated = true; }
    }
  };
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
  }
  const engine = createLocalChartEngine();
  t.after(() => engine.unload());
  assert.equal(await engine.interpret({ confirmation: false }), 'interpret');
  assert.equal(await engine.interpret({ confirmation: true }), 'confirm');
  assert.equal(workers.length, 1);
  assert.equal(workers[0].terminated, undefined);
  engine.unload();
  assert.equal(workers[0].terminated, true);
});
