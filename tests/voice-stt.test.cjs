const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// These tests execute the shipped STT lifecycle with deliberately controllable
// browser events. They do not access a real microphone, credentials, cloud
// service, or patient records, and do not claim to reproduce iPad hardware.
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const startMarker = '// ================= CHAIRSIDE VOICE CONTROL AI AGENT =================';
const endMarker = '// ================= APPOINTMENTS CALENDAR =================';
const blockStart = html.indexOf(startMarker);
const blockEnd = html.indexOf(endMarker, blockStart);
assert.ok(blockStart >= 0 && blockEnd > blockStart, 'voice implementation markers exist');
const voiceSource = html.slice(blockStart, blockEnd);

const ipadUA = 'Mozilla/5.0 (iPad; CPU OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Version/27.0 Mobile/15E148 Safari/604.1';
const desktopIpadUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/27.0 Safari/605.1.15';
const edgeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeStream() {
  const track = { stops: 0, stop() { this.stops += 1; } };
  return { track, getTracks: () => [track], getAudioTracks: () => [track] };
}

async function settle() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function harness(options = {}) {
  const storage = new Map();
  if (options.savedMode) storage.set('lumin_voice_engine_mode', options.savedMode);
  const streams = [];
  const recognizers = [];
  const microphoneRequests = [];
  const processed = [];
  const uiStates = [];
  const toasts = [];
  const timers = new Map();
  const listeners = new Map();
  const audioSessionChanges = [];
  const radios = [{ value: 'local', disabled: false }, { value: 'cloud', disabled: false }];
  let clock = 100000;
  let nextTimer = 1;
  let audioSessionType = 'auto';
  let keyRequests = 0;
  let cloudStarts = 0;
  let patientId = 'synthetic-test-patient';

  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }

  function addListener(name, callback) {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(callback);
  }

  class FakeSpeechRecognition {
    constructor() {
      if (options.constructorError) throw options.constructorError;
      this.starts = 0;
      this.stops = 0;
      this.aborts = 0;
      recognizers.push(this);
    }
    start() {
      this.starts += 1;
      if (options.startError) throw options.startError;
    }
    stop() { this.stops += 1; }
    abort() { this.aborts += 1; }
    emitStart() { this.onstart?.(); }
    emitAudioStart() { this.onaudiostart?.(); }
    emitSoundStart() { this.onsoundstart?.(); }
    emitResult(text, final = true) {
      const result = [{ transcript: text, confidence: 0.9 }];
      result.isFinal = final;
      this.onresult?.({ resultIndex: 0, results: [result] });
    }
    emitError(error) { this.onerror?.({ error }); }
    async emitEnd() { await this.onend?.(); await settle(); }
  }

  const audioSession = {};
  Object.defineProperty(audioSession, 'type', {
    get() { return audioSessionType; },
    set(value) {
      audioSessionChanges.push(value);
      if (options.audioSessionError) throw options.audioSessionError;
      audioSessionType = value;
    }
  });

  const sandbox = {
    AbortController,
    DOMException,
    Blob,
    Date: FakeDate,
    console: { warn() {}, error() {}, log() {} },
    currentUiLanguage: options.language || 'en',
    navigator: {
      userAgent: options.userAgent ?? ipadUA,
      platform: options.platform ?? 'iPad',
      maxTouchPoints: options.maxTouchPoints ?? 5,
      standalone: options.standalone ?? true,
      ...(options.audioSessionSupported === false ? {} : { audioSession }),
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
      visibilityState: 'visible',
      hidden: false,
      documentElement: { dir: options.language === 'ar' ? 'rtl' : 'ltr' },
      addEventListener: addListener,
      getElementById: () => null,
      querySelectorAll: selector => selector === 'input[name="voice-scribe-engine"]' ? radios : []
    },
    addEventListener: addListener,
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value))
    },
    setTimeout(callback, delay = 0) {
      const id = nextTimer++;
      timers.set(id, { callback, delay, deadline: clock + Number(delay) });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    setInterval() { throw new Error('Unexpected interval in STT lifecycle'); },
    clearInterval: id => timers.delete(id),
    getActivePatient: () => patientId ? { id: patientId } : null,
    dentalOperations: [],
    fetch() { throw new Error('STT lifecycle tests must not use network'); },
    showToast: (...args) => toasts.push(args),
    showGeminiApiKeyModal() {},
    MediaRecorder: class ForbiddenAudioRecorder {
      constructor() { throw new Error('Local STT must not create an audio recorder'); }
    },
    __recordProcessedText: (text, id) => processed.push({ text, patientId: id }),
    __recordUIState: state => uiStates.push(state),
    __getKey: () => { keyRequests += 1; return options.keyPromise || Promise.resolve('synthetic-test-key'); },
    __recordCloudStart: () => { cloudStarts += 1; }
  };
  if (options.speechSupported !== false) sandbox.webkitSpeechRecognition = FakeSpeechRecognition;
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(voiceSource, context, { filename: 'index.html:voice' });
  vm.runInContext(`
    getLuminGeminiApiKey = () => __getKey();
    updateVoiceAssistantUI = state => __recordUIState(state);
    processLuminVoiceText = async (text, patientId) => {
      __recordProcessedText(text, patientId);
      updateVoiceAssistantUI('idle');
    };
    startLuminVoiceAudioRecording = async () => __recordCloudStart();
    processLuminVoiceBlob = async () => { throw new Error('Local STT must not upload audio'); };
  `, context);

  return {
    context, storage, streams, recognizers, microphoneRequests, processed, uiStates, toasts, timers, radios, audioSessionChanges,
    run: code => vm.runInContext(code, context),
    state: () => vm.runInContext('({ starting: luminVoiceStarting, recording: luminVoiceRecordingActive, processing: luminVoiceProcessingActive })', context),
    get keyRequests() { return keyRequests; },
    get cloudStarts() { return cloudStarts; },
    get audioSessionType() { return audioSessionType; },
    setPatient(id) { patientId = id; },
    emit(name, event = {}) { for (const listener of listeners.get(name) || []) listener(event); },
    async advance(milliseconds) {
      const target = clock + milliseconds;
      for (let guard = 0; guard < 100; guard += 1) {
        const next = [...timers.entries()].filter(([, timer]) => timer.deadline <= target)
          .sort((a, b) => a[1].deadline - b[1].deadline || a[0] - b[0])[0];
        if (!next) { clock = target; await settle(); return; }
        clock = next[1].deadline;
        timers.delete(next[0]);
        next[1].callback();
        await settle();
      }
      throw new Error('Unexpected timer loop');
    },
    async begin() {
      await context.startLuminVoiceRecording();
      await settle();
      const recognition = recognizers.at(-1);
      assert.ok(recognition, 'STT starts a browser speech recognizer');
      assert.equal(recognition.starts, 1);
      recognition.emitStart();
      recognition.emitAudioStart();
      assert.equal(this.state().recording, true);
      return recognition;
    }
  };
}

