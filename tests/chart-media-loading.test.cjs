const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../lumin-chart-media.js'), 'utf8');

function fixture() {
  let allow = true, config = {url: 'https://storage.test', key: 'clinic-key'}, releases = [], requests = 0;
  const context = vm.createContext({window: {matchMedia: () => ({matches: false})}, document: {addEventListener() {}, getElementById: () => null},
    activePatientId: 'one', currentSession: {user: {id: 'doctor'}}, patientMediaToothPicker: null,
    getKnownPatient: id => ({id, name: id}), hasPageAccess: () => allow, getStorageServerConfig: () => config,
    structuredClone, AbortController, AbortSignal, setTimeout, clearTimeout,
    fetch: async () => { requests++; return new Promise(resolve => releases.push(data => resolve({ok: true, json: async () => data}))); }
  });
  vm.runInContext(source, context); context.renderChartMediaPanel = () => {}; context.renderPatientAttachmentList = () => {};
  return {context, state: vm.runInContext('chartPatientMedia', context), release: data => releases.shift()(data), requests: () => requests, deny: () => allow = false, changeStorage: () => config = {url: 'https://other.test', key: 'other-key'}};
}
const response = name => ({metadataSource: 'local', files: [{filename: name + '.png', category: 'Periapical', relativePath: name + '/Periapical/x.png', mediaDetails: {tooth_ids: ['3']}}]});

test('reopening a chart renders confirmed X-rays immediately while new records load in the background', async () => {
  const f = fixture();
  const first = f.context.loadChartPatientMedia(); f.release(response('one')); await first;
  const refresh = f.context.loadChartPatientMedia();
  assert.equal(f.state.status, 'ready'); assert.equal(f.state.files[0].filename, 'one.png');
  f.release({...response('one'), files: []}); await refresh;
  assert.equal(f.state.files.length, 0, 'A background deletion updates the confirmed counts');
});

test('prefetch and chart opening share one request; different patients and storage never share records', async () => {
  const f = fixture(), prefetch = f.context.prefetchChartPatientMedia('one'), first = f.context.loadChartPatientMedia();
  assert.equal(f.requests(), 1); f.release(response('one')); await Promise.all([prefetch, first]);
  f.context.activePatientId = 'two'; const second = f.context.loadChartPatientMedia();
  assert.equal(f.state.files.length, 0); f.release(response('two')); await second;
  f.changeStorage(); const other = f.context.loadChartPatientMedia();
  assert.equal(f.state.files.length, 0); f.release(response('other')); await other;
});

test('sign-out discards cached and pending records; revoked access never renders a cached patient', async () => {
  const f = fixture(), first = f.context.loadChartPatientMedia(); f.release(response('one')); await first;
  const pending = f.context.loadChartPatientMedia(); f.context.resetChartPatientMediaCache();
  f.release(response('old-session')); await pending; assert.equal(f.state.files.length, 0);
  const next = f.context.loadChartPatientMedia(); f.release(response('one')); await next;
  f.deny(); await f.context.loadChartPatientMedia(); assert.equal(f.state.status, 'unavailable'); assert.equal(f.state.files.length, 0);
});
