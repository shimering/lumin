const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const root = path.resolve(__dirname, '..');
const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');

test('appointment operation links are optional, patient-specific and follow clinical changes under RLS', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`
    create schema private; create schema auth; create role anon; create role authenticated;
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
    create function private.is_admin() returns boolean language sql as $$select coalesce(current_setting('test.pages',true),'')='admin'$$;
    create function private.is_active_user() returns boolean language sql as $$select coalesce(current_setting('test.active',true),'true')='true'$$;
    create function private.has_page_permission(p text) returns boolean language sql as $$select p=any(string_to_array(current_setting('test.pages',true),','))$$;
    create table public.patients(id uuid primary key, chart_state jsonb);
    create table public.dental_specialties(id uuid primary key,name text,icon_name text);
    create table public.dental_operations(code text primary key, name text,specialty_id uuid,price numeric);
    create table public.appointments(id uuid primary key, patient_id uuid references public.patients(id),status text default 'Scheduled');
    grant usage on schema public,private,auth to authenticated,anon;
    grant select,insert,update,delete on public.appointments to authenticated;
    grant select,update on public.patients to authenticated;
    grant select on public.dental_operations to authenticated;
    grant select on public.dental_specialties to authenticated;
    alter table public.appointments enable row level security;
    create policy appointment_read on public.appointments for select to authenticated using(private.has_page_permission('appointments') or private.has_page_permission('chart'));
    create policy appointment_insert on public.appointments for insert to authenticated with check(private.has_page_permission('appointments'));
    create policy appointment_update on public.appointments for update to authenticated using(private.has_page_permission('appointments')) with check(private.has_page_permission('appointments'));
    alter table public.patients enable row level security;
    create policy patient_read on public.patients for select to authenticated using(private.has_page_permission('appointments') or private.has_page_permission('chart'));
    create policy patient_update on public.patients for update to authenticated using(private.has_page_permission('chart')) with check(private.has_page_permission('chart'));
  `);
  await db.exec(fs.readFileSync(path.join(__dirname, 'fixtures/appointment-chart-parser.sql'), 'utf8'));
  await db.exec(fs.readFileSync(path.join(root, 'supabase/migrations/20261014120830_appointment_operations.sql'), 'utf8'));
  await db.exec(fs.readFileSync(path.join(root, 'supabase/migrations/20261014124000_appointment_operation_catalog.sql'), 'utf8'));
  // Apply the real chart parser update, including its restricted helper ACL.
  // The older parser fixture alone cannot detect nested invoker permission errors.
  const orthoMigration = fs.readFileSync(path.join(root, 'supabase/migrations/20261020133050_ortho_visit_billing_and_payroll.sql'), 'utf8');
  const parserEnd = orthoMigration.indexOf('create or replace function private.chart_finding_by_id(');
  assert.ok(parserEnd > 0);
  await db.exec(orthoMigration.slice(0, parserEnd));
  const finding = (id, code = 'filling', status = 'P', extra = {}) => ({ id: uuid(id), code, status, ...extra });
  const chart = {
    '11': { wholeOperations: [finding(11, 'crown', 'In')], surfaces: { B: [finding(12)], O: [finding(12)] } },
    '12': { wholeOperations: [finding(13, 'filling', 'P', { batchId: 'batch' }), finding(15, 'crown', 'C')] },
    '13': { wholeOperations: [finding(14, 'filling', 'In', { batchId: 'batch' }), finding(16, 'crown', 'E'), finding(17, 'crown', 'P', { isProcedureStep: true })] },
    _meta: { mouthOperations: [finding(18, 'scaling')] }
  };
  await db.query('insert into public.patients values($1,$2),($3,$4)', [uuid(1), JSON.stringify(chart), uuid(2), JSON.stringify({ '21': { wholeOperations: [finding(21)] } })]);
  await db.exec("insert into public.dental_operations(code,name) values('filling','Composite restoration'),('crown','Crown'),('scaling','Scaling and polishing')");
  await db.exec(`set role authenticated; select set_config('test.actor','${uuid(99)}',false); select set_config('test.pages','appointments',false)`);
  const choices = async id => (await db.query('select public.get_patient_appointment_operations($1) result', [uuid(id)])).rows[0].result;
  const insert = async (id, ops, patient = 1) => db.query('insert into public.appointments(id,patient_id,operations) values($1,$2,$3) returning operations', [uuid(id), uuid(patient), JSON.stringify(ops)]);
  const link = (...ids) => ({ finding_ids: ids.map(uuid) });
  const stored = async id => (await db.query('select operations from public.appointments where id=$1', [uuid(id)])).rows[0].operations;

  await t.test('nested parser permission regression blocks both loading and saving until repaired', async () => {
    await assert.rejects(choices(1), /permission denied for function ortho_visit_finding_rows/);
    await assert.rejects(insert(100, [link(11)]), /permission denied for function ortho_visit_finding_rows/);
    await db.exec('reset role');
    await db.exec(fs.readFileSync(path.join(root, 'supabase/migrations/20261021043711_restore_appointment_operation_parser_access.sql'), 'utf8'));
    const permissions = (await db.query(`select
      has_function_privilege('authenticated','private.ortho_visit_finding_rows(jsonb)','execute') as staff,
      has_function_privilege('anon','private.ortho_visit_finding_rows(jsonb)','execute') as anonymous,
      (select prosecdef from pg_proc where oid='private.ortho_visit_finding_rows(jsonb)'::regprocedure) as security_definer`)).rows[0];
    assert.deepEqual(permissions, { staff: true, anonymous: false, security_definer: false });
    await db.exec('set role authenticated');
    assert.equal((await choices(1)).length, 6);
    await insert(99, [link(11)]);
    assert.deepEqual((await stored(99))[0].finding_ids, [uuid(11)]);
    await db.query('update public.appointments set operations=$1 where id=$2', [JSON.stringify([link(12)]), uuid(99)]);
    assert.deepEqual((await stored(99))[0].finding_ids, [uuid(12)]);
    await db.exec('reset role');
    await db.query('delete from public.appointments where id=$1', [uuid(99)]);
    await db.exec('set role authenticated');
  });

  await t.test('picker groups multi-surface fillings, batch teeth and mouth operations without steps', async () => {
    const options = await choices(1);
    assert.equal(options.length, 6);
    const surface = options.find(x => x.finding_ids.includes(uuid(12)));
    assert.deepEqual(surface.surfaces, ['B', 'O']);
    const batch = options.find(x => x.finding_ids.includes(uuid(13)));
    assert.deepEqual(batch.finding_ids, [uuid(13), uuid(14)]);
    assert.deepEqual(batch.tooth_ids, ['12', '13']); assert.equal(batch.status, 'In');
    assert.deepEqual(options.find(x => x.code === 'scaling').tooth_ids, []);
  });
  await t.test('empty selection, multiple links and canonical labels are persisted', async () => {
    await insert(100, []); assert.deepEqual(await stored(100), []);
    await insert(101, [link(11), { ...link(12), name: 'Forged label', status: 'C' }, link(11)]);
    const result = await stored(101); assert.equal(result.length, 2);
    assert.equal(result[1].name, 'Composite restoration'); assert.equal(result[1].status, 'P');
    await insert(102, [link(13, 14), link(18)]);
  });
  await t.test('foreign, deleted, incomplete batches and newly completed references are rejected', async () => {
    for (const ops of [[link(21)], [link(90)], [link(13)], [link(15)], [{finding_ids:'bad'}]]) {
      await assert.rejects(insert(103, ops), /operation|Only planned/i);
    }
    await db.query('update public.appointments set operations=$1 where id=$2', [JSON.stringify([link(18)]), uuid(102)]);
    assert.deepEqual((await stored(102))[0].finding_ids, [uuid(18)]);
    await db.query("update public.appointments set operations='[]' where id=$1", [uuid(102)]);
    assert.deepEqual(await stored(102), []);
  });
  await t.test('a chart-only doctor refreshes completed, changed and deleted links without appointment edit access', async () => {
    await db.exec("select set_config('test.pages','chart',false)");
    chart['11'].wholeOperations[0].status = 'C';
    chart['11'].surfaces = {};
    await db.query('update public.patients set chart_state=$1 where id=$2', [JSON.stringify(chart), uuid(1)]);
    const result = await stored(101); assert.equal(result.length, 1); assert.equal(result[0].status, 'C');
    assert.equal((await db.query('select status from public.appointments where id=$1', [uuid(101)])).rows[0].status, 'Scheduled');
    await assert.rejects(choices(1), /Appointment access required/);
    await db.exec("select set_config('test.pages','appointments',false)");
    await db.query('update public.appointments set operations=$1 where id=$2', [JSON.stringify([link(11)]), uuid(101)]);
    assert.equal((await stored(101))[0].status, 'C', 'existing completed links remain editable');
    await db.query('update public.appointments set patient_id=$1,operations=$2 where id=$3', [uuid(2), '[]', uuid(101)]);
    assert.deepEqual(await stored(101), []);
    await assert.rejects(insert(104, [link(11)], 2), /changed or was deleted/);
  });
  await t.test('appointment-only staff can read category icons and names without access to clinical prices', async () => {
    await db.exec(`reset role; insert into public.dental_specialties values('${uuid(30)}','Restoration','dental-restorative');
      update public.dental_operations set specialty_id='${uuid(30)}',price=800 where code='filling';
      alter table public.dental_operations enable row level security;
      alter table public.dental_specialties enable row level security;
      create policy catalog_chart_only on public.dental_operations for select to authenticated using(private.has_page_permission('chart'));
      create policy category_chart_only on public.dental_specialties for select to authenticated using(private.has_page_permission('chart'));
      set role authenticated;
    `);
    assert.equal((await db.query('select * from public.dental_operations')).rows.length,0);
    const read=async()=>(await db.query('select public.get_appointment_operation_catalog() result')).rows[0].result;
    const catalog=await read(),filling=catalog.find(o=>o.code==='filling');
    assert.deepEqual(filling,{code:'filling',name:'Composite restoration',category_name:'Restoration',icon_name:'dental-restorative'});
    assert.ok(catalog.every(o=>!('price' in o)&&!('chart_state' in o)));
    await db.exec("select set_config('test.pages','chart',false)");
    await assert.rejects(read(),/Appointment access required/);
    await db.exec("select set_config('test.pages','appointments',false); select set_config('test.active','false',false)");
    await assert.rejects(read(),/Appointment access required/);
    await db.exec("select set_config('test.active','true',false)");
  });
  await t.test('calendar notes have no links and unauthenticated or inactive users cannot read choices', async () => {
    await db.query('insert into public.appointments(id,operations) values($1,$2)', [uuid(105), JSON.stringify([link(11)])]);
    assert.deepEqual(await stored(105), []);
    await db.exec("select set_config('test.active','false',false)");
    await assert.rejects(choices(1), /Appointment access required/);
    await db.exec('reset role; set role anon');
    await assert.rejects(choices(1), /permission denied/);
    await assert.rejects(db.query('select public.get_appointment_operation_catalog()'),/permission denied/);
  });
});
