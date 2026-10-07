const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
function source(name) {
  const start = html.search(new RegExp('    (?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, 'Missing function: ' + name);
  const end = html.indexOf('\n    }', start);
  return html.slice(start, end + 6);
}
const names = [
  'isPrimaryToothId', 'palmerPositionForSlot', 'palmerQuadrantForSlot', 'palmerQuadrantLabel',
  'patientMediaToothLabel', 'readPatientMediaDetails',
  'persistPatientMediaDetails', 'patientMediaDisplayName', 'patientMediaDownloadName', 'patientMediaFileUrl',
  'renderPatientMedia', 'renderPatientMediaGrid', 'openPatientMediaDetailsModal', 'closePatientMediaDetailsModal',
  'savePatientMediaDetails', 'handlePatientMediaUploadSubmit', 'showPatientMediaUploadError',
  'requestPatientMediaMove', 'handleMovePatientMediaSubmit',
];
const primary = { 4:'A',5:'B',6:'C',7:'D',8:'E',9:'F',10:'G',11:'H',12:'I',13:'J',20:'K',21:'L',22:'M',23:'N',24:'O',25:'P',26:'Q',27:'R',28:'S',29:'T' };
const filePath = "Patient/Periapical/film's.png";
function createHarness() {
  const nodes = new Map();
  const rows = new Map();
  const calls = { uploads: 0, saves: 0, moves: [] };
  let saveError = false;
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', innerHTML: '', textContent: '', style: {}, files: [], disabled: false,
      classList: { add() {}, remove() {}, contains() { return false; } }, focus() {},
    });
    return nodes.get(id);
  }
  const photo = new File(['photo'], 'film.png', { type: 'image/png' });
  const context = {
    currentUiLanguage: 'en', currentPatientMediaFiles: [], activePatientMediaPatientId: 'patient-1',
    activeWorkspacePatientId: 'patient-1', patientMediaRenderToken: 0, patientMediaDetailsError: false,
    activePatientMediaFilter: 'ALL', editingPatientMediaDetails: null, pendingPatientMediaUpload: null,
    selectedPatientMediaUploadFile: photo, patientMediaUploadContext: null, currentLightboxRelativePath: '',
    PRIMARY_TOOTH_BY_SLOT: primary, SLOT_BY_PRIMARY_TOOTH: Object.fromEntries(Object.entries(primary).map(([slot, id]) => [id, Number(slot)])),
    FormData, window: { lucide: {} }, lucide: { createIcons() {} },
    document: { getElementById: node, querySelector() { return null; }, addEventListener() {} },
    console: { warn() {}, error() {} },
    escapeHtml: value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]),
    hasPageAccess: () => true, getStorageServerConfig: () => ({ url:'https://storage.example', key:'test-key' }),
    getKnownPatient: id => ({ id, name: 'Patient' }), updatePatientWorkspaceNavigation() {}, translateUiTree() {},
    closePatientMediaUploadModal() {}, closePatientMediaMoveModal() {},
    fetch: async (url, options) => {
      if (url.includes('/media-details')) {
        calls.saves++;
        const body = JSON.parse(options.body);
        const record = { patient_id: 'patient-1', relative_path: body.relativePath, ...body.details };
        if (saveError) return {ok:false,json:async()=>({error:'Local metadata unavailable'})};
        rows.set(record.patient_id + ':' + record.relative_path, structuredClone(record));
        return {ok:true,json:async()=>({metadataSource:'local',details:record})};
      }
      if (url.includes('/api/file/move')) {
        const body = JSON.parse(options.body); calls.moves.push(body);
        const newPath = body.relativePath.replace(/\/[^/]+\//, '/' + body.targetCategory + '/');
        const row = rows.get('patient-1:' + body.relativePath);
        if (row) {rows.delete('patient-1:' + body.relativePath); rows.set('patient-1:' + newPath, {...row,relative_path:newPath});}
        return { ok: true, json: async () => ({ newRelativePath:newPath, newCategory:body.targetCategory }) };
      }
      return { ok: true, json: async () => ({ metadataSource:'local', files: [{ filename:"film's.png", relativePath:filePath, category:'Periapical', sizeBytes:1024, mediaDetails:rows.get('patient-1:' + filePath) || null }] }) };
    },
    db: {from() {throw new Error('Clinical metadata must not access Supabase');}},
    XMLHttpRequest: class {
      upload = {}; status = 200; responseText = JSON.stringify({ relativePath: filePath });
      open() {} setRequestHeader() {}
      send() { calls.uploads++; this.onload(); }
    },
  };
  vm.createContext(context);
  vm.runInContext(names.map(source).join('\n'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'lumin-media-teeth.js'), 'utf8'), context);
  for (const prefix of ['upload', 'edit']) {
    node(prefix + '-media-name').value = 'UR6 pre-op';
    node(prefix + '-media-note').value = 'Review the distal surface.\nCompare after treatment.';
    node(prefix + '-media-tooth-ids').value = '["3","4","A"]';
  }
  node('upload-media-category').value = 'Periapical';
  return { context, node, rows, calls, failSaves: value => { saveError = value; } };
}
const submit = { preventDefault() {} };

