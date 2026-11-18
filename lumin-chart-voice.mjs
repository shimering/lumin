import { encodeWav } from './lumin-chart-voice-wav.mjs';
import { createVoiceActivityDetector } from './lumin-chart-voice-activity.mjs';

const surfaces = {
  mesial: ['Mesial', 'أنسي'], distal: ['Distal', 'بعيد'], occlusal: ['Occlusal', 'إطباقي'],
  buccal: ['Buccal', 'شدقي'], lingual: ['Lingual', 'لساني'], incisal: ['Incisal', 'قاطعي']
};
const statuses = {
  planned: ['Planned', 'مخطط', 'P'], in_progress: ['In progress', 'قيد التنفيذ', 'In'],
  completed: ['Completed', 'مكتمل', 'C'], existed: ['Existed', 'موجود سابقاً', 'E']
};
const presets = {
  composite: ['composite'], root_canal: ['rct'],
  crown: ['crown', 'ceramic_crown', 'zirconia_crown', 'temporary_crown'],
  extraction: ['missing', 'extraction_planned']
};

export function parseVoiceDraft(raw) {
  let draft;
  try { draft = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/gi, '')); }
  catch (_) { throw new Error('draft'); }
  if (typeof draft?.heard !== 'string') throw new Error('draft');
  const heard = draft.heard.slice(0, 2000);
  if (draft.action === 'clarify' && typeof draft.message === 'string' && draft.message.trim()) {
    return { heard, message: draft.message.slice(0, 500) };
  }
  if (draft.action !== 'add_procedure' || !Array.isArray(draft.operations) || !draft.operations.length
      || draft.operations.length > 8 || !draft.operations.every(op =>
        typeof op?.tooth === 'string' && /^(UR|UL|LR|LL)[1-8]$/.test(op.tooth)
        && typeof op.procedure === 'string' && Object.hasOwn(presets, op.procedure)
        && (op.status === '' || typeof op.status === 'string' && Object.hasOwn(statuses, op.status))
        && Array.isArray(op.surfaces) && op.surfaces.length <= 6
        && op.surfaces.every(s => typeof s === 'string' && Object.hasOwn(surfaces, s)))) throw new Error('draft');
  return { heard, operations: draft.operations.map(({ tooth, procedure, status, surfaces }) => ({
    tooth, procedure, status, surfaces: [...new Set(surfaces)]
  })) };
}

export function voiceCatalogOptions(procedure, catalog) {
  const scope = procedure === 'composite' ? 'surface' : 'whole';
  return catalog.filter(op => op.active && op.actionScope === scope && presets[procedure]?.includes(op.visualCode)
    && !op.isOrthoPackage && !op.isImplantProcedure && !op.trackImplantProgress);
}

async function readDraft(response) {
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || 'unavailable');
  const stream = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '', raw = '', complete = false;
  try {
    while (!complete) {
      const { value, done } = await stream.read();
      if (done) break;
      const lines = (pending + value).split('\n');
      pending = lines.pop();
      for (const line of lines.filter(line => line.trim())) {
        const event = JSON.parse(line);
        if (event.error) throw new Error('unavailable');
        if (typeof event.text === 'string') raw += event.text;
        if (event.done === true) complete = true;
      }
      if (raw.length + pending.length > 20000) throw new Error('draft');
    }
    if (!complete) throw new Error('unavailable');
    return parseVoiceDraft(raw);
  } finally {
    await stream.cancel().catch(() => {});
  }
}

const messages = {
  access: ['Sign in again with chart access.', 'سجّل الدخول مرة أخرى بحساب لديه صلاحية المخطط.'],
  unconfigured: ['Online Gemma is not configured for Lumin yet.', 'لم يُفعّل Gemma عبر الإنترنت في Lumin بعد.'],
  unavailable: ['Gemma is unavailable. Try again shortly.', 'Gemma غير متاح. حاول مرة أخرى بعد قليل.'],
  busy: ['Gemma is busy. Try again shortly.', 'Gemma مشغول. حاول مرة أخرى بعد قليل.'],
  input: ['Enter a short command or record it again.', 'اكتب أمراً قصيراً أو أعد تسجيله.'],
  draft: ['Gemma could not interpret the full command. Try one tooth and procedure at a time.', 'تعذّر فهم الأمر بالكامل. جرّب ذكر سن وإجراء واحد في كل مرة.']
};

