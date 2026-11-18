import { encodeWav } from './lumin-chart-voice-wav.mjs';
import { createVoiceActivityDetector } from './lumin-chart-voice-activity.mjs?v=2';
import { createLocalChartEngine, modelBytes } from './lumin-chart-voice-model.mjs?v=2';

const maxChartOperations = 8;

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
  const message = typeof draft.message === 'string' ? draft.message.trim().slice(0, 500) : '';
  if (!['add_procedure', 'clarify'].includes(draft.action)) throw new Error('draft');
  const items = draft.operations ?? [];
  if (!Array.isArray(items) || items.length > maxChartOperations) throw new Error('draft');
  const validItems = items.filter(op => typeof op?.tooth === 'string' && /^(UR|UL|LR|LL)[1-8]$/.test(op.tooth)
    && typeof op.procedure === 'string' && Object.hasOwn(presets, op.procedure)
    && (op.status === '' || typeof op.status === 'string' && Object.hasOwn(statuses, op.status))
    && Array.isArray(op.surfaces) && op.surfaces.length <= 6
    && op.surfaces.every(s => typeof s === 'string' && Object.hasOwn(surfaces, s)));
  const needsDetails = draft.action === 'clarify' || Boolean(message) || validItems.length !== items.length;
  if (!validItems.length && !needsDetails) throw new Error('draft');
  const operations = validItems.map(({ tooth, procedure, status, surfaces }) => ({
    tooth, procedure, status, surfaces: [...new Set(surfaces)]
  }));
  return { heard, operations, needsDetails, message };
}

export function voiceCatalogOptions(procedure, catalog) {
  const scope = procedure === 'composite' ? 'surface' : 'whole';
  return catalog.filter(op => op.active && op.actionScope === scope && presets[procedure]?.includes(op.visualCode)
    && !op.isOrthoPackage && !op.isImplantProcedure && !op.trackImplantProgress);
}

export function voiceReply(text) {
  const phrase = text.normalize('NFKC').toLowerCase().trim()
    .replace(/[ً-ٟـ]/gu, '').replace(/[أإآ]/gu, 'ا')
    .replace(/\p{P}+/gu, ' ').trim().replace(/\s+/gu, ' ');
  if (['confirm', 'yes', 'yes confirm', 'yes please', 'yes go ahead', 'go ahead', 'yes save it',
    'اكد', 'احفظ', 'موافق', 'نعم', 'ايوه', 'ايوة', 'ايوه احفظ', 'ايوة احفظ', 'نعم احفظ'].includes(phrase)) return 'confirm';
  if (['cancel', 'no', 'no cancel', 'no thanks', 'cancel it', 'الغ', 'الغي', 'الغاء', 'لا', 'لا الغي', 'مش موافق'].includes(phrase)) return 'cancel';
  return null;
}

const messages = {
  unavailable: ['Gemma could not run on this device. Try again.', 'تعذّر تشغيل Gemma على هذا الجهاز. حاول مرة أخرى.'],
  missing: ['Download the model to use voice charting.', 'نزّل النموذج لاستخدام الإدخال الصوتي.'],
  otherTab: ['Gemma is busy in another Lumin tab.', 'يعمل Gemma في علامة تبويب أخرى من Lumin.'],
  unsupported: ['On-device Gemma needs a browser with WebGPU and site storage.', 'يتطلب Gemma على الجهاز متصفحاً يدعم WebGPU وتخزين الموقع.'],
  storage: ['There is not enough space to save the model. Free storage and resume.', 'المساحة المتاحة لا تكفي لحفظ النموذج. حرّر مساحة ثم استأنف التنزيل.'],
  download: ['Model setup stopped. Check your connection and resume.', 'توقف إعداد النموذج. تحقّق من الاتصال ثم استأنف.'],
  sample: ['Gemma could not verify the sample command on this device. Try setup again.', 'تعذّر التحقق من الأمر التجريبي على هذا الجهاز. أعد المحاولة.'],
  draft: ['Gemma could not interpret the recording. Try a shorter command.', 'تعذّر فهم التسجيل. جرّب أمرًا أقصر.']
};

