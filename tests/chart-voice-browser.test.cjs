const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const panel = html.match(/<div id="chart-voice"[\s\S]*?(?=\s*<div class="space-y-3 p-3 md:p-4">)/)[0];
const fixture = `
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/lumin-chart-voice.css">
  ${panel}
  <script type="module">
    import { bindChartVoice } from '/lumin-chart-voice.mjs';
    import { modelBytes } from '/lumin-chart-voice-model.mjs';
    window.owner = 'patient';
    window.saved = [];
    window.spoken = [];
    window.reply = '';
    window.downloadAttempts = 0;
    window.frames = 0;
    let model = { supported: true, ready: false, bytes: 0, hasFiles: false };
    const command = JSON.stringify({ action:'add_procedure', heard:'Sample', operations:[
      { tooth:'UR6', procedure:'composite', status:'planned', surfaces:['occlusal'] }
    ] });
    const track = { addEventListener() {}, stop() {} };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () =>
      ({ getTracks:() => [track], getAudioTracks:() => [track] }) });
    window.AudioContext = class {
      sampleRate = 16000;
      destination = {};
      audioWorklet = { addModule: async () => {} };
      resume = async () => {};
      close = async () => { this.state = 'closed'; };
      createMediaStreamSource() { return { connect: node => node }; }
    };
    window.AudioWorkletNode = class {
      port = { postMessage: () => this.port.onmessage({ data:'flushed' }) };
      connect() {
        setTimeout(() => {
          this.port.onmessage({ data:new Float32Array(8000).fill(.2) });
          frames++;
        }, 0);
      }
      disconnect() {}
    };
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: class { constructor(text) { this.text = text; } } });
    Object.defineProperty(window, 'speechSynthesis', { value: {
      getVoices: () => [{ lang:'en-US', localService:true }],
      speak: utterance => { spoken.push(utterance.text); window.endSpeech = () => utterance.onend(); },
      cancel: () => {}
    } });
    const root = document.getElementById('chart-voice');
    root.hidden = false;
    window.chartVoice = bindChartVoice(root, {
      context: () => owner, language: () => 'en', surfaceNames: () => ['occlusal'],
      catalog: () => [{ id:'comp', name:'Composite Restoration', active:true, actionScope:'surface', visualCode:'composite' }],
      apply: async (entries, chart) => { saved.push({entries, chart}); return true; },
      engine: {
        info: async () => model,
        async loadRecorder() {},
        subscribe() {},
        async download({signal, report, acceptsSample}) {
          downloadAttempts++;
          model = { supported:true, ready:false, bytes:100, hasFiles:true };
          report('model', model.bytes);
          if (downloadAttempts === 1) await new Promise((_, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), {once:true}));
          if (!acceptsSample(command)) throw Error('sample');
          model = { ...model, bytes:modelBytes, ready:true };
        },
        async remove() { model = {supported:true, bytes:0, ready:false, hasFiles:false}; },
        async interpret({blob, confirmation}) {
          if (blob.type !== 'audio/wav' || blob.size < 44) throw Error('Invalid audio');
          return confirmation ? window.reply : command;
        }
      }
    });
  </script>
`;

test('voice charting manages storage and waits for an explicit spoken or manual confirmation', async t => {
  const browser = await chromium.launch({ channel: process.env.LUMIN_TEST_BROWSER_CHANNEL || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: {width: 360, height: 750} });
  await page.route('https://lumin.test/**', route => {
    const file = new URL(route.request().url()).pathname;
    if (file === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture });
    if (!/^\/lumin-chart-voice[\w.-]*\.(?:css|mjs)$/.test(file)) return route.fulfill({ status: 404 });
    return route.fulfill({
      contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript',
      path: path.join(root, file.slice(1))
    });
  });
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.goto('https://lumin.test/');
  await page.locator('[data-voice-open]').click();
  assert.equal(await page.locator('[data-voice-record]').isDisabled(), true);
  assert.equal(await page.evaluate(() => downloadAttempts), 0);
  await page.getByRole('button', { name: 'Download model · 2.4 GB' }).click();
  await page.getByRole('button', { name: 'Pause setup' }).click();
  await page.getByRole('button', { name: 'Resume download' }).click();
  await page.getByText('Model ready on this device', { exact: true }).waitFor();

  async function record(selector) {
    const count = await page.evaluate(() => frames);
    const button = page.locator(selector);
    await button.click();
    await page.waitForFunction(value => frames > value, count);
    await button.click();
  }

  await record('[data-voice-record]');
  await page.getByText('Reading the draft aloud…', { exact: true }).waitFor();
  assert.match(await page.evaluate(() => spoken[0]), /upper right 6, Composite Restoration, Planned, Occlusal/);
  assert.equal(await page.locator('[data-voice-reply]').isDisabled(), true);
  assert.equal(await page.evaluate(() => saved.length), 0);
  await page.evaluate(() => endSpeech());
  await page.evaluate(() => { window.reply = 'Yes, but not that tooth'; });
  await record('[data-voice-reply]');
  await page.getByText('Say only confirm or cancel, or use the button below.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => saved.length), 0);
  await page.evaluate(() => { window.reply = 'Cancel'; });
  await record('[data-voice-reply]');
  await page.getByText('Draft cancelled.', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-voice-review]').isVisible(), false);

  await record('[data-voice-record]');
  await page.getByText('Reading the draft aloud…', { exact: true }).waitFor();
  await page.evaluate(() => { endSpeech(); window.reply = 'Confirm'; });
  await record('[data-voice-reply]');
  await page.getByText('Procedures added to the chart.', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => saved), [{ chart: 'patient', entries: [
    { tooth: 'UR6', type: 'composite', operationId: 'comp', status: 'P', surfaces: ['occlusal'] }
  ] }]);

  await page.getByRole('checkbox', { name: 'Spoken confirmation' }).uncheck();
  await record('[data-voice-record]');
  await page.locator('[data-voice-review]').waitFor();
  assert.equal(await page.locator('[data-voice-reply]').isVisible(), false);
  assert.equal(await page.locator('[data-voice-add]').isEnabled(), true);
  assert.equal(await page.evaluate(() => saved.length), 1);
  await page.context().setOffline(true);
  await page.getByText('Reconnect to save this draft to the shared chart.', { exact:true }).waitFor();
  assert.equal(await page.locator('[data-voice-add]').isDisabled(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 360);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete model' }).click();
  await page.getByText('Model deleted from this device.', { exact:true }).waitFor();
  assert.equal(await page.locator('[data-voice-record]').isDisabled(), true);
  assert.deepEqual(failures, []);
});
