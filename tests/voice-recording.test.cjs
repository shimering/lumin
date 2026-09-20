const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Exercise the shipped browser functions without accessing a microphone, cloud
// service, credentials, or patient records. Events are deliberately controllable
// so permission and recorder callbacks can arrive after stop/cancel/new-start.
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const startMarker = '// ================= CHAIRSIDE VOICE CONTROL AI AGENT =================';
const endMarker = '// ================= APPOINTMENTS CALENDAR =================';
const blockStart = html.indexOf(startMarker);
const blockEnd = html.indexOf(endMarker, blockStart);
assert.ok(blockStart >= 0 && blockEnd > blockStart, 'voice implementation markers exist');
const voiceSource = html.slice(blockStart, blockEnd);

const ipadUA = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
const desktopIpadUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15';
const iphoneUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const windowsUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeStream() {
  const track = { stops: 0, stop() { this.stops += 1; } };
  return { track, getTracks: () => [track] };
}

async function settle() {
  // Flush nested async browser handlers, without running fake safety timers.
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function harness(options = {}) {
  const storage = new Map();
  if (options.savedMode !== null) storage.set('lumin_voice_engine_mode', options.savedMode ?? 'cloud');
  const streams = [];
  const recorders = [];
  const microphoneRequests = [];
  const processed = [];
  const uiStates = [];
  const toasts = [];
  const timers = new Map();
  let nextTimer = 1;
  const radios = [{ value: 'local', disabled: false }, { value: 'cloud', disabled: false }];
  const deviceBadge = {};
  const modeBadge = { setAttribute(name, value) { this[name] = value; } };
  const settingsElements = {
    'settings-voice-device-badge': deviceBadge,
    'chart-voice-mode-badge': modeBadge,
    'settings-voice-description': {},
    'settings-voice-local-label': {},
    'settings-voice-local-description': {},
    'settings-voice-mode-note': {},
    'settings-voice-permission-note': {}
  };

  class FakeMediaRecorder {
    static isTypeSupported(type) { return type === 'audio/mp4'; }
    constructor(stream, settings = {}) {
      if (options.recorderConstructorError) throw options.recorderConstructorError;
      this.stream = stream;
      this.mimeType = settings.mimeType || 'audio/mp4';
      this.state = 'inactive';
      this.stopCalls = 0;
      recorders.push(this);
    }
    start() {
      if (options.recorderStartError) throw options.recorderStartError;
      this.state = 'recording';
    }
    emitStart() { this.onstart?.(); }
    emitData(text) { this.ondataavailable?.({ data: new Blob([text], { type: this.mimeType }) }); }
    stop() {
      assert.equal(this.state, 'recording', 'stop is called only on an active recorder');
      this.stopCalls += 1;
      // Real MediaRecorder becomes inactive immediately; final data and stop
      // events are asynchronous, and must retain exclusive session ownership.
      this.state = 'inactive';
    }
    async emitStop() {
      this.state = 'inactive';
      await this.onstop?.();
      await settle();
    }
    emitError() { this.onerror?.({ error: new Error('Recorder failed') }); }
  }

  const sandbox = {
    Blob,
    AbortController,
    DOMException,
    FileReader: class FakeFileReader {
      readAsDataURL(blob) {
        blob.text().then(text => {
          this.result = `data:${blob.type};base64,${Buffer.from(text).toString('base64')}`;
          this.onloadend?.();
        }, error => this.onerror?.(error));
      }
    },
    console: { warn() {}, error() {}, log() {} },
    currentUiLanguage: options.language || 'en',
    navigator: {
      userAgent: options.userAgent ?? ipadUA,
      maxTouchPoints: options.maxTouchPoints ?? 5,
      standalone: options.standalone ?? true,
      mediaDevices: {
        getUserMedia(settings) {
          microphoneRequests.push(settings);
          if (options.getUserMedia) return options.getUserMedia(microphoneRequests.length);
          const stream = makeStream();
          streams.push(stream);
          return Promise.resolve(stream);
        }
      }
    },
    matchMedia: query => ({ matches: query === '(display-mode: standalone)' && Boolean(options.displayModeStandalone) }),
    document: {
      readyState: 'loading',
      documentElement: { dir: 'ltr' },
      addEventListener() {},
      getElementById: id => settingsElements[id] || null,
      querySelectorAll: selector => selector === 'input[name="voice-scribe-engine"]' ? radios : []
    },
    addEventListener() {},
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value))
    },
    setTimeout: (callback, delay) => { const id = nextTimer++; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (callback, delay) => { const id = nextTimer++; timers.set(id, { callback, delay }); return id; },
    clearInterval: id => timers.delete(id),
    getActivePatient: () => ({ id: 'synthetic-test-patient' }),
    dentalOperations: [],
    fetch: () => { throw new Error('Tests must provide a fake fetch; network access is prohibited'); },
    showToast: (...args) => toasts.push(args),
    MediaRecorder: FakeMediaRecorder,
    __recordProcessedBlob: blob => processed.push(blob),
    __recordUIState: state => uiStates.push(state)
  };
  if (options.speechSupported !== false) sandbox.webkitSpeechRecognition = function FakeSpeechRecognition() {};
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(voiceSource, context, { filename: 'index.html:voice' });
  const realProcessBlob = context.processLuminVoiceBlob;
  vm.runInContext(`
    getLuminGeminiApiKey = async () => 'synthetic-test-key';
    updateVoiceAssistantUI = state => __recordUIState(state);
    processLuminVoiceBlob = async blob => {
      luminVoiceProcessingActive = true;
      __recordProcessedBlob(blob);
      await Promise.resolve();
      luminVoiceProcessingActive = false;
      updateVoiceAssistantUI('idle');
    };
  `, context);

  return {
    context, storage, streams, recorders, microphoneRequests, processed, uiStates, toasts, radios, deviceBadge, modeBadge, settingsElements, realProcessBlob,
    run: code => vm.runInContext(code, context),
    state: () => vm.runInContext('({ starting: luminVoiceStarting, recording: luminVoiceRecordingActive, processing: luminVoiceProcessingActive, recorder: luminVoiceRecorder })', context),
    async begin() {
      await context.startLuminVoiceRecording();
      const recorder = recorders.at(-1);
      assert.ok(recorder, 'start acquires a MediaRecorder');
      recorder.emitStart();
      assert.equal(this.state().recording, true);
      return recorder;
    }
  };
}