test('STT is the default on iPad apps, Safari tabs, desktop-identity iPads, and Windows Edge', async t => {
  for (const [name, options] of [
    ['installed iPad', {}],
    ['Safari iPad tab', { standalone: false }],
    ['desktop-identity installed iPad', { userAgent: desktopIpadUA, platform: 'MacIntel' }],
    ['Windows Edge', { userAgent: edgeUA, platform: 'Win32', maxTouchPoints: 0, standalone: false }]
  ]) {
    await t.test(name, () => {
      const h = harness(options);
      assert.equal(h.context.getLuminVoiceEngineMode(), 'local');
      h.context.syncVoiceEngineSettingsUI();
      assert.equal(h.radios[0].disabled, false);
      assert.equal(h.radios[0].checked, true);
      h.context.setLuminVoiceEngineMode('cloud');
      assert.equal(h.context.getLuminVoiceEngineMode(), 'cloud');
      h.context.setLuminVoiceEngineMode('local');
      assert.equal(h.context.getLuminVoiceEngineMode(), 'local');
    });
  }
});

test('voice tooth normalization handles primary Palmer letters and deciduous FDI numbers', () => {
  const h = harness();
  for (const [spoken, universal] of [
    ['upper right A', 'A'], ['UR D', 'D'], ['deciduous upper right D', 'D'],
    ['upper left F', 'F'], ['lower left M', 'M'], ['lower right T', 'T'],
    ['55', 'A'], ['54', 'B'], ['52', 'D'], ['61', 'F'], ['75', 'K'], ['85', 'T']
  ]) {
    assert.equal(h.context.resolveVoiceToothUniversal(spoken), universal, spoken);
  }
});