test('visual tooth choices expose all 32 permanent and 20 deciduous teeth with separate identities', () => {
  const { context, node } = createHarness();
  for (const [primary, expected] of [[false,32], [true,20]]) {
    const options = context.patientMediaToothChoices(primary).flat().map(tooth => tooth.id);
    assert.equal(new Set(options).size, expected);
    assert.ok(options.includes(primary ? 'A' : '3'));
  }
  assert.equal(context.patientMediaToothLabel('3'), 'Permanent · UR6');
  assert.equal(context.patientMediaToothLabel('A'), 'Deciduous · URE');
  context.setPatientMediaTeeth('upload', []);
  assert.equal(context.readPatientMediaDetails('upload').tooth_id, null);
});

test('invalid or nested assignments are rejected before any upload', async () => {
  const { context, node, calls } = createHarness();
  for (const invalid of [['33'], ['a'], [null], [['3']], '3']) {
    node('upload-media-tooth-ids').value = JSON.stringify(invalid);
    await context.handlePatientMediaUploadSubmit(submit);
  }
  assert.equal(calls.uploads, 0);
  assert.match(node('upload-media-error').textContent, /valid permanent or deciduous teeth/);
});

test('old records retain their tooth and an explicit empty array clears it; duplicates are removed', () => {
  const { context } = createHarness();
  assert.equal(JSON.stringify(context.patientMediaToothIds({tooth_id:'A'})), '["A"]');
  assert.equal(JSON.stringify(context.patientMediaToothIds({tooth_id:'A',tooth_ids:[]})), '[]');
  assert.equal(JSON.stringify(context.patientMediaToothIds({tooth_ids:['3','A','3']})), '["3","A"]');
});

test('upload saves the name, tooth, and multiline note; reloading the gallery restores them', async () => {
  const { context, node, rows, calls } = createHarness();
  await context.handlePatientMediaUploadSubmit(submit);
  assert.equal(calls.uploads, 1);
  const row = rows.get('patient-1:' + filePath);
  assert.equal(row.tooth_id, '3');
  assert.deepEqual(row.tooth_ids, ['3','4','A']);
  assert.equal(row.display_name, 'UR6 pre-op');
  assert.equal(row.note, node('upload-media-note').value);
  assert.match(node('patient-media-content').innerHTML, /Review the distal surface/);
  assert.match(node('patient-media-content').innerHTML, /Permanent · UR6/);
  assert.match(node('patient-media-content').innerHTML, /Permanent · UR5 · Deciduous · URE/);
  context.currentPatientMediaFiles = [];
  await context.renderPatientMedia();
  assert.equal(context.currentPatientMediaFiles[0].mediaDetails.note, row.note);
});

