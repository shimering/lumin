// Serialize chart writes per patient. Keep later edits when an earlier edit fails,
// and protect optimistic chart state from reads started before those writes settled.
const patientChartSaveStates = new Map();
let patientChartWriteRevision = 0;

function clonePatientChart(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function patientChartSaveKey(patientId) {
  return JSON.stringify([currentSession?.user?.id || null, patientId]);
}

function patientChartChanges(before, after, path = []) {
  if (stableJsonStringify(before) === stableJsonStringify(after)) return [];
  const keyedArray = value => Array.isArray(value) && value.every(item => item && typeof item === 'object' && item.id != null)
    && new Set(value.map(item => String(item.id))).size === value.length;
  if (keyedArray(before) && keyedArray(after)) {
    const oldItems = new Map(before.map(item => [String(item.id), item]));
    const newItems = new Map(after.map(item => [String(item.id), item]));
    return [...new Set([...oldItems.keys(), ...newItems.keys()])].flatMap(id =>
      patientChartChanges(oldItems.get(id), newItems.get(id), [...path, { id }]));
  }
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (object(before) && object(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key =>
      patientChartChanges(before[key], after[key], [...path, key]));
  }
  return [{ path, remove: after === undefined, value: after === undefined ? null : JSON.parse(JSON.stringify(after)) }];
}

function applyPatientChartChanges(chart, changes) {
  let result = clonePatientChart(chart);
  for (const change of changes) {
    if (!change.path.length) { result = change.remove ? {} : clonePatientChart(change.value); continue; }
    let target = result;
    for (let index = 0; index < change.path.length; index++) {
      const part = change.path[index];
      const last = index === change.path.length - 1;
      let key = part;
      if (typeof part === 'object') {
        key = target.findIndex(item => String(item.id) === part.id);
        if (key < 0) {
          // A later field edit must not resurrect a finding whose creation failed.
          if (change.remove || !last) break;
          key = target.length;
          target.push({ id: part.id });
        }
      }
      if (last) {
        if (change.remove) {
          if (Array.isArray(target)) target.splice(key, 1);
          else delete target[key];
        } else target[key] = JSON.parse(JSON.stringify(change.value));
      } else {
        if (target[key] == null) {
          break;
        }
        target = target[key];
      }
    }
  }
  return result;
}

function rememberPatientChartSnapshot(patient, readRevision = patientChartWriteRevision) {
  const key = patientChartSaveKey(patient.id);
  let state = patientChartSaveStates.get(key);
  if (!state) {
    const baseline = clonePatientChart(patient.chartState);
    state = { patientId: patient.id, userId: currentSession?.user?.id, patient, confirmed: baseline,
      requested: clonePatientChart(baseline), jobs: [], running: false, revision: 0, lastError: null, drainPromise: null };
    patientChartSaveStates.set(key, state);
  } else if (state.jobs.length || state.revision > readRevision) {
    patient.chartState = (getKnownPatient(patient.id) || state.patient).chartState;
  } else {
    state.confirmed = clonePatientChart(patient.chartState);
    state.requested = clonePatientChart(patient.chartState);
  }
  state.patient = patient;
  return state;
}

function rebasePendingPatientChart(state) {
  let chart = clonePatientChart(state.confirmed);
  state.jobs.forEach(job => { chart = prepareQueuedPatientChart(state, job, chart); });
  state.requested = clonePatientChart(chart);
  if (currentSession?.user?.id !== state.userId) return;
  state.patient.chartState = chart;
  const current = getKnownPatient(state.patientId);
  if (current) current.chartState = chart;
}

function prepareQueuedPatientChart(state, job, baseline) {
  const draft = { ...state.patient, chartState: applyPatientChartChanges(baseline, job.changes) };
  collectDocumentedFindings(draft).flatMap(group => group.memberFindings || [group]).forEach(finding => {
    if (!finding.id || !finding.steps?.length) return;
    updateChartFindingById(draft, finding.id, current => {
      const status = chartFindingStatusFromSteps(current.steps, current.status);
      const statusTouched = job.changes.some(change => change.path.some(part => typeof part === 'object' && part.id === String(finding.id))
        && ['status', 'steps'].includes(change.path.at(-1)));
      const completedAt = current.steps.map(step => step.completedAt).filter(Boolean).sort().pop() || job.changedAt;
      return { ...current, status, ...(statusTouched ? {
        beginDate: status === 'P' ? null : (current.beginDate || job.changedAt),
        completedAt: status === 'C' ? (current.completedAt || completedAt) : null
      } : {}) };
    });
  });
  rebuildChartProcedureStepPayrollFindings(draft);
  return draft.chartState;
}

async function drainPatientChartSaves(state) {
  state.running = true;
  try {
    while (state.jobs.length) {
      const job = state.jobs[0];
      let chart = state.confirmed;
      let wroteChart = false;
      let saved = false;
      try {
        chart = prepareQueuedPatientChart(state, job, state.confirmed);
        if (currentSession?.user?.id !== state.userId) throw new Error('The chart editing session has ended.');
        const { error } = await db.from('patients').update({ chart_state: chart }).eq('id', state.patientId);
        if (error) throw error;
        wroteChart = true;
        if (currentSession?.user?.id !== state.userId) throw new Error('The chart editing session has ended.');
        if (job.afterSave) await job.afterSave();
        state.confirmed = chart;
        state.lastError = null;
        hrDirectoryLoaded = false;
        saved = true;
      } catch (error) {
        state.lastError = error;
        console.error('Failed to sync chart with Supabase:', error);
        // The doctor/payroll sync can reject after the chart write succeeded.
        // Restore only that committed edit before applying the next queued edit.
        if (wroteChart && currentSession?.user?.id === state.userId) {
          try {
            const rollback = await db.from('patients').update({ chart_state: state.confirmed }).eq('id', state.patientId);
            if (rollback.error) throw rollback.error;
          } catch (rollbackError) {
            state.confirmed = chart;
            console.error('Could not restore the rejected chart edit:', rollbackError);
          }
        }
      }
      state.jobs.shift();
      state.revision = ++patientChartWriteRevision;
      if (!saved) rebasePendingPatientChart(state);
      job.resolve(saved);
    }
  } finally {
    state.running = false;
    state.resolveDrain();
    state.drainPromise = null;
    if (currentSession?.user?.id === state.userId) queueRealtimeRefresh('patients');
  }
}

function enqueuePatientChartSave(patient, { previousChartState, afterSave } = {}) {
  const key = patientChartSaveKey(patient.id);
  const state = patientChartSaveStates.get(key) || rememberPatientChartSnapshot({ ...patient, chartState: previousChartState || patient.chartState });
  state.patient = patient;
  const snapshot = clonePatientChart(patient.chartState);
  const changes = patientChartChanges(state.requested, snapshot);
  state.requested = snapshot;
  state.revision = ++patientChartWriteRevision;
  const promise = new Promise(resolve => { state.jobs.push({ changes, afterSave, resolve, changedAt: new Date().toISOString() }); });
  if (!state.running) {
    state.drainPromise = new Promise(resolve => { state.resolveDrain = resolve; });
    void drainPatientChartSaves(state);
  }
  return promise;
}

async function waitForPatientChartSaves(patientId) {
  let state;
  while ((state = patientChartSaveStates.get(patientChartSaveKey(patientId)))?.drainPromise) await state.drainPromise;
}

// Patch a changed finding in place so a status change cannot close a neighboring
// step's select or discard a price/date being edited in the same procedure card.
function reconcileChartFindingNode(previous, incoming) {
  if (previous.nodeType !== incoming.nodeType || previous.nodeName !== incoming.nodeName) {
    // Lucide has already replaced this matching placeholder with its SVG.
    const icon = previous.nodeType === 1 && (previous.getAttribute('data-lumin-chart-icon') || previous.getAttribute('data-lucide'));
    if (icon && incoming.nodeType === 1 && icon === incoming.getAttribute('data-lucide')) return previous;
    previous.replaceWith(incoming);
    return incoming;
  }
  if (previous.nodeType !== 1) {
    if (previous.nodeValue !== incoming.nodeValue) previous.nodeValue = incoming.nodeValue;
    return previous;
  }
  if (previous.hasAttribute('data-chart-step') && previous.getAttribute('data-chart-step') !== incoming.getAttribute('data-chart-step')) {
    previous.replaceWith(incoming);
    return incoming;
  }
  const isSelect = previous.tagName === 'SELECT';
  const oldValue = isSelect ? previous.value : null;
  const oldDefault = isSelect ? (Array.from(previous.options).find(option => option.defaultSelected) || previous.options[0])?.value : null;
  const nextValue = isSelect ? incoming.value : null;
  const valueChanged = previous.getAttribute('value') !== incoming.getAttribute('value');
  const checkedChanged = previous.hasAttribute('checked') !== incoming.hasAttribute('checked');
  Array.from(previous.attributes).forEach(attribute => {
    if (!incoming.hasAttribute(attribute.name)) previous.removeAttribute(attribute.name);
  });
  Array.from(incoming.attributes).forEach(attribute => {
    if (previous.getAttribute(attribute.name) !== attribute.value) previous.setAttribute(attribute.name, attribute.value);
  });
  const nextChildren = Array.from(incoming.childNodes);
  nextChildren.forEach((child, index) => {
    const existing = previous.childNodes[index];
    if (existing) reconcileChartFindingNode(existing, child);
    else previous.appendChild(child);
  });
  while (previous.childNodes.length > nextChildren.length) previous.lastChild.remove();
  if (isSelect) previous.value = oldDefault !== nextValue ? nextValue : oldValue;
  if (previous.tagName === 'INPUT') {
    if (valueChanged && previous !== document.activeElement) previous.value = incoming.value;
    if (checkedChanged) previous.checked = incoming.checked;
  }
  return previous;
}

function renderChartFindingIcons(container) {
  if (!window.lucide) return;
  const placeholders = container.querySelectorAll('i[data-lucide]');
  if (!placeholders.length) return;
  placeholders.forEach(element => {
    const name = element.getAttribute('data-lucide');
    element.removeAttribute('data-lucide');
    element.setAttribute('data-lumin-chart-icon', name);
    element.setAttribute('data-chart-icon', name);
  });
  lucide.createIcons({ nameAttr: 'data-chart-icon' });
  container.querySelectorAll('[data-chart-icon]').forEach(element => element.removeAttribute('data-chart-icon'));
  container.luminRenderedFirstChild = container.firstElementChild;
}
