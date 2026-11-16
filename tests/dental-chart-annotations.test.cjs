const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');

test('specialty rail shows specialty names without procedure counts', () => {
  const start = html.indexOf('function renderChartSpecialtyRail()');
  const end = html.indexOf('function renderClinicalActionSelectors()', start);
  const renderer = html.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(renderer, /operationCount/);
  assert.doesNotMatch(renderer, /\$\{operationCount\}\s+procedure/);
});

test('selected procedure area omits the imported specialty description', () => {
  assert.doesNotMatch(html, /id="chart-selected-specialty-description"/);
  assert.doesNotMatch(html, /getElementById\('chart-selected-specialty-description'\)/);
});

test('odontogram teeth use larger art with tighter card spacing', () => {
  assert.match(html, /#upper-arch \.tooth-card,[\s\S]*?#lower-arch \.tooth-card\s*\{[\s\S]*?padding:\s*clamp\(2px, 0\.3vw, 5px\) 0;/);
  assert.match(html, /\.clinical-odontogram-stage \.tooth-card\s*\{[\s\S]*?gap:\s*0\.1rem;[\s\S]*?padding:\s*clamp\(2px, 0\.3vw, 5px\) 0;/);
  assert.match(html, /\.clinical-odontogram-stage \.odontogram-anatomy\s*\{[\s\S]*?width:\s*clamp\(44px, 4\.85vw, 66px\) !important;/);
  assert.match(html, /\.clinical-odontogram-stage \.odontogram-surface-view\s*\{[\s\S]*?width:\s*clamp\(40px, 4\.75vw, 64px\) !important;/);
  assert.match(html, /@media \(max-width: 899px\)[\s\S]*?width:\s*clamp\(42px, 11\.5vw, 52px\) !important;/);
});

test('selected Existed status keeps a white face with dark emphasis', () => {
  assert.match(html, /#action-palette-card \.operation-status-choice\.operation-status-e\.is-selected\s*\{[\s\S]*?color:\s*#0f172a;[\s\S]*?background:\s*#ffffff !important;/);
  assert.match(html, /selected \? \(status === 'E' \? '#ffffff' : OPERATION_STATUSES\[status\]\.color\) : ''/);
});

test('extracted teeth show a pontic only for a crown planned later than the extraction', () => {
  const functions = [
    'dentalOperationByCode', 'dentalOperationVisualCode', 'chartFindingCreatedAtTimestamp',
    'chartFindingRepresentsExtraction', 'chartPonticCrownFinding', 'renderToothVisuals'
  ].map(name => {
    const start = html.indexOf(`    function ${name}(`);
    assert.ok(start >= 0, name);
    return html.slice(start, html.indexOf('\n    }', start) + 6);
  });
  const surfaceMap = { dataset: {}, style: { setProperty() {} } };
  const card = {
    dataset: { slot: '3' },
    classList: { toggle() {} },
    style: { setProperty() {} },
    querySelector: () => surfaceMap,
    toggleAttribute(name, active) { this[name] = active; }
  };
  const anatomyGroup = { style: {}, classList: { remove() {} } };
  const toothPhoto = { style: {} };
  const render = vm.runInNewContext(`
    ${functions.join('\n')}
    let wholeFindings;
    const elements = {
      'tooth-card-3': card, 'anatomy-group-3': anatomyGroup,
      'anatomy-overlay-3': { classList: { remove() {} } }, 'tooth-photo-3': toothPhoto
    };
    const document = { getElementById: id => elements[id] || null };
    const getActivePatient = () => ({});
    const chartFindingForTooth = () => ({});
    const chartWholeFindings = () => wholeFindings;
    const chartToothHasFinding = () => true;
    const dentalOperations = [
      { code: 'simple_extraction', actionScope: 'whole', visualCode: 'extraction_planned' },
      { code: 'zirconium_crown', actionScope: 'whole', visualCode: 'zirconia_crown' }
    ];
    const DENTAL_VISUAL_PRESETS = { whole: ['missing', 'crown', 'extraction_planned', 'zirconia_crown'] };
    const isPrimaryToothId = () => false;
    const OPERATION_STATUSES = { E: {}, P: {}, In: {}, C: {} };
    const operationStatusDefinition = status => ({ color: status });
    const operationStatusClass = status => 'operation-status-' + status;
    const chartSelectionTargets = () => [];
    const CHART_SURFACES = [];
    findings => { wholeFindings = findings; renderToothVisuals('3'); }
  `, { card, anatomyGroup, toothPhoto });

  const extraction = { code: 'missing', status: 'E', createdAt: '2026-11-16T10:00:00+02:00' };
  const crown = { code: 'crown', status: 'P', beginDate: '2026-11-28T12:30:00Z' };
  const earlier = { ...crown, createdAt: '2026-11-16T07:59:00Z' };
  const later = { ...crown, createdAt: '2026-11-16T08:01:00Z' };

  for (const findings of [
    [extraction, earlier],
    [extraction, { ...crown, createdAt: '2026-11-16T08:00:00Z' }],
    [extraction, crown],
    [{ code: 'missing' }, later],
    [{ ...extraction, createdAt: 'invalid' }, later],
    [{ ...extraction, createdAt: '2026-11-16T08:02:00Z' }, extraction, later]
  ]) {
    render(findings);
    assert.equal(card['data-pontic'], false);
    assert.equal(surfaceMap.dataset.occlusalCondition, 'missing');
  }

  render([later, extraction, earlier]);
  assert.equal(card['data-pontic'], true);
  assert.equal(surfaceMap.dataset.occlusalCondition, 'pontic');
  assert.equal(anatomyGroup.style.opacity, '1');
  assert.equal(toothPhoto.style.opacity, '0.22');

  const simpleExtraction = { ...extraction, code: 'simple_extraction' };
  const zirconiumCrown = { ...later, code: 'zirconium_crown' };
  for (const status of ['P', 'In', 'E', 'C']) {
    render([zirconiumCrown, { ...simpleExtraction, status }]);
    assert.equal(card['data-pontic'], true);
    assert.equal(surfaceMap.dataset.occlusalCondition, 'pontic');
    assert.equal(anatomyGroup.style.opacity, '1');
    assert.equal(toothPhoto.style.opacity, '0.22');
  }
  for (const findings of [
    [{ ...zirconiumCrown, createdAt: earlier.createdAt }, { ...simpleExtraction, status: 'P' }],
    [zirconiumCrown, { ...simpleExtraction, status: 'P', createdAt: zirconiumCrown.createdAt }],
    [{ ...zirconiumCrown, createdAt: earlier.createdAt }, simpleExtraction]
  ]) {
    render(findings);
    assert.equal(card['data-pontic'], false);
    assert.equal(surfaceMap.dataset.occlusalCondition, 'extraction_planned');
    assert.equal(anatomyGroup.style.opacity, '0.15');
  }

  render([later]);
  assert.equal(card['data-pontic'], false);
  assert.equal(surfaceMap.dataset.occlusalCondition, 'crown');
});