export function bindChartVoice(root, { context, catalog, token, apply, language, surfaceNames, fetcher = fetch }) {
  const panel = root.querySelector('[data-voice-panel]');
  const open = root.querySelector('[data-voice-open]');
  const form = root.querySelector('[data-voice-command]');
  const input = form.elements.command;
  const record = root.querySelector('[data-voice-record]');
  const status = root.querySelector('[data-voice-status]');
  const heard = root.querySelector('[data-voice-heard]');
  const review = root.querySelector('[data-voice-review]');
  const add = root.querySelector('[data-voice-add]');
  const rows = root.querySelector('[data-voice-rows]');
  let owner, work, recording, draft = [];
  let saving = false;
  const tr = ([en, ar]) => language() === 'ar' ? ar : en;
  const tell = (en, ar) => { status.textContent = tr([en, ar]); };
  const valid = () => owner && owner === context();

  function translate() {
    panel.dir = language() === 'ar' ? 'rtl' : 'ltr';
    for (const label of root.querySelectorAll('[data-en]')) label.textContent = tr([label.dataset.en, label.dataset.ar]);
    input.placeholder = tr(['Plan an occlusal composite on upper right six', 'خطط لحشو كومبوزيت إطباقي للسن السادس فوق يمين']);
  }

  function controls() {
    record.textContent = recording
      ? tr(['Stop recording', 'إيقاف التسجيل']) : tr(['Record command', 'تسجيل أمر']);
    record.disabled = Boolean(work && !recording);
    input.disabled = form.elements.interpret.disabled = Boolean(work);
    open.disabled = !context() || saving;
    for (const field of rows.querySelectorAll('select, input')) field.disabled = saving;
    add.disabled = Boolean(work) || !draft.length || draft.some(row => !row.read());
    review.hidden = draft.length === 0;
  }

  function clearDraft() {
    draft = [];
    rows.replaceChildren();
    heard.textContent = '';
    heard.hidden = true;
    controls();
  }

  function release(input) {
    clearTimeout(input.timer);
    input.stream?.getTracks().forEach(track => track.stop());
    input.node?.disconnect();
    if (input.audio.state !== 'closed') void input.audio.close().catch(() => {});
  }

  function stopCapture() {
    const active = recording;
    recording = null;
    if (active) release(active);
  }

  function close(restoreFocus = false) {
    owner = undefined;
    work?.abort();
    work = null;
    stopCapture();
    panel.hidden = true;
    open.setAttribute('aria-expanded', 'false');
    input.value = status.textContent = '';
    clearDraft();
    if (restoreFocus) open.focus();
  }

  function field(en, ar, options, initial, holder) {
    const label = document.createElement('label');
    label.textContent = tr([en, ar]);
    const select = document.createElement('select');
    select.append(new Option(tr(['Choose…', 'اختر…']), ''));
    for (const [value, text] of options) select.append(new Option(text, value));
    select.value = initial || '';
    select.addEventListener('change', controls);
    label.append(select);
    holder.append(label);
    return select;
  }

  function showDraft(operations) {
    const catalogItems = catalog();
    draft = operations.map(op => {
      const row = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = op.tooth;
      title.dir = 'ltr';
      row.append(title);
      const choices = voiceCatalogOptions(op.procedure, catalogItems);
      const procedure = field('Procedure', 'الإجراء', choices.map(item => [item.id, item.name]),
        choices.length === 1 ? choices[0].id : '', row);
      const state = field('Status', 'الحالة', Object.values(statuses).map(s => [s[2], tr(s)]), statuses[op.status]?.[2], row);
      const supported = surfaceNames(op.tooth);
      const selected = new Map();
      if (op.procedure === 'composite') {
        const group = document.createElement('fieldset');
        const legend = document.createElement('legend');
        legend.textContent = tr(['Surfaces', 'الأسطح']);
        group.append(legend);
        for (const name of supported) {
          const label = document.createElement('label');
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.checked = op.surfaces.every(surface => supported.includes(surface)) && op.surfaces.includes(name);
          checkbox.addEventListener('change', controls);
          selected.set(name, checkbox);
          label.append(checkbox, tr(surfaces[name]));
          group.append(label);
        }
        row.append(group);
      }
      const issue = !supported.length
        ? tr(['This permanent tooth is outside the current dentition.', 'هذا السن الدائم غير موجود في التسنين الحالي.'])
        : !choices.length
          ? tr(['No matching procedure is active in the chart catalog.', 'لا يوجد إجراء مطابق ومفعّل في دليل المخطط.'])
          : op.surfaces.some(surface => op.procedure !== 'composite' || !selected.has(surface))
            ? tr(['Review the surfaces in the command before adding this procedure.', 'راجع الأسطح المذكورة في الأمر قبل إضافة الإجراء.']) : '';
      if (issue) {
        const note = document.createElement('p');
        note.textContent = issue;
        row.append(note);
      }
      rows.append(row);
      return {
        read() {
          const chosen = [...selected].filter(([, checkbox]) => checkbox.checked).map(([name]) => name);
          if (!procedure.value || !state.value || !supported.length || (op.procedure === 'composite' && !chosen.length)
              || (op.procedure !== 'composite' && op.surfaces.length)) return null;
          return { tooth: op.tooth, type: op.procedure, operationId: procedure.value, status: state.value, surfaces: chosen };
        }
      };
    });
    tell('Review the procedures before adding them.', 'راجع الإجراءات قبل إضافتها.');
    controls();
  }

  async function submit(command) {
    if (work || !valid()) return;
    clearDraft();
    const controller = work = new AbortController();
    tell('Gemma is interpreting the command…', 'يفسّر Gemma الأمر…');
    controls();
    try {
      const authorization = await token();
      if (!authorization) throw new Error('access');
      if (!valid() || controller.signal.aborted) return;
      const response = await fetcher('/api/chart-voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + authorization },
        body: JSON.stringify(command),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)])
      });
      const result = await readDraft(response);
      if (!valid() || controller.signal.aborted) return;
      heard.textContent = result.heard;
      heard.hidden = !result.heard;
      if (result.message) status.textContent = result.message;
      else showDraft(result.operations);
    } catch (error) {
      if (!valid() || controller.signal.aborted) return;
      status.textContent = tr(Object.hasOwn(messages, error.message) ? messages[error.message] : messages.unavailable);
    } finally {
      if (work === controller) { work = null; controls(); }
    }
  }

  async function finish(input) {
    if (recording !== input) return;
    recording = null;
    clearTimeout(input.timer);
    const controller = work;
    controls();
    try {
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 180);
        input.flush = () => { clearTimeout(timer); resolve(); };
        input.node.port.postMessage('flush');
      });
      const rate = input.audio.sampleRate;
      const limit = input.lastVoice ? input.lastVoice + Math.round(.45 * rate) : undefined;
      const wav = encodeWav(input.chunks, rate, Math.min(15 * rate, limit ?? Infinity));
      if (!valid() || controller.signal.aborted) return;
      if (wav.seconds < .2 || wav.peak < .004) {
        tell('No clear audio. Try recording again.', 'الصوت غير واضح. جرّب التسجيل مرة أخرى.');
        return;
      }
      const bytes = new Uint8Array(await wav.blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      if (controller.signal.aborted || !valid()) return;
      work = null;
      return void submit({ audio: btoa(binary) });
    } catch (_) {
      if (valid() && !controller.signal.aborted) tell('Recording interrupted. Try again.', 'انقطع التسجيل. حاول مرة أخرى.');
    } finally {
      release(input);
      if (work === controller) { work = null; controls(); }
    }
  }

  async function start() {
    if (work || !valid()) return;
    clearDraft();
    if (!window.AudioContext || !navigator.mediaDevices?.getUserMedia) {
      tell('Microphone recording requires a supported browser on HTTPS. You can type the command.', 'يتطلب التسجيل متصفحاً يدعم الميكروفون عبر HTTPS. يمكنك كتابة الأمر.');
      return;
    }
    const controller = work = new AbortController();
    let active;
    tell('Waiting for microphone access…', 'في انتظار إذن الميكروفون…');
    controls();
    try {
      active = { audio: new AudioContext(), chunks: [] };
      const resume = active.audio.resume();
      void resume.catch(() => {});
      controller.signal.addEventListener('abort', () => release(active), { once: true });
      active.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      if (!valid() || controller.signal.aborted || document.hidden) return;
      await resume;
      await active.audio.audioWorklet.addModule('/lumin-chart-voice-worklet.js');
      if (!valid() || controller.signal.aborted || document.hidden) return;
      const detect = createVoiceActivityDetector(active.audio.sampleRate);
      const source = active.audio.createMediaStreamSource(active.stream);
      active.node = new AudioWorkletNode(active.audio, 'voice-capture');
      active.node.port.onmessage = ({ data }) => {
        if (data === 'flushed') { active.flush?.(); return; }
        active.chunks.push(data);
        const activity = detect(data);
        if (activity.shouldStop && recording === active) {
          active.lastVoice = activity.lastVoiceSample;
          void finish(active);
        }
      };
      active.stream.getAudioTracks()[0].addEventListener('ended', () => {
        if (recording === active) {
          controller.abort();
          stopCapture();
          work = null;
          tell('Recording interrupted. Try again.', 'انقطع التسجيل. حاول مرة أخرى.');
          controls();
        }
      }, { once: true });
      source.connect(active.node).connect(active.audio.destination);
      recording = active;
      active.timer = setTimeout(() => void finish(active), 15000);
      tell('Recording. Stops after three seconds of silence.', 'جارٍ التسجيل. يتوقف بعد ثلاث ثوانٍ من الصمت.');
    } catch (_) {
      if (valid() && !controller.signal.aborted) {
        tell('Could not start the microphone. Check this site’s microphone permission or type the command.',
          'تعذّر تشغيل الميكروفون. تحقّق من إذن الموقع أو اكتب الأمر.');
      }
    } finally {
      if (!active || recording !== active) {
        if (active) release(active);
        if (work === controller) work = null;
      }
      controls();
    }
  }

  open.addEventListener('click', () => {
    if (!panel.hidden) { close(true); return; }
    owner = context();
    if (!owner) return;
    translate();
    panel.hidden = false;
    open.setAttribute('aria-expanded', 'true');
    input.focus();
  });
  root.querySelector('[data-voice-close]').onclick = () => close(true);
  record.onclick = () => recording ? void finish(recording) : void start();
  form.onsubmit = event => {
    event.preventDefault();
    if (input.value.trim()) void submit({ prompt: input.value.trim() });
  };
  review.onsubmit = async event => {
    event.preventDefault();
    if (work || !valid()) return;
    const entries = draft.map(row => row.read());
    if (!entries.length || entries.some(entry => !entry)) return;
    const controller = work = new AbortController();
    saving = true;
    controls();
    tell('Saving chart procedures…', 'جارٍ حفظ إجراءات المخطط…');
    try {
      if (!await apply(entries, owner)) throw new Error('save');
      if (!valid() || controller.signal.aborted) return;
      clearDraft();
      input.value = '';
      tell('Procedures added to the chart.', 'أُضيفت الإجراءات إلى المخطط.');
    } catch (_) {
      if (valid() && !controller.signal.aborted) tell('Could not save these procedures. Review the chart and try again.',
        'تعذّر حفظ الإجراءات. راجع المخطط وحاول مرة أخرى.');
    } finally {
      saving = false;
      if (work === controller) work = null;
      controls();
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && recording) {
      work?.abort();
      stopCapture();
      work = null;
      tell('Recording interrupted. Try again.', 'انقطع التسجيل. حاول مرة أخرى.');
      controls();
    }
  });
  window.addEventListener('pagehide', () => close());
  translate();
  controls();
  return { sync() {
    open.disabled = !context() || saving;
    if (!panel.hidden && !valid()) close();
    if (panel.hidden) translate();
  } };
}