test('STT defaults on every device and only an explicit cloud preference enables Cloud Audio', async t => {
  const cases = [
    ['installed iPad', {}, true, 'local'],
    ['installed iPad desktop identity', { userAgent: desktopIpadUA }, true, 'local'],
    ['installed iPhone', { userAgent: iphoneUA }, true, 'local'],
    ['standalone display mode', { standalone: false, displayModeStandalone: true }, true, 'local'],
    ['iPad browser tab', { standalone: false }, false, 'local'],
    ['desktop-identity iPad browser tab', { userAgent: desktopIpadUA, standalone: false }, false, 'local'],
    ['Mac app without touch', { userAgent: desktopIpadUA, maxTouchPoints: 0 }, false, 'local'],
    ['Windows touch app', { userAgent: windowsUA }, false, 'local'],
    ['Android app', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Tablet) AppleWebKit/537.36 Chrome/130.0.0.0' }, false, 'local'],
    ['browser with explicit cloud choice', { standalone: false, savedMode: 'cloud' }, false, 'cloud'],
    ['installed iPad with explicit cloud choice', { savedMode: 'cloud' }, true, 'cloud'],
    ['browser without speech recognition', { standalone: false, speechSupported: false }, false, 'local'],
    ['installed iPad with saved STT preference', { savedMode: 'local' }, true, 'local'],
    ['invalid preference', { savedMode: 'invalid' }, true, 'local']
  ];
  for (const [name, options, installedIOS, mode] of cases) {
    await t.test(name, () => {
      const h = harness({ savedMode: null, ...options });
      const savedBefore = h.storage.get('lumin_voice_engine_mode');
      assert.equal(h.context.isLuminInstalledIOSApp(), installedIOS);
      assert.equal(h.context.getLuminVoiceEngineMode(), mode);
      assert.equal(h.storage.get('lumin_voice_engine_mode'), savedBefore, 'effective mode does not rewrite preference');
    });
  }
});