test('an explicit Cloud Audio preference is preserved and is the only cloud start path', async () => {
  const h = harness({ savedMode: 'cloud' });
  assert.equal(h.context.getLuminVoiceEngineMode(), 'cloud');
  await h.context.startLuminVoiceRecording();
  assert.equal(h.cloudStarts, 1);
  assert.equal(h.recognizers.length, 0);
});

test('Windows starts STT in the tap without waiting for a Gemini key or requesting an extra capture stream', async () => {
  const key = deferred();
  const h = harness({ userAgent: edgeUA, platform: 'Win32', maxTouchPoints: 0, standalone: false, keyPromise: key.promise });
  const pending = h.context.startLuminVoiceRecording();
  assert.equal(h.recognizers.length, 1, 'recognition must start before losing user activation to an unrelated await');
  assert.equal(h.recognizers[0].starts, 1);
  assert.equal(h.microphoneRequests.length, 0, 'Edge does not need a second microphone permission surface');
  h.context.cancelLuminVoiceProcessing();
  key.resolve('synthetic-test-key');
  await pending;
});

test('one continuous iPad session sends separate final phrases after the button is turned off', async () => {
  const h = harness();
  const recognition = await h.begin();
  assert.equal(recognition.continuous, true);
  assert.equal(h.audioSessionType, 'play-and-record');
  assert.equal(h.streams.at(-1).track.stops, 0, 'guard capture stays active during recognition');
  recognition.emitResult('synthetic first command');
  recognition.emitResult('synthetic second command');
  h.context.stopLuminVoiceRecording();
  await recognition.emitEnd();
  await h.advance(1500);
  assert.equal(h.streams.at(-1).track.stops, 1);
  assert.equal(h.audioSessionType, 'auto');
  assert.equal(h.state().starting, false);
  assert.equal(h.state().recording, false);
  assert.equal(h.recognizers.length, 1);
  assert.equal(h.microphoneRequests.length, 1);
  assert.deepEqual(h.processed.map(item => item.text), ['synthetic first command', 'synthetic second command']);
  assert.equal(h.cloudStarts, 0);
});

test('an unexpected speech end restarts the same continuous recognizer while the button remains on', async () => {
  const h = harness();
  const recognition = await h.begin();
  await recognition.emitEnd();
  await settle();
  assert.equal(h.recognizers.length, 1);
  assert.equal(recognition.starts, 2);
  assert.equal(h.state().recording, true);
  h.context.stopLuminVoiceRecording();
  await recognition.emitEnd();
  await h.advance(1500);
  assert.equal(h.streams[0].track.stops, 1);
  assert.equal(h.state().recording, false);
});

test('iPad Safari tabs also acquire the local microphone guard', async () => {
  const h = harness({ standalone: false });
  await h.begin();
  assert.equal(h.microphoneRequests.length, 1);
  assert.equal(h.microphoneRequests[0].audio, true);
  h.context.cancelLuminVoiceProcessing();
  assert.equal(h.streams[0].track.stops, 1);
});

test('microphone permission can remain pending without starting any capture watchdog', async () => {
  const permission = deferred();
  const stream = makeStream();
  const h = harness({ getUserMedia: () => permission.promise });
  const pending = h.context.startLuminVoiceRecording();
  await settle();
  assert.equal(h.microphoneRequests.length, 1);
  assert.equal(h.recognizers.length, 1, 'speech recognition starts from the button gesture while the optional guard permission is pending');
  await h.advance(60000);
  assert.equal(h.state().starting, true, 'permission dialog is not mistaken for silent capture');
  assert.equal(h.cloudStarts, 0);
  assert.equal(h.toasts.length, 0);
  permission.resolve(stream);
  await pending;
  await settle();
  assert.equal(h.recognizers.length, 1);
  h.context.cancelLuminVoiceProcessing();
  assert.equal(stream.track.stops, 1);
});

test('manual stop cancels pending permission, and a late stream cannot damage a newer STT session', async () => {
  const permission = deferred();
  const oldStream = makeStream();
  const currentStream = makeStream();
  const h = harness({ getUserMedia: call => call === 1 ? permission.promise : Promise.resolve(currentStream) });
  const pending = h.context.startLuminVoiceRecording();
  await settle();
  h.context.stopLuminVoiceRecording();
  assert.equal(h.state().starting, false);
  const current = await h.begin();
  permission.resolve(oldStream);
  await pending;
  await settle();
  assert.equal(oldStream.track.stops, 1);
  assert.equal(currentStream.track.stops, 0);
  assert.equal(h.audioSessionType, 'play-and-record');
  assert.equal(h.recognizers.length, 2, 'the replacement command starts immediately; the cancelled permission cannot add another recognizer');
  assert.equal(h.state().recording, true);
  current.emitResult('only current command');
  h.context.stopLuminVoiceRecording();
  await current.emitEnd();
  await h.advance(1500);
  assert.deepEqual(h.processed.map(item => item.text), ['only current command']);
});

