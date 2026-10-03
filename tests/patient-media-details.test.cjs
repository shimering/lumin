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
  'patientMediaToothLabel', 'updatePatientMediaToothOptions', 'readPatientMediaDetails',
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
    selectedPatientMediaUploadFile: photo, currentLightboxRelativePath: '',
    PRIMARY_TOOTH_BY_SLOT: primary, SLOT_BY_PRIMARY_TOOTH: Object.fromEntries(Object.entries(primary).map(([slot, id]) => [id, Number(slot)])),
    FormData, window: { lucide: {} }, lucide: { createIcons() {} },
    document: { getElementById: node, querySelector() { return null; } },
    console: { warn() {}, error() {} },
    escapeHtml: value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]),
    hasPageAccess: () => true, getStorageServerConfig: () => ({ url:'https://storage.example', key:'test-key' }),
    getKnownPatient: id => ({ id, name: 'Patient' }), updatePatientWorkspaceNavigation() {}, translateUiTree() {},
    closePatientMediaUploadModal() {}, closePatientMediaMoveModal() {},
    fetch: async (url, options) => {
      if (url.includes('/api/file/move')) {
        const body = JSON.parse(options.body); calls.moves.push(body);
        return { ok: true, json: async () => ({ newRelativePath: body.relativePath.replace(/\/[^/]+\//, '/' + body.targetCategory + '/'), newCategory: body.targetCategory }) };
      }
      return { ok: true, json: async () => ({ files: [{ filename:"film's.png", relativePath:filePath, category:'Periapical', sizeBytes:1024 }] }) };
    },
    db: { from(table) {
      assert.equal(table, 'patient_media_details');
      const filters = [];
      let operation = 'select', record;
      const query = {
        upsert(value) { operation = 'save'; record = value; return this; },
        select() { return this; }, single() { return this; },
        eq(key, value) { filters.push([key, value]); return this; },
        delete() { operation = 'delete'; return this; },
        then(resolve, reject) {
          let result;
          if (operation === 'save') {
            calls.saves++;
            if (saveError) result = { data: null, error: new Error('Database unavailable') };
            else { rows.set(record.patient_id + ':' + record.relative_path, structuredClone(record)); result = { data: record, error: null }; }
          } else {
            const matches = [...rows.values()].filter(row => filters.every(([key,value]) => row[key] === value));
            if (operation === 'delete') matches.forEach(row => rows.delete(row.patient_id + ':' + row.relative_path));
            result = { data: operation === 'select' ? matches : null, error: null };
          }
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return query;
    } },
    XMLHttpRequest: class {
      upload = {}; status = 200; responseText = JSON.stringify({ relativePath: filePath });
      open() {} setRequestHeader() {}
      send() { calls.uploads++; this.onload(); }
    },
  };
  vm.createContext(context);
  vm.runInContext(names.map(source).join('\n'), context);
  for (const prefix of ['upload', 'edit']) {
    node(prefix + '-media-name').value = 'UR6 pre-op';
    node(prefix + '-media-note').value = 'Review the distal surface.\nCompare after treatment.';
    node(prefix + '-media-dentition').value = 'permanent';
    node(prefix + '-media-tooth').value = '3';
  }
  node('upload-media-category').value = 'Periapical';
  return { context, node, rows, calls, failSaves: value => { saveError = value; } };
}
const submit = { preventDefault() {} };

test('tooth selectors expose all 32 permanent and 20 deciduous teeth with separate identities', () => {
  const { context, node } = createHarness();
  for (const [dentition, expected] of [['permanent',32], ['primary',20]]) {
    node('upload-media-dentition').value = dentition;
    context.updatePatientMediaToothOptions('upload');
    const options = [...node('upload-media-tooth').innerHTML.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(options).size, expected);
    assert.equal(node('upload-media-tooth').required, true);
    assert.ok(options.includes(dentition === 'primary' ? 'A' : '3'));
  }
  assert.equal(context.patientMediaToothLabel('3'), 'Permanent · UR6');
  assert.equal(context.patientMediaToothLabel('A'), 'Deciduous · URE');
  node('upload-media-dentition').value = '';
  context.updatePatientMediaToothOptions('upload');
  assert.equal(node('upload-media-tooth').disabled, true);
  assert.equal(context.readPatientMediaDetails('upload').tooth_id, null);
});

test('dentition must match the selected tooth before any upload', async () => {
  const { context, node, calls } = createHarness();
  node('upload-media-dentition').value = 'primary';
  await context.handlePatientMediaUploadSubmit(submit);
  assert.equal(calls.uploads, 0);
  assert.match(node('upload-media-error').textContent, /chosen dentition/);
});

test('upload saves the name, tooth, and multiline note; reloading the gallery restores them', async () => {
  const { context, node, rows, calls } = createHarness();
  await context.handlePatientMediaUploadSubmit(submit);
  assert.equal(calls.uploads, 1);
  const row = rows.get('patient-1:' + filePath);
  assert.equal(row.tooth_id, '3');
  assert.equal(row.display_name, 'UR6 pre-op');
  assert.equal(row.note, node('upload-media-note').value);
  assert.match(node('patient-media-content').innerHTML, /Review the distal surface/);
  assert.match(node('patient-media-content').innerHTML, /Permanent · UR6/);
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
  harness.node('edit-media-dentition').value = 'primary';
  harness.node('edit-media-tooth').value = 'A';
  await harness.context.savePatientMediaDetails(submit);
  await harness.context.renderPatientMedia();
  const file = harness.context.currentPatientMediaFiles[0];
  assert.equal(harness.context.patientMediaDisplayName(file), "Sara's follow-up");
  assert.equal(file.mediaDetails.tooth_id, 'A');
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
      assert.equal(harness.rows.has('patient-1:' + filePath), false);
    }
  }
});