test('installed iPad supports manually switching both ways and persists the selected mode', () => {
  const h = harness({ savedMode: null });
  h.context.syncVoiceEngineSettingsUI();
  assert.equal(h.radios[0].disabled, false);
  assert.equal(h.radios[0].checked, true);
  assert.equal(h.radios[1].checked, false);
  assert.match(h.modeBadge.title, /Browser STT active/);
  assert.equal(h.modeBadge['aria-label'], h.modeBadge.title);
  h.context.toggleVoiceScribeModeQuick();
  assert.equal(h.context.getLuminVoiceEngineMode(), 'cloud');
  assert.equal(h.storage.get('lumin_voice_engine_mode'), 'cloud');
  assert.equal(h.radios[1].checked, true);
  h.context.toggleVoiceScribeModeQuick();
  assert.equal(h.context.getLuminVoiceEngineMode(), 'local');
  assert.equal(h.storage.get('lumin_voice_engine_mode'), 'local');
  assert.equal(h.radios[0].checked, true);
});

test('choosing unsupported STT warns without selecting or persisting Cloud Audio', () => {
  const h = harness({ speechSupported: false });
  h.context.setLuminVoiceEngineMode('local');
  assert.equal(h.context.getLuminVoiceEngineMode(), 'local');
  assert.equal(h.storage.get('lumin_voice_engine_mode'), 'local');
  assert.match(h.toasts.at(-1)[0], /will not switch automatically/);
  assert.equal(h.toasts.at(-1)[1], 'warning');
  h.context.setLuminVoiceEngineMode('invalid');
  assert.equal(h.storage.get('lumin_voice_engine_mode'), 'local');
  assert.equal(h.microphoneRequests.length, 0);
});

test('English and Arabic settings explain browser-managed permissions and manual cloud choice', () => {
  for (const language of ['en', 'ar']) {
    const h = harness({ savedMode: null, language });
    h.context.syncVoiceEngineSettingsUI();
    const permission = h.settingsElements['settings-voice-permission-note'].textContent;
    const modeNote = h.settingsElements['settings-voice-mode-note'].textContent;
    assert.equal(permission, h.context.luminVoicePermissionNotice());
    assert.match(permission, language === 'ar' ? /لا يستطيع Lumin منع طلبات الإذن/ : /cannot suppress browser permission prompts/);
    assert.match(modeNote, language === 'ar' ? /لا يُستخدم إلا عند اختياره/ : /only when you select it/);
    assert.doesNotMatch(h.modeBadge.title, /On-Device/);
    assert.equal(h.radios[0].disabled, false);
  }
});

test('two sequential button dictations produce independent MP4 blobs and release each microphone', async () => {
  const h = harness();
  for (const text of ['synthetic first recording', 'synthetic second recording']) {
    const recorder = await h.begin();
    recorder.emitData(text);
    h.context.toggleLuminVoiceRecording();
    assert.equal(recorder.stopCalls, 1);
    await recorder.emitStop();
    assert.ok(recorder.stream.track.stops >= 1, 'microphone track released');
    assert.equal(h.state().starting, false);
    assert.equal(h.state().recording, false);
    assert.equal(h.state().recorder, null);
  }
  assert.equal(h.microphoneRequests.length, 2);
  assert.equal(h.processed.length, 2);
  assert.deepEqual(await Promise.all(h.processed.map(blob => blob.text())), ['synthetic first recording', 'synthetic second recording']);
  assert.ok(h.processed.every(blob => blob.type === 'audio/mp4'));
});

test('rapid stop/start taps wait for final data and cannot overlap recorder sessions', async () => {
  const h = harness();
  const first = await h.begin();
  first.emitData('first part');
  h.context.toggleLuminVoiceRecording();
  assert.equal(first.state, 'inactive');
  await h.context.startLuminVoiceRecording();
  h.context.toggleLuminVoiceRecording();
  h.context.toggleLuminVoiceRecording();
  await settle();
  assert.equal(h.microphoneRequests.length, 1, 'pending onstop keeps the start lock');
  assert.equal(first.stopCalls, 1, 'repeated taps do not stop twice');
  first.emitData(' final part');
  await first.emitStop();
  assert.equal(await h.processed[0].text(), 'first part final part');
  const second = await h.begin();
  assert.notEqual(first, second);
  second.emitData('second recording');
  h.context.stopLuminVoiceRecording();
  await second.emitStop();
  assert.deepEqual(await Promise.all(h.processed.map(blob => blob.text())), ['first part final part', 'second recording']);
});