test('retrying after details fail saves the already-uploaded photo without a duplicate', async () => {
  const harness = createHarness();
  harness.failSaves(true);
  await harness.context.handlePatientMediaUploadSubmit(submit);
  assert.equal(harness.calls.uploads, 1);
  assert.match(harness.node('upload-media-error').textContent, /without uploading a duplicate/);
  harness.failSaves(false);
  await harness.context.handlePatientMediaUploadSubmit(submit);
  assert.equal(harness.calls.uploads, 1);
  assert.equal(harness.calls.saves, 2);
  assert.equal(harness.context.pendingPatientMediaUpload, null);
});

test('rename and assignment changes persist on an existing file without changing its storage URL', async () => {
  const harness = createHarness();
  await harness.context.handlePatientMediaUploadSubmit(submit);
  const originalUrl = harness.context.patientMediaFileUrl(harness.context.currentPatientMediaFiles[0]);
  harness.context.openPatientMediaDetailsModal(0);
  harness.node('edit-media-name').value = "Sara's follow-up";
  harness.context.setPatientMediaTeeth('edit', ['A','B']);
  await harness.context.savePatientMediaDetails(submit);
  await harness.context.renderPatientMedia();
  const file = harness.context.currentPatientMediaFiles[0];
  assert.equal(harness.context.patientMediaDisplayName(file), "Sara's follow-up");
  assert.equal(file.mediaDetails.tooth_id, 'A');
  assert.deepEqual(file.mediaDetails.tooth_ids, ['A','B']);
  assert.equal(harness.context.patientMediaDownloadName(file), "Sara's follow-up.png");
  assert.equal(harness.context.patientMediaFileUrl(file), originalUrl);
});

test('patient notes and names are escaped in gallery markup and file paths never enter inline scripts', () => {
  const { context, node } = createHarness();
  context.currentPatientMediaFiles = [{ filename:'film.png', relativePath:"Patient/General/');alert(1);//.png", category:'General', sizeBytes:1000,
    mediaDetails:{ display_name:'<script>name</script>', note:'<img src=x onerror=alert(1)>', tooth_id:'A' } }];
  context.renderPatientMediaGrid();
  const markup = node('patient-media-content').innerHTML;
  assert.match(markup, /&lt;script&gt;name&lt;\/script&gt;/);
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(markup, /onclick="openPatientMediaDetailsModal\(0\)"/);
  assert.doesNotMatch(markup, /onclick="[^"\n]*alert/);
});

test('clearing a saved note removes it instead of restoring older server notes', async () => {
  const harness = createHarness();
  await harness.context.handlePatientMediaUploadSubmit(submit);
  harness.context.currentPatientMediaFiles[0].note = 'Older server note';
  harness.context.openPatientMediaDetailsModal(0);
  harness.node('edit-media-note').value = '';
  await harness.context.savePatientMediaDetails(submit);
  assert.doesNotMatch(harness.node('patient-media-content').innerHTML, /Older server note|Review the distal surface/);
});

test('changing category preserves details, while a failed save restores the original category', async () => {
  for (const fail of [false, true]) {
    const harness = createHarness();
    await harness.context.handlePatientMediaUploadSubmit(submit);
    harness.node('move-media-relative-path').value = filePath;
    harness.node('move-media-target-category').value = 'General';
    harness.failSaves(fail);
    await harness.context.handleMovePatientMediaSubmit(submit);
    if (fail) {
      assert.equal(harness.calls.moves.length, 2);
      assert.equal(harness.calls.moves[1].targetCategory, 'Periapical');
      assert.ok(harness.rows.has('patient-1:' + filePath));
      assert.match(harness.node('move-media-error').textContent, /restored/);
    } else {
      const newRow = harness.rows.get('patient-1:' + filePath.replace('/Periapical/', '/General/'));
      assert.equal(newRow.note, harness.node('upload-media-note').value);
      assert.equal(newRow.tooth_id, '3');
      assert.deepEqual(newRow.tooth_ids, ['3','4','A']);
      assert.equal(harness.rows.has('patient-1:' + filePath), false);
    }
  }
});