test('late permission rejection cannot clear a newer session, change audio routing, or show an error', async () => {
  const permission = deferred();
  const currentStream = makeStream();
  const h = harness({ getUserMedia: call => call === 1 ? permission.promise : Promise.resolve(currentStream) });
  const pending = h.context.startLuminVoiceRecording();
  await settle();
  h.context.cancelLuminVoiceProcessing();
  await h.begin();
  const toastCount = h.toasts.length;
  const uiCount = h.uiStates.length;
  permission.reject(new DOMException('Old request denied', 'NotAllowedError'));
  await pending;
  await settle();
  assert.equal(h.toasts.length, toastCount);
  assert.equal(h.uiStates.length, uiCount);
  assert.equal(h.state().recording, true);
  assert.equal(currentStream.track.stops, 0);
  assert.equal(h.audioSessionType, 'play-and-record');
  h.context.cancelLuminVoiceProcessing();
});

test('obsolete recognizer callbacks cannot process discarded speech or stop a newer capture', async () => {
  const h = harness();
  const first = await h.begin();
  const stale = { start: first.onstart, audio: first.onaudiostart, result: first.onresult, error: first.onerror, end: first.onend };
  first.emitResult('discard old command');
  h.context.cancelLuminVoiceProcessing();
  await h.advance(1000);
  const second = await h.begin();
  stale.start?.();
  stale.audio?.();
  const result = [{ transcript: 'discard late command' }];
  result.isFinal = true;
  stale.result?.({ resultIndex: 0, results: [result] });
  stale.error?.({ error: 'no-speech' });
  await stale.end?.();
  await settle();
  assert.equal(h.processed.length, 0);
  assert.equal(h.state().recording, true);
  assert.equal(h.streams[1].track.stops, 0);
  assert.equal(h.audioSessionType, 'play-and-record');
  second.emitResult('current command');
  h.context.stopLuminVoiceRecording();
  await second.emitEnd();
  await h.advance(1500);
  assert.deepEqual(h.processed.map(item => item.text), ['current command']);
});

test('no-speech and network events do not close a continuous session or switch to Cloud Audio', async () => {
  const h = harness();
  const recognition = await h.begin();
  recognition.emitError('no-speech');
  recognition.emitError('network');
  await settle();
  assert.equal(h.state().recording, true);
  assert.equal(h.cloudStarts, 0);
  assert.equal(h.context.getLuminVoiceEngineMode(), 'local');
  h.context.stopLuminVoiceRecording();
  await recognition.emitEnd();
  await h.advance(1500);
  assert.equal(h.processed.length, 0);
});

test('a cancelled silent-capture retry cannot reopen the microphone', async () => {
  const h = harness();
  const first = await h.begin();
  first.emitError('no-speech');
  await settle();
  h.context.stopLuminVoiceRecording();
  await h.advance(60000);
  assert.equal(h.recognizers.length, 1);
  assert.equal(h.microphoneRequests.length, 1);
  assert.equal(h.state().starting, false);
  assert.equal(h.cloudStarts, 0);
});

test('missing audio-start events trigger a bounded local retry without automatic Cloud Audio', async () => {
  const h = harness();
  await h.context.startLuminVoiceRecording();
  await settle();
  assert.equal(h.recognizers.length, 1);
  await h.advance(60000);
  assert.equal(h.recognizers.length, 2);
  assert.equal(h.microphoneRequests.length, 2);
  assert.ok(h.streams.every(stream => stream.track.stops === 1));
  assert.equal(h.cloudStarts, 0);
  assert.equal(h.state().starting, false);
  assert.equal(h.state().recording, false);
});

