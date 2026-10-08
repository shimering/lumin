// Shared by the clinic UI and Edge Functions. Only the explicit display projection
// returned by project() may be sent to an unauthenticated patient.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LuminQuotationModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const PRIMARY = {4:'A',5:'B',6:'C',7:'D',8:'E',9:'F',10:'G',11:'H',12:'I',13:'J',20:'K',21:'L',22:'M',23:'N',24:'O',25:'P',26:'Q',27:'R',28:'S',29:'T'};
  const PRIMARY_SLOTS = Object.fromEntries(Object.entries(PRIMARY).map(([slot,id]) => [id,Number(slot)]));
  const SURFACES = ['top','center','bottom','left','right'];
  const VISUALS = {
    surface:['healthy','caries','composite','amalgam','glass_ionomer','temporary','sealant','inlay','onlay','fracture','erosion','filling'],
    whole:['none','missing','crown','ceramic_crown','zirconia_crown','temporary_crown','implant','rct','bridge','veneer','impacted','unerupted','extraction_planned','bracket'], mouth:['none']
  };
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const array = value => Array.isArray(value) ? value : value == null ? [] : [value];
  const cents = value => Math.round(Math.max(0, Number(value) || 0) * 100);
  const validId = value => typeof value === 'string' && UUID.test(value);
  const slotForTooth = id => PRIMARY_SLOTS[String(id).toUpperCase()] || (/^(?:[1-9]|[12]\d|3[0-2])$/.test(String(id)) ? Number(id) : 0);
  function statusOf(finding) {
    const seen = new Set();
    const steps = array(finding.steps || finding.procedureSteps || finding.procedure_steps).filter(step => {
      if (!object(step)) return false;
      const id = step.id || step.stepId || step.step_id;
      const percent = Math.round(Number(step.percentage) * 100) / 100;
      if (!validId(id) || seen.has(id) || !String(step.name || step.stepName || step.step_name || '').trim() || !(percent > 0 && percent <= 100)) return false;
      seen.add(id); return true;
    });
    if (steps.length && Math.round(steps.reduce((sum, step) => sum + Number(step.percentage), 0) * 100) === 10000) {
      if (steps.every(step => step.status === 'C')) return 'C';
      if (steps.some(step => ['C','In'].includes(step.status))) return 'In';
      return 'P';
    }
    return ['P','In','C','E'].includes(finding.status) ? finding.status : 'E';
  }
  function collect(chart, operations) {
    const catalog = new Map(array(operations).map(op => [String(op.code),op]));
    const records = new Map();
    function add(value, toothId, scope, surface) {
      if (!object(value) || !validId(value.id) || value.isProcedureStep || value.is_procedure_step) return;
      const code = String(value.code || value.operation || value.value || 'none');
      if (['none','healthy'].includes(code)) return;
      const op = catalog.get(code) || {};
      const status = statusOf(value);
      const rawPrice = value.price;
      const price = rawPrice != null && String(rawPrice).trim() !== '' && Number.isFinite(Number(rawPrice)) && Number(rawPrice) >= 0 ? Number(rawPrice) : Number(op.price) || 0;
      const batchId = value.batchId || value.batch_id;
      const multiplier = Number(value.billingMultiplier ?? value.billing_multiplier);
      const key = `${scope}:${toothId}:${value.id}`;
      if (!records.has(key)) records.set(key, {
        id:value.id, toothId, scope, code, status, price, surfaces:[],
        batchId:scope !== 'mouth' && validId(batchId) ? batchId : null,
        multiplier:Number.isInteger(multiplier) && multiplier >= 1 && multiplier <= 999 ? multiplier : null,
        visits:array(value.orthoVisits || value.ortho_visits),
        isPackage:Boolean(value.isOrthoPackage || value.is_ortho_package || array(value.orthoVisits || value.ortho_visits).length),
        op
      });
      if (surface && !records.get(key).surfaces.includes(surface)) records.get(key).surfaces.push(surface);
    }
    array(chart?._meta?.mouthOperations).forEach(value => add(value,'','mouth'));
    Object.entries(object(chart) ? chart : {}).forEach(([toothId,data]) => {
      if (!slotForTooth(toothId) || !object(data)) return;
      const whole = array(data.wholeOperations);
      const legacy = data.status;
      if (object(legacy) && !whole.some(value => value?.code === legacy.code && statusOf(value) === statusOf(legacy))) add(legacy,toothId,'whole');
      whole.forEach(value => add(value,toothId,'whole'));
      SURFACES.forEach(surface => array(data.surfaces?.[surface]).forEach(value => add(value,toothId,'surface',surface)));
    });
    const groups = new Map();
    for (const record of records.values()) {
      if (record.isPackage) continue;
      const key = record.batchId ? `${record.batchId}:${record.scope}:${record.code}` : record.id;
      if (!groups.has(key)) groups.set(key,[]);
      groups.get(key).push(record);
    }
    const candidates = [];
    for (const [groupKey,members] of groups) {
      const first = members[0];
      const totalCents = first.batchId && members.length > 1 ? cents(first.price * (first.multiplier || members.length)) : cents(first.price);
      // Match invoice allocation, while avoiding a negative final cent for tiny totals.
      const roundedShare = Math.round(totalCents / members.length);
      const share = roundedShare * (members.length - 1) > totalCents ? Math.floor(totalCents / members.length) : roundedShare;
      [...members].sort((a,b) => a.id.localeCompare(b.id)).forEach((member,index) => candidates.push({
        ...member, groupKey, amountCents:index === members.length - 1 ? totalCents - share * (members.length - 1) : share
      }));
    }
    const seenVisits = new Set();
    for (const record of records.values()) {
      if (!record.isPackage || ['C','E'].includes(record.status)) continue;
      record.visits.forEach((visit,index) => {
        if (!object(visit) || !validId(visit.id) || seenVisits.has(visit.id)) return;
        seenVisits.add(visit.id);
        candidates.push({...record,id:visit.id,batchId:null,groupKey:visit.id,
          status:['P','In','C'].includes(visit.status) ? visit.status : 'P',
          visitNumber:Math.max(1,Number(visit.visitNumber || visit.visit_number) || index + 1),
          amountCents:cents(visit.price),price:Math.max(0,Number(visit.price) || 0)});
      });
    }
    return candidates;
  }
  function teethFor(chart, items) {
    const meta = object(chart?._meta) ? chart._meta : {};
    const teeth = [];
    for (let slot=1;slot<=32;slot++) {
      const allowed = PRIMARY[slot] ? ['primary','permanent'] : ['empty','permanent'];
      const override = meta.toothDentition?.[slot];
      const dentition = allowed.includes(override) ? override : meta.baseDentition === 'primary' ? PRIMARY[slot] ? 'primary' : 'empty' : 'permanent';
      teeth.push({slot,toothId:dentition === 'primary' ? PRIMARY[slot] : dentition === 'permanent' ? String(slot) : null});
    }
    // A quoted primary tooth remains inspectable even when the chart switches dentition.
    items.flatMap(item => item.targets).forEach(target => {
      if (!teeth.some(tooth => tooth.toothId === target.toothId)) teeth.push({slot:slotForTooth(target.toothId),toothId:target.toothId});
    });
    return teeth;
  }
  function project(chart, operations, selectedIds, phase = 'live') {
    const requested = new Set(array(selectedIds).filter(validId));
    const candidates = collect(chart,operations);
    const chosen = candidates.filter(record => requested.has(record.id) && (phase === 'create' ? record.status === 'P' : ['P','In'].includes(record.status)));
    const groups = new Map();
    for (const record of chosen) {
      if (!groups.has(record.groupKey)) {
        const scope = record.scope;
        const configuredVisual = record.op.visual_code || record.op.visualCode;
        const configuredScope = record.op.action_scope || record.op.actionScope;
        const visualCode = configuredScope === scope && VISUALS[scope].includes(configuredVisual) ? configuredVisual : VISUALS[scope].includes(record.code) ? record.code : scope === 'surface' ? 'healthy' : 'none';
        groups.set(record.groupKey, {key:record.groupKey,name:String(record.op.name || record.code.replaceAll('_',' ')).slice(0,160),
          scope,visualCode,status:'P',targets:[],amountCents:0,visitNumber:record.visitNumber || null});
      }
      const item = groups.get(record.groupKey);
      if (record.status === 'In') item.status = 'In';
      if (record.toothId) item.targets.push({toothId:record.toothId,surfaces:[...record.surfaces]});
      item.amountCents += record.amountCents;
    }
    const items = [...groups.values()].map(({amountCents,...item}) => ({...item,amount:amountCents / 100}));
    return {items,total:items.reduce((sum,item) => sum + cents(item.amount),0) / 100,currency:'EGP',
      teeth:teethFor(chart,items),eligibleIds:[...new Set(chosen.map(record => record.id))],excludedCount:requested.size - new Set(chosen.map(record => record.id)).size};
  }
  function publicProjection(chart, operations, selectedIds) {
    const {items,total,currency,teeth} = project(chart,operations,selectedIds);
    return {items,total,currency,teeth};
  }
  function toothLabel(toothId) {
    const slot = slotForTooth(toothId);
    const position = slot <= 8 ? 9-slot : slot <= 16 ? slot-8 : slot <= 24 ? 25-slot : slot-24;
    const quadrant = slot <= 8 ? 'UR' : slot <= 16 ? 'UL' : slot <= 24 ? 'LL' : 'LR';
    return slot ? quadrant + (/^[A-T]$/.test(String(toothId)) ? String.fromCharCode(64+position) : position) : '';
  }
  return {validId,statusOf,collect,project,publicProjection,slotForTooth,toothLabel,cents};
});
