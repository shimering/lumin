const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261027212346_optimize_hr_finding_lookup.sql'), 'utf8');
const original = fs.readFileSync(path.join(root, 'supabase/migrations/20261020133050_ortho_visit_billing_and_payroll.sql'), 'utf8');
const uuid = n => 'abcdefab-abcd-4abc-8abc-' + String(n).padStart(12, '0');

test('targeted lookup preserves chart findings, surface precedence, and effective orthodontic visits', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec('create schema private; create role anon; create role authenticated;');
  await db.exec(original.slice(0, original.indexOf('-- The invoice item retains')));
  const finding = (id, extra = {}) => ({ id: uuid(id), code: 'composite', status: 'C', price: 600, ...extra });
  const chart = {
    _meta: { mouthOperations: [finding(1), finding(2, { orthoVisits: [finding(3, { date: '2026-10-13', doctorId: uuid(21) })], doctorId: uuid(20), doctorName: 'Main doctor' })] },
    '11': { wholeOperations: [finding(4), finding(5, { ortho_visits: [finding(6, { status: 'P', doctor_id: uuid(22) })] })],
      surfaces: { O: [finding(7), finding(8)], M: finding(7), D: [finding(9, { id: uuid(9).toUpperCase() })], B: null }, status: finding(10) },
    '12': { surfaces: { O: ['healthy', finding(11)] }, wholeOperations: 'invalid' },
    '13': { wholeOperations: [finding(12)], surfaces: { O: finding(12, { code: 'lower-priority' }) }, status: finding(12, { code: 'legacy' }) },
    '14': { surfaces: { M: finding(13, { marker: 'first-surface' }), O: [finding(13, { marker: 'later-surface' })] } },
    '15': { wholeOperations: [finding(1, { code: 'lower-priority' })] },
    '16': null, '17': ['invalid'], '18': { status: 'healthy', surfaces: 'invalid' }
  };
  const fixtures = [chart, null, [], 'invalid', {}, { _meta: { mouthOperations: 'invalid' }, '11': { wholeOperations: {}, surfaces: { O: 'healthy', M: {} } } },
    { _meta: { mouthOperations: finding(1), wholeOperations: [finding(2)] }, '11': { wholeOperations: [[finding(3)]], status: [finding(4)], surfaces: { O: [[finding(5)]] } } },
    { _meta: [{ mouthOperations: [finding(1)] }], '11': [{ wholeOperations: [finding(2)] }], '12': { wholeOperations: finding(3), surfaces: [{ O: [finding(4)] }] } }];
  const expected = [];
  for (const state of fixtures) {
    for (const id of [...Array.from({ length: 14 }, (_, i) => uuid(i + 1)), null]) {
      const result = await db.query('select private.chart_finding_by_id($1::jsonb,$2::uuid) finding', [JSON.stringify(state), id]);
      expected.push({ state, id, finding: result.rows[0].finding });
    }
  }
  await db.exec(migration);
  await db.exec(fs.readFileSync(path.join(root, 'supabase/migrations/20261027213238_skip_absent_payroll_chart_findings.sql'), 'utf8'));
  for (const { state, id, finding: value } of expected) {
    const result = await db.query('select private.chart_finding_by_id($1::jsonb,$2::uuid) finding', [JSON.stringify(state), id]);
    assert.deepEqual(result.rows[0].finding, value, 'same finding for ' + id);
  }
  // Ordinary lookups must not invoke the full parser or expand unrelated visits.
  await db.exec(`create or replace function private.patient_chart_finding_rows(p_state jsonb)
    returns table(finding_key text,finding_id uuid,tooth_id text,finding_kind text,surfaces text[],finding jsonb,operation_code text,operation_status text,finding_price numeric,created_at_text text)
    language plpgsql immutable as $$begin raise exception 'Full chart parsing is forbidden'; end;$$;
    create or replace function private.ortho_visit_finding_rows(p_chart jsonb)
    returns table(finding_id uuid,tooth_id text,finding jsonb) language plpgsql immutable as $$begin raise exception 'Unrelated visit expansion is forbidden'; end;$$;`);
  for (const id of [1, 4, 7, 9, 10, 11, 12, 13]) {
    assert.ok((await db.query('select private.chart_finding_by_id($1::jsonb,$2::uuid) finding', [JSON.stringify(chart), uuid(id)])).rows[0].finding);
  }
  const permissions = (await db.query("select has_function_privilege('anon','private.chart_finding_by_id(jsonb,uuid)','execute') anonymous,has_function_privilege('authenticated','private.chart_finding_by_id(jsonb,uuid)','execute') direct")).rows[0];
  assert.deepEqual(permissions, { anonymous: false, direct: false });
});
