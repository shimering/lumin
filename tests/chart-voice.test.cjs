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

test('spoken confirmation accepts explicit answers without treating mixed speech as approval', async () => {
  const { voiceReply } = await import('../lumin-chart-voice.mjs');
  for (const phrase of ['Confirm.', 'Yes, confirm!', '“yes”', 'أكّد', 'أيوه.']) {
    assert.equal(voiceReply(phrase), 'confirm', phrase);
  }
  for (const phrase of ['Cancel.', 'No, cancel!', 'لا', 'مش موافق']) {
    assert.equal(voiceReply(phrase), 'cancel', phrase);
  }
  for (const phrase of ['Do you confirm?', 'Yes, but not that tooth', 'Do not confirm', 'No, yes', '[unclear]', '']) {
    assert.equal(voiceReply(phrase), null, phrase);
  }
});