test('cancelling pending microphone permission releases a late stream without touching a new recording', async () => {
  const permission = deferred();
  const oldStream = makeStream();
  const newStream = makeStream();
  const h = harness({ getUserMedia: call => call === 1 ? permission.promise : Promise.resolve(newStream) });
  const firstStart = h.context.startLuminVoiceRecording();
  await settle();
  assert.equal(h.microphoneRequests.length, 1);
  h.context.cancelLuminVoiceProcessing();
  const second = await h.begin();
  permission.resolve(oldStream);
  await firstStart;
  assert.ok(oldStream.track.stops >= 1);
  assert.equal(newStream.track.stops, 0);
  assert.equal(h.state().recording, true);
  assert.equal(h.state().recorder, second);
  assert.equal(h.recorders.length, 1);
  second.emitData('replacement recording');
  h.context.stopLuminVoiceRecording();
  await second.emitStop();
  assert.equal(h.processed.length, 1);
});

test('a stale microphone permission rejection cannot clear a new recording or show an error', async () => {
  const permission = deferred();
  const newStream = makeStream();
  const h = harness({ getUserMedia: call => call === 1 ? permission.promise : Promise.resolve(newStream) });
  const firstStart = h.context.startLuminVoiceRecording();
  await settle();
  h.context.cancelLuminVoiceProcessing();
  const second = await h.begin();
  const toastsBefore = h.toasts.length;
  const updatesBefore = h.uiStates.length;
  permission.reject(new Error('Late permission rejection'));
  await firstStart;
  assert.equal(h.state().recording, true);
  assert.equal(h.state().recorder, second);
  assert.equal(newStream.track.stops, 0);
  assert.equal(h.toasts.length, toastsBefore);
  assert.equal(h.uiStates.length, updatesBefore);
  h.context.cancelLuminVoiceProcessing();
  await second.emitStop();
});

test('cancelled recorder callbacks and late data cannot process audio or overwrite a new recording', async () => {
  const h = harness();
  const first = await h.begin();
  first.emitData('discard this recording');
  const oldStart = first.onstart;
  const oldData = first.ondataavailable;
  const oldStop = first.onstop;
  h.context.cancelLuminVoiceProcessing();
  assert.ok(first.stream.track.stops >= 1, 'cancel immediately releases capture');
  const second = await h.begin();
  oldStart?.();
  oldData?.({ data: new Blob([' discard late chunk']) });
  await oldStop?.();
  await settle();
  assert.equal(h.processed.length, 0);
  assert.equal(h.state().recording, true);
  assert.equal(h.state().recorder, second);
  assert.equal(second.stream.track.stops, 0);
  second.emitData('only this recording');
  h.context.stopLuminVoiceRecording();
  await second.emitStop();
  assert.equal(h.processed.length, 1);
  assert.equal(await h.processed[0].text(), 'only this recording');
});

test('recorder construction and start failures release the acquired microphone', async t => {
  for (const option of ['recorderConstructorError', 'recorderStartError']) {
    await t.test(option, async () => {
      const h = harness({ [option]: new Error('Recorder unavailable') });
      await h.context.startLuminVoiceRecording();
      assert.equal(h.streams.length, 1);
      assert.ok(h.streams[0].track.stops >= 1);
      assert.equal(h.state().starting, false);
      assert.equal(h.state().recording, false);
      assert.equal(h.state().recorder, null);
      assert.equal(h.processed.length, 0);
    });
  }
});

test('recorder errors release capture and discard queued error-stop data', async () => {
  const h = harness();
  const recorder = await h.begin();
  recorder.emitData('incomplete recording');
  recorder.emitError();
  assert.ok(recorder.stream.track.stops >= 1);
  recorder.emitData('late error chunk');
  await recorder.emitStop();
  assert.equal(h.processed.length, 0);
  assert.equal(h.state().recording, false);
  assert.equal(h.state().starting, false);
  assert.equal(h.state().recorder, null);
});