test('permission and network recognition failures never switch engines or start Cloud Audio', async t => {
  for (const error of ['not-allowed', 'service-not-allowed', 'network', 'audio-capture']) {
    await t.test(error, async () => {
      const h = harness();
      const recognition = await h.begin();
      recognition.emitError(error);
      await settle();
      if (error !== 'not-allowed' && error !== 'service-not-allowed') {
        h.context.stopLuminVoiceRecording();
        await recognition.emitEnd();
      }
      await h.advance(60000);
      assert.equal(h.cloudStarts, 0);
      assert.equal(h.context.getLuminVoiceEngineMode(), 'local');
      assert.ok(h.streams.every(stream => stream.track.stops === 1));
      assert.equal(h.audioSessionType, 'auto');
      assert.equal(h.processed.length, 0);
    });
  }
});

test('manual stop waits for the final result and end event before releasing capture and processing once', async () => {
  const h = harness();
  const recognition = await h.begin();
  recognition.emitResult('partial command', false);
  h.context.stopLuminVoiceRecording();
  assert.equal(recognition.stops, 1);
  assert.equal(h.processed.length, 0);
  recognition.emitResult('final command');
  await recognition.emitEnd();
  await h.advance(60000);
  assert.deepEqual(h.processed.map(item => item.text), ['final command']);
  assert.equal(h.recognizers.length, 1);
  assert.equal(h.streams[0].track.stops, 1);
});

test('a missing onend after manual stop is finalized within the release watchdog', async () => {
  const h = harness();
  const recognition = await h.begin();
  recognition.emitResult('synthetic captured command');
  h.context.stopLuminVoiceRecording();
  await h.advance(1500);
  assert.equal(h.streams[0].track.stops, 1);
  assert.ok(recognition.aborts >= 1);
  assert.deepEqual(h.processed.map(item => item.text), ['synthetic captured command']);
  assert.equal(h.state().starting, false);
  assert.equal(h.state().recording, false);
});

test('manual stop without a transcript does not restart the microphone', async () => {
  const h = harness();
  const recognition = await h.begin();
  h.context.stopLuminVoiceRecording();
  await recognition.emitEnd();
  await h.advance(60000);
  assert.equal(h.recognizers.length, 1);
  assert.equal(h.processed.length, 0);
  assert.equal(h.streams[0].track.stops, 1);
});

test('pagehide and background visibility cancel capture without processing or retry', async t => {
  for (const event of ['pagehide', 'visibilitychange']) {
    await t.test(event, async () => {
      const h = harness();
      h.emit('DOMContentLoaded');
      const recognition = await h.begin();
      recognition.emitResult('discard background command');
      if (event === 'visibilitychange') {
        h.context.document.hidden = true;
        h.context.document.visibilityState = 'hidden';
      }
      h.emit(event);
      await settle();
      await h.advance(60000);
      assert.equal(h.streams[0].track.stops, 1);
      assert.equal(h.audioSessionType, 'auto');
      assert.equal(h.processed.length, 0);
      assert.equal(h.recognizers.length, 1);
      assert.equal(h.state().recording, false);
    });
  }
});

test('changing patients during STT discards the captured command before text processing', async () => {
  const h = harness();
  const recognition = await h.begin();
  recognition.emitResult('old patient command');
  h.setPatient('different-synthetic-patient');
  h.context.stopLuminVoiceRecording();
  await recognition.emitEnd();
  assert.equal(h.processed.length, 0);
  assert.equal(h.streams[0].track.stops, 1);
  assert.equal(h.state().recording, false);
});

test('unavailable or throwing experimental audioSession routing does not prevent ordinary STT', async t => {
  for (const [name, options] of [
    ['unsupported', { audioSessionSupported: false }],
    ['throwing setter', { audioSessionError: new Error('Unsupported audio route') }]
  ]) {
    await t.test(name, async () => {
      const h = harness(options);
      const recognition = await h.begin();
      recognition.emitResult('synthetic command');
      h.context.stopLuminVoiceRecording();
      await recognition.emitEnd();
      await h.advance(1500);
      assert.deepEqual(h.processed.map(item => item.text), ['synthetic command']);
      assert.equal(h.streams[0].track.stops, 1);
      assert.equal(h.cloudStarts, 0);
    });
  }
});

test('speech language follows the bilingual UI', async t => {
  for (const language of ['en', 'ar']) {
    await t.test(language, async () => {
      const h = harness({ language });
      const recognition = await h.begin();
      assert.equal(recognition.lang, language === 'ar' ? 'ar-SA' : 'en-US');
      h.context.cancelLuminVoiceProcessing();
    });
  }
});