export function bindChartVoice(root, { context, catalog, apply, language, surfaceNames, engine = createLocalChartEngine() }) {
  const panel = root.querySelector('[data-voice-panel]');
  const open = root.querySelector('[data-voice-open]');
  const record = root.querySelector('[data-voice-record]');
  const voiceToggle = root.querySelector('[data-voice-spoken]');
  const read = root.querySelector('[data-voice-read]');
  const reply = root.querySelector('[data-voice-reply]');
  const download = root.querySelector('[data-voice-download]');
  const remove = root.querySelector('[data-voice-remove]');
  const progress = root.querySelector('[data-voice-progress]');
  const modelStatus = root.querySelector('[data-voice-model-status]');
  const connection = root.querySelector('[data-voice-connection]');
  const status = root.querySelector('[data-voice-status]');
  const heard = root.querySelector('[data-voice-heard]');
  const review = root.querySelector('[data-voice-review]');
  const add = root.querySelector('[data-voice-add]');
  const rows = root.querySelector('[data-voice-rows]');
  const details = root.querySelector('[data-voice-details]');
  const reset = root.querySelector('[data-voice-reset]');
  let owner, work, recording, draft = [];
  let audio, recorderReady, needsDetails = false;
  let saving = false;
  let model = { supported: true, ready: false, bytes: 0 }, modelWork, modelRevision = 0;
  let modelMessage;
  let speech, speechTimeout, heardLanguage;
  const speechPreference = 'lumin-chart-voice-spoken';
  try { voiceToggle.checked = localStorage.getItem(speechPreference) !== 'off'; } catch (_) {}
  const tr = ([en, ar]) => language() === 'ar' ? ar : en;
  const tell = (en, ar) => { status.textContent = tr([en, ar]); };
  const valid = () => owner && owner === context();

  function translate() {
    panel.dir = language() === 'ar' ? 'rtl' : 'ltr';
    for (const label of root.querySelectorAll('[data-en]')) label.textContent = tr([label.dataset.en, label.dataset.ar]);
  }

  function controls() {
    record.textContent = recording && !recording.confirmation ? tr(['Stop recording', 'إيقاف التسجيل'])
      : needsDetails ? tr(['Record missing items', 'سجّل العناصر الناقصة']) : tr(['Record command', 'تسجيل أمر']);
    reply.textContent = recording?.confirmation
      ? tr(['Stop recording', 'إيقاف التسجيل']) : tr(['Say confirm or cancel', 'قل أكّد أو ألغِ']);
    record.disabled = !model.ready || Boolean(speech || (work && (!recording || recording.confirmation)));
    voiceToggle.disabled = Boolean(work);
    open.disabled = !context() || saving;
    const ready = !needsDetails && draft.length > 0 && draft.every(row => row.read());
    for (const field of rows.querySelectorAll('select, input')) field.disabled = Boolean(work);
    read.hidden = reply.hidden = !voiceToggle.checked;
    read.disabled = !ready || Boolean(work);
    reply.disabled = !model.ready || !ready || Boolean(speech || (work && !recording?.confirmation));
    add.disabled = Boolean(work) || !ready || navigator.onLine === false;
    details.hidden = reset.hidden = !needsDetails;
    reset.disabled = Boolean(work);
    connection.hidden = !(ready && navigator.onLine === false);
    review.hidden = draft.length === 0;
    modelControls();
  }

  function modelControls() {
    const busy = modelWork?.kind === 'download';
    download.hidden = !model.supported || (model.ready && !busy);
    download.disabled = Boolean(work || (modelWork && (!busy || modelWork.controller.signal.aborted))
      || (!busy && navigator.onLine === false));
    download.textContent = busy ? tr(['Pause setup', 'إيقاف الإعداد مؤقتاً'])
      : model.bytes === modelBytes ? tr(['Finish setup', 'إكمال الإعداد'])
        : model.bytes ? tr(['Resume download', 'استئناف التنزيل'])
          : tr(['Download model · 2.4 GB', 'تنزيل النموذج · ٢٫٤ غيغابايت']);
    remove.hidden = !(model.ready || model.hasFiles);
    remove.disabled = Boolean(work || modelWork);
    modelStatus.textContent = tr(modelMessage || (!model.supported ? messages.unsupported
      : model.ready ? ['Model ready on this device', 'النموذج جاهز على هذا الجهاز']
        : navigator.onLine === false ? ['Connect to download the model.', 'اتصل بالإنترنت لتنزيل النموذج.']
          : model.bytes ? ['Partial download saved on this device', 'حُفظ الجزء المنزّل على هذا الجهاز']
            : ['Download once per device to use voice charting offline.', 'نزّل النموذج مرة واحدة على كل جهاز لاستخدام الإدخال الصوتي دون اتصال.']));
  }

  async function refreshModel() {
    const revision = ++modelRevision;
    try {
      let stored = await engine.info();
      if (!stored.ready && stored.bytes === modelBytes && engine.updateRuntime) {
        await engine.updateRuntime().catch(() => {});
        stored = await engine.info();
      }
      if (revision === modelRevision) model = stored;
    } catch (_) {
      if (revision === modelRevision) model = { supported: false, ready: false, bytes: 0 };
    }
    controls();
  }

  download.onclick = async () => {
    if (modelWork?.kind === 'download') {
      modelWork.controller.abort();
      modelMessage = ['Pausing setup…', 'جارٍ إيقاف الإعداد مؤقتاً…'];
      controls();
      return;
    }
    if (modelWork || work || model.ready || !model.supported) return;
    const controller = new AbortController();
    modelWork = { kind: 'download', controller };
    modelMessage = ['Preparing model setup…', 'جارٍ تجهيز إعداد النموذج…'];
    controls();
    try {
      await engine.download({
        signal: controller.signal,
        acceptsSample(raw) {
          let operations;
          try {
            const sample = parseVoiceDraft(raw);
            if (sample.needsDetails) return false;
            operations = sample.operations;
          } catch (_) { return false; }
          return operations?.length === 1 && operations[0].tooth === 'UR6'
            && operations[0].procedure === 'composite' && operations[0].status === 'planned';
        },
        report(stage, bytes) {
          if (controller.signal.aborted) return;
          progress.hidden = stage === 'runtime';
          if (progress.hidden) {
            modelMessage = ['Downloading the Gemma runtime…', 'جارٍ تنزيل ملفات تشغيل Gemma…'];
          } else {
            progress.value = Math.floor(bytes / modelBytes * 100);
            modelMessage = stage === 'verify' ? ['Checking Gemma on this device…', 'جارٍ اختبار Gemma على هذا الجهاز…']
              : [`Downloading model · ${progress.value}%`, `جارٍ تنزيل النموذج · ${progress.value}٪`];
          }
          modelControls();
        }
      });
      modelMessage = null;
    } catch (error) {
      modelMessage = controller.signal.aborted ? ['Setup paused. Resume whenever you’re ready.', 'توقف الإعداد مؤقتاً. يمكنك الاستئناف لاحقاً.']
        : (Object.hasOwn(messages, error.message) ? messages[error.message] : messages.download);
    } finally {
      await refreshModel();
      progress.hidden = true;
      modelWork = null;
      controls();
    }
  };

  remove.onclick = async () => {
    if (modelWork || work || !model.hasFiles) return;
    if (!window.confirm(tr(['Delete the Gemma model from this device?', 'هل تريد حذف نموذج Gemma من هذا الجهاز؟']))) return;
    modelWork = { kind: 'delete' };
    modelMessage = ['Deleting the model…', 'جارٍ حذف النموذج…'];
    controls();
    try {
      await engine.remove();
      modelMessage = ['Model deleted from this device.', 'حُذف النموذج من هذا الجهاز.'];
    } catch (error) {
      modelMessage = error.message === 'otherTab' ? messages.otherTab
        : ['Could not delete the model. Close other Lumin tabs and retry.', 'تعذّر حذف النموذج. أغلق علامات تبويب Lumin الأخرى وحاول مجدداً.'];
    } finally {
      await refreshModel();
      modelWork = null;
      controls();
    }
  };

  function stopSpeech() {
    if (!speech) return;
    speech = null;
    clearTimeout(speechTimeout);
    window.speechSynthesis?.cancel();
  }

  function clearDraft() {
    stopSpeech();
    needsDetails = false;
    details.textContent = '';
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
    if (input.node) input.node.port.onmessage = null;
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
    if (audio && audio.state !== 'closed') void audio.close().catch(() => {});
    audio = recorderReady = null;
    if (!modelWork) engine.unload?.();
    panel.hidden = true;
    open.setAttribute('aria-expanded', 'false');
    status.textContent = '';
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
    select.addEventListener('change', draftEdited);
    label.append(select);
    holder.append(label);
    return select;
  }

  function appendDraft(operations) {
    const catalogItems = catalog();
    const newRows = operations.map(op => {
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
          checkbox.addEventListener('change', draftEdited);
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
        summary() {
          const tooth = op.tooth;
          const arabic = heardLanguage === 'ar';
          const quadrant = { UR: ['upper right', 'فوق يمين'], UL: ['upper left', 'فوق شمال'],
            LR: ['lower right', 'تحت يمين'], LL: ['lower left', 'تحت شمال'] }[tooth.slice(0, 2)];
          const toothName = arabic ? `السن ${tooth[2]} ${quadrant[1]}` : `${quadrant[0]} ${tooth[2]}`;
          const names = [...selected].filter(([, box]) => box.checked).map(([name]) => surfaces[name][arabic ? 1 : 0]);
          return [toothName, procedure.selectedOptions[0].text, Object.values(statuses).find(item => item[2] === state.value)[arabic ? 1 : 0], ...names].join(', ');
        },
        read() {
          const chosen = [...selected].filter(([, checkbox]) => checkbox.checked).map(([name]) => name);
          if (!procedure.value || !state.value || !supported.length || (op.procedure === 'composite' && !chosen.length)
              || (op.procedure !== 'composite' && op.surfaces.length)) return null;
          return { tooth: op.tooth, type: op.procedure, operationId: procedure.value, status: state.value, surfaces: chosen };
        }
      };
    });
    draft.push(...newRows);
  }

  function draftEdited() {
    stopSpeech();
    controls();
  }

  function readBack() {
    if (!valid() || !voiceToggle.checked || work || needsDetails || !draft.length || draft.some(row => !row.read())) return;
    stopSpeech();
    const synth = window.speechSynthesis;
    const locale = heardLanguage === 'ar' ? 'ar' : 'en';
    const voices = synth?.getVoices().filter(voice => voice.localService && voice.lang.toLowerCase().split(/[-_]/)[0] === locale) || [];
    const speaker = voices.find(voice => voice.lang.toLowerCase() === 'ar-eg') || voices[0];
    const done = (spoken) => {
      speech = null;
      clearTimeout(speechTimeout);
      controls();
      if (spoken && !document.hidden) void start(true);
      else tell('Review the draft on screen, then use spoken confirmation or Add to chart.',
        'راجع المسودة على الشاشة، ثم استخدم التأكيد الصوتي أو زر إضافة إلى المخطط.');
    };
    if (!speaker || !window.SpeechSynthesisUtterance) { done(false); return; }
    const summaries = draft.map(row => row.summary()).join('. ');
    const question = locale === 'ar' ? 'قل أكّد أو ألغِ بعد انتهاء القراءة.' : 'Say confirm or cancel after I finish reading.';
    const utterance = speech = new SpeechSynthesisUtterance(summaries + '. ' + question);
    utterance.voice = speaker;
    utterance.lang = speaker.lang;
    utterance.onend = () => { if (speech === utterance) done(true); };
    utterance.onerror = () => { if (speech === utterance) done(false); };
    speechTimeout = setTimeout(() => {
      if (speech !== utterance) return;
      stopSpeech();
      done(false);
    }, 90000);
    tell('Reading the draft aloud…', 'جارٍ قراءة المسودة بصوت عالٍ…');
    controls();
    try { synth.speak(utterance); }
    catch (_) { done(false); }
  }

  async function submit(blob, confirmation) {
    if (work || !valid()) return;
    const controller = work = new AbortController();
    if (confirmation) tell('Checking your reply…', 'جارٍ التحقق من إجابتك…');
    else tell('Gemma is interpreting on this device…', 'يفسّر Gemma الأمر على هذا الجهاز…');
    controls();
    try {
      const raw = await engine.interpret({ blob, confirmation }, controller.signal);
      if (!valid() || controller.signal.aborted) return;
      work = null;
      if (confirmation) {
        const answer = voiceReply(raw);
        if (answer === 'cancel') {
          clearDraft();
          tell('Draft cancelled.', 'أُلغيت المسودة.');
        } else if (answer !== 'confirm') {
          tell('Say only confirm or cancel, or use the button below.', 'قل أكّد أو ألغِ فقط، أو استخدم الزر أدناه.');
        } else await save();
        controls();
        return;
      }
      const result = parseVoiceDraft(raw);
      if (draft.length + result.operations.length > maxChartOperations) {
        tell('This batch would exceed eight procedures. Start a new draft with a smaller batch.',
          'ستتجاوز هذه الدفعة ثمانية إجراءات. ابدأ مسودة جديدة بدفعة أصغر.');
        return;
      }
      heardLanguage = /\p{Script=Arabic}/u.test(result.heard) ? 'ar' : 'en';
      heard.textContent = result.heard;
      heard.hidden = !result.heard;
      needsDetails = result.needsDetails;
      details.textContent = result.message || tr(['Some items were unclear. Record the missing items with their teeth and procedures.',
        'بعض العناصر غير واضحة. سجّل العناصر الناقصة مع تحديد الأسنان والإجراءات.']);
      appendDraft(result.operations);
      if (needsDetails) {
        tell('Record only the missing items. Include the tooth and procedure for each one.',
          'سجّل العناصر الناقصة فقط، واذكر السن والإجراء لكل عنصر.');
      } else if (draft.some(row => !row.read())) {
        tell('Complete the missing fields in the draft, then confirm.', 'أكمل الحقول الناقصة في المسودة ثم أكّد الإضافة.');
      } else {
        tell('Review the procedures before adding them.', 'راجع الإجراءات قبل إضافتها.');
        if (voiceToggle.checked) readBack();
      }
    } catch (error) {
      if (!valid() || controller.signal.aborted) return;
      status.textContent = tr(Object.hasOwn(messages, error.message) ? messages[error.message] : messages.unavailable);
    } finally {
      if (work === controller) work = null;
      controls();
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
      const wav = encodeWav(input.chunks, rate, Math.min((input.confirmation ? 6 : 25) * rate, limit ?? Infinity));
      if (!valid() || controller.signal.aborted) return;
      if (wav.seconds < .2 || wav.peak < .004 || (input.confirmation && !input.voiceDetected)) {
        tell('No clear audio. Try recording again.', 'الصوت غير واضح. جرّب التسجيل مرة أخرى.');
        return;
      }
      work = null;
      return void submit(wav.blob, input.confirmation);
    } catch (_) {
      if (valid() && !controller.signal.aborted) tell('Recording interrupted. Try again.', 'انقطع التسجيل. حاول مرة أخرى.');
    } finally {
      release(input);
      if (work === controller) { work = null; controls(); }
    }
  }

  async function start(confirmation = false) {
    if (work || speech || !model.ready || !valid() || document.hidden) return;
    if (confirmation && (!voiceToggle.checked || needsDetails || !draft.length || draft.some(row => !row.read()))) return;
    if (!confirmation && !needsDetails) clearDraft();
    if (!window.AudioContext || !navigator.mediaDevices?.getUserMedia) {
      tell('Recording requires a supported browser on HTTPS.', 'يتطلب التسجيل متصفحاً يدعم الميكروفون عبر HTTPS.');
      return;
    }
    const controller = work = new AbortController();
    let active;
    tell('Waiting for microphone access…', 'في انتظار إذن الميكروفون…');
    controls();
    try {
      audio ||= new AudioContext();
      active = { audio, chunks: [], confirmation };
      const resume = active.audio.resume();
      void resume.catch(() => {});
      controller.signal.addEventListener('abort', () => release(active), { once: true });
      active.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      if (!valid() || controller.signal.aborted || document.hidden) return;
      await resume;
      recorderReady ||= engine.loadRecorder(active.audio).catch(error => {
        if (audio === active.audio) recorderReady = null;
        throw error;
      });
      await recorderReady;
      if (!valid() || controller.signal.aborted || document.hidden) return;
      const detect = createVoiceActivityDetector(active.audio.sampleRate, confirmation ? 0.8 : 3);
      const source = active.audio.createMediaStreamSource(active.stream);
      active.node = new AudioWorkletNode(active.audio, 'voice-capture');
      active.node.port.onmessage = ({ data }) => {
        if (data === 'flushed') { active.flush?.(); return; }
        active.chunks.push(data);
        const activity = detect(data);
        active.voiceDetected = activity.lastVoiceSample > 0;
        active.recentVoice = activity.recentVoice;
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
      active.timer = setTimeout(() => {
        if (confirmation || !active.recentVoice) {
          void finish(active);
          return;
        }
        controller.abort();
        stopCapture();
        work = null;
        tell('Recording reached 25 seconds while you were speaking. Try splitting the command.',
          'بلغ التسجيل ٢٥ ثانية أثناء حديثك. جرّب تقسيم الأمر.');
        controls();
      }, confirmation ? 6000 : 25000);
      if (confirmation) tell('Listening. Say confirm or cancel.', 'أستمع إليك. قل أكّد أو ألغِ.');
      else tell('Recording. Stops after three seconds of silence.', 'جارٍ التسجيل. يتوقف بعد ثلاث ثوانٍ من الصمت.');
    } catch (_) {
      if (valid() && !controller.signal.aborted) {
        tell('Could not start the microphone. Check this site’s microphone permission.',
          'تعذّر تشغيل الميكروفون. تحقّق من إذن الموقع.');
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
    open.focus();
    void refreshModel();
  });
  root.querySelector('[data-voice-close]').onclick = () => close(true);
  record.onclick = () => recording ? void finish(recording) : void start(false);
  reply.onclick = () => recording ? void finish(recording) : void start(true);
  read.onclick = () => readBack();
  reset.onclick = () => {
    clearDraft();
    tell('Start a new voice command.', 'ابدأ أمرًا صوتيًا جديدًا.');
  };
  voiceToggle.onchange = () => {
    try { localStorage.setItem(speechPreference, voiceToggle.checked ? 'on' : 'off'); } catch (_) {}
    draftEdited();
    if (voiceToggle.checked) readBack();
  };
  review.onsubmit = async event => {
    event.preventDefault();
    await save();
  };

  async function save() {
    if (work || !valid() || needsDetails) return;
    if (navigator.onLine === false) {
      tell('Confirmation received. Reconnect and tap Add to chart to save.', 'تم التأكيد. اتصل بالإنترنت واضغط إضافة إلى المخطط للحفظ.');
      return;
    }
    const entries = draft.map(row => row.read());
    if (!entries.length || entries.some(entry => !entry)) return;
    stopSpeech();
    const controller = work = new AbortController();
    saving = true;
    controls();
    tell('Saving chart procedures…', 'جارٍ حفظ إجراءات المخطط…');
    try {
      if (!await apply(entries, owner)) throw new Error('save');
      if (!valid() || controller.signal.aborted) return;
      clearDraft();
      tell('Procedures added to the chart.', 'أُضيفت الإجراءات إلى المخطط.');
    } catch (_) {
      if (valid() && !controller.signal.aborted) tell('Could not save these procedures. Review the chart and try again.',
        'تعذّر حفظ الإجراءات. راجع المخطط وحاول مرة أخرى.');
    } finally {
      saving = false;
      if (work === controller) work = null;
      controls();
    }
  }
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
  window.addEventListener('online', controls);
  window.addEventListener('offline', controls);
  engine.subscribe(() => {
    if (!modelWork) modelMessage = null;
    void refreshModel();
  });
  translate();
  controls();
  return { sync() {
    open.disabled = !context() || saving;
    if (!panel.hidden && !valid()) close();
    if (panel.hidden) translate();
  } };
}