function fakeResponse(label) {
  return {
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ syntheticLabel: label, actions: [] }) }] } }] })
  };
}

test('cancelling analysis aborts the request without trying another model', async () => {
  const h = harness();
  const controller = new AbortController();
  let requests = 0;
  let requestSignal;
  h.context.fetch = (_url, settings) => {
    requests += 1;
    requestSignal = settings.signal;
    return new Promise((_resolve, reject) => {
      settings.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    });
  };
  const pending = h.context.fetchGeminiVoiceWithFallback('synthetic-test-key', {}, controller.signal);
  assert.equal(requests, 1);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(requestSignal.aborted, true);
  assert.equal(requests, 1, 'cancellation must not initiate model fallback');
  await assert.rejects(h.context.fetchGeminiVoiceWithFallback('synthetic-test-key', {}, controller.signal), { name: 'AbortError' });
  assert.equal(requests, 1, 'already-cancelled analysis cannot start a request');
});

test('cancelled results cannot apply actions or clear a newer analysis', async t => {
  for (const inputType of ['audio', 'text']) {
    await t.test(inputType, async () => {
      const h = harness();
      const requests = [];
      const applied = [];
      h.context.fetch = () => {
        // Intentionally ignore abort to simulate a response already in flight.
        const response = deferred();
        requests.push(response);
        return response.promise;
      };
      h.context.executeVoiceChartActions = async payload => applied.push(payload.syntheticLabel);
      const process = label => inputType === 'audio'
        ? h.realProcessBlob(new Blob([label], { type: 'audio/mp4' }))
        : h.context.processLuminVoiceText(label);
      const first = process('cancelled analysis');
      await settle();
      assert.equal(requests.length, 1);
      h.context.cancelLuminVoiceProcessing();
      const second = process('current analysis');
      await settle();
      assert.equal(requests.length, 2);
      const currentController = h.run('luminVoiceProcessingAbortController');
      requests[0].resolve(fakeResponse('cancelled analysis'));
      await first;
      assert.deepEqual(applied, []);
      assert.equal(h.state().processing, true);
      assert.equal(h.run('luminVoiceProcessingAbortController'), currentController);
      requests[1].resolve(fakeResponse('current analysis'));
      await second;
      assert.deepEqual(applied, ['current analysis']);
      assert.equal(h.state().processing, false);
      assert.equal(h.run('luminVoiceProcessingAbortController'), null);
    });
  }
});

test('changing patients during analysis prevents applying the previous patient command', async t => {
  for (const inputType of ['audio', 'text']) {
    await t.test(inputType, async () => {
      const h = harness();
      const response = deferred();
      let applied = false;
      h.context.fetch = () => response.promise;
      h.context.executeVoiceChartActions = async () => { applied = true; };
      const pending = inputType === 'audio'
        ? h.realProcessBlob(new Blob(['synthetic recording'], { type: 'audio/mp4' }))
        : h.context.processLuminVoiceText('synthetic transcript');
      await settle();
      h.context.getActivePatient = () => ({ id: 'different-synthetic-patient' });
      response.resolve(fakeResponse('old patient command'));
      await pending;
      assert.equal(applied, false);
      assert.equal(h.state().processing, false);
      assert.ok(h.toasts.some(([message]) => /patient changed/i.test(message)));
    });
  }
});

test('changing patients during recording prevents uploading or applying the old command', async () => {
  const h = harness();
  let requests = 0;
  let applied = false;
  h.context.processLuminVoiceBlob = h.realProcessBlob;
  h.context.fetch = async () => { requests += 1; return fakeResponse('old command'); };
  h.context.executeVoiceChartActions = async () => { applied = true; };
  const recorder = await h.begin();
  recorder.emitData('synthetic old patient recording');
  h.context.getActivePatient = () => ({ id: 'different-synthetic-patient' });
  h.context.stopLuminVoiceRecording();
  await recorder.emitStop();
  assert.equal(requests, 0);
  assert.equal(applied, false);
  assert.equal(h.state().processing, false);
  assert.equal(h.streams[0].track.stops, 1);
  assert.ok(h.toasts.some(([message]) => /patient changed/i.test(message)));
});
