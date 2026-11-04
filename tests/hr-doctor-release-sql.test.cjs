const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, 'supabase/migrations', name), 'utf8');
const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');

test('procedure releases persist, exclude every payment scope, restore safely, and support cross-year selections', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(fs.readFileSync(path.join(__dirname, 'fixtures/clinic-management.sql'), 'utf8'));
  await db.exec(`
    create function private.can_manage_hr() returns boolean language sql as $$select current_setting('test.access',true)='admin'$$;
    grant usage on schema public,auth to anon,authenticated;
    create table public.payment_methods(id uuid primary key,active boolean);
    insert into public.payment_methods values('${uuid(80)}',true);
    alter table public.expense_types add column active boolean default true,add column created_at timestamptz default now();
    insert into public.expense_types(id,name) values('${uuid(81)}','Salary');
    alter table public.expenses alter column id set default gen_random_uuid(),add primary key(id),
      add column name text,add column quantity numeric,add column description text,add column confirmed boolean,
      add column created_by uuid,add column sync_payment_method_id uuid;
    create table public.hr_payroll_periods(pay_month date primary key);
    create table public.hr_salary_payments(
      id uuid primary key default gen_random_uuid(),user_id uuid,pay_month date,attended_shifts integer,
      regular_shift_rate numeric,regular_amount numeric,extra_amount numeric,performance_amount numeric,total_amount numeric,
      expense_id uuid references public.expenses(id) on delete cascade,paid_by uuid,payment_kind text,
      scope_start date,scope_end date,case_count integer,paid_at timestamptz default now(),
      constraint hr_salary_payments_scope_check check(scope_end>=scope_start and scope_end<=scope_start+365)
    );
    alter table private.hr_doctor_salary_payment_items add unique(finding_id),
      add foreign key(payment_id) references public.hr_salary_payments(id) on delete cascade,
      add column doctor_name text,add column patient_id uuid,add column patient_name text,add column completed_at timestamptz,
      add column operation_id uuid,add column operation_code text,add column operation_name text,
      add column procedure_quantity numeric,add column gross_amount numeric,add column compensation_type text,add column compensation_rate numeric;
    update public.patients set chart_state=jsonb_set(jsonb_set(chart_state,
      '{${uuid(12)},completedAt}','"2023-03-15T10:00:00Z"'),'{${uuid(16)},completedAt}','"2024-07-10T10:00:00Z"');
    insert into private.hr_doctor_salary_transfers
      select '${uuid(12)}'::uuid,12,'${uuid(1)}'::uuid,'whole','[{"finding_id":"${uuid(12)}","doctor_id":"${uuid(1)}","percentage":100}]'::jsonb,chart_state->'${uuid(12)}' from patients
      union all select '${uuid(16)}',16,'${uuid(1)}','whole','[{"finding_id":"${uuid(16)}","doctor_id":"${uuid(1)}","percentage":100}]',chart_state->'${uuid(16)}' from patients
      union all select '${uuid(13)}',13,null,'steps','[{"finding_id":"${uuid(14)}","doctor_id":"${uuid(1)}","percentage":33.33,"step_name":"Preparation"},{"finding_id":"${uuid(15)}","doctor_id":"${uuid(2)}","percentage":66.67,"step_name":"Final"}]',chart_state->'${uuid(13)}' from patients;
  `);
  const original = read('20260915103000_doctor_salary_settlements.sql');
  const core = read('20260924160000_assign_diagnosis_fees_to_doctor_salary.sql');
  await db.exec(core.slice(core.indexOf('CREATE OR REPLACE FUNCTION private.hr_doctor_payroll_case_lines(')));
  const start = original.indexOf('create or replace function public.get_hr_doctor_payroll_cases(');
  await db.exec(original.slice(start, original.indexOf('\n$$;', start) + 4));
  const summary = read('20260915124500_add_universal_doctor_compensation.sql');
  await db.exec(summary.slice(summary.indexOf('create or replace function private.hr_doctor_payroll_lines(')));
  await db.exec(read('20261104103228_hr_doctor_payment_releases.sql'));
  const query = async (sql, args = []) => (await db.query(sql, args)).rows;
  const review = (start = '0001-01-01', end = '9999-12-31', doctor = uuid(1)) => query('select * from public.get_hr_doctor_payroll_cases($1,$2,$3)', [start, end, doctor]);
  const release = (id, released = true, doctor = uuid(1)) => query('select public.set_hr_doctor_procedure_release($1,$2,$3,$4,$5)', [doctor, uuid(id), released, '0001-01-01', '9999-12-31']);
  const payable = () => query("select * from private.hr_doctor_payroll_case_lines('0001-01-01','9999-12-31',$1)", [uuid(1)]);
  const pay = (scope, start, end, ids, amount) => query('select * from public.hr_pay_doctor_procedures_with_method($1,$2,$3,$4,$5,$6,$7)', [uuid(1), scope, start, end, ids && ids.map(uuid), uuid(80), amount]);
  const expenseCount = async () => (await query('select count(*)::int n from public.expenses'))[0].n;

  await t.test('month, year and all-time queries include the correct historical completions', async () => {
    assert.equal((await review()).length, 4);
    assert.equal((await review('2023-01-01', '2023-12-31'))[0].finding_id, uuid(12));
    assert.equal((await review('2024-07-01', '2024-07-31')).length, 1);
  });
  await t.test('release persists in review, excludes monthly summary and clinic payroll, and creates no expense', async () => {
    const before = await expenseCount();
    await release(11); await release(11);
    assert.ok((await review()).find(row => row.finding_id === uuid(11)).released_at);
    assert.ok(!(await payable()).some(row => row.finding_id === uuid(11)));
    assert.ok(!(await query("select * from private.hr_doctor_payroll_lines('2026-10-01',$1)", [uuid(1)])).some(row => row.finding_id === uuid(11)));
    assert.ok(!(await query("select * from private.clinic_doctor_invoice_lines('2026-10-01','2026-10-31',$1)", [uuid(1)])).some(row => row.finding_id === uuid(11)));
    assert.equal(await expenseCount(), before);
    assert.equal((await query('select count(*)::int n from private.hr_doctor_salary_releases'))[0].n, 1);
  });
  await t.test('released selections and stale direct payment inserts are rejected; month and day exclude releases', async () => {
    await assert.rejects(pay('cases', '0001-01-01', '9999-12-31', [11], 900), /no longer payable/);
    await assert.rejects(query('insert into private.hr_doctor_salary_payment_items(finding_id,doctor_id,salary_amount) values($1,$2,900)', [uuid(11), uuid(1)]), /payment was released/);
    await assert.rejects(pay('month', '2026-10-01', '2026-10-31', null, 1099.98), /salary changed/);
    const payment = (await pay('day', '2026-10-13', '2026-10-13', null, 199.98))[0];
    assert.equal(Number(payment.total_amount), 199.98);
    assert.equal(payment.case_count, 1);
    assert.equal((await review()).find(row => row.finding_id === uuid(14)).payment_id, payment.id);
    await assert.rejects(release(14), /Paid procedures cannot be released/);
    await query('delete from public.expenses where id=$1', [payment.expense_id]);
    assert.equal((await review()).find(row => row.finding_id === uuid(14)).payment_id, null);
    const monthly = (await pay('month', '2026-10-01', '2026-10-31', null, 199.98))[0];
    assert.equal(monthly.case_count, 1);
    await query('delete from public.expenses where id=$1', [monthly.expense_id]);
  });
  await t.test('restore makes a share payable and split-doctor releases remain independent', async () => {
    await release(11, false); assert.equal((await review()).find(row => row.finding_id === uuid(11)).released_at, null);
    assert.ok((await payable()).some(row => row.finding_id === uuid(11)));
    await release(14);
    assert.equal((await review('2026-10-01', '2026-10-31', uuid(2)))[0].released_at, null);
    assert.equal((await query("select * from private.hr_doctor_payroll_case_lines('2026-10-01','2026-10-31',$1)", [uuid(2)])).length, 1);
  });
  await t.test('all-time selected settlement spans years, stores actual dates, and prevents duplicate payment', async () => {
    const payment = (await pay('cases', '0001-01-01', '9999-12-31', [12, 16], 540))[0];
    assert.equal(Number(payment.total_amount), 540);
    assert.equal(payment.scope_start.toISOString().slice(0, 10), '2023-03-15'); assert.equal(payment.scope_end.toISOString().slice(0, 10), '2024-07-10');
    assert.equal(payment.pay_month.getUTCFullYear(), new Date().getUTCFullYear());
    assert.equal((await review()).filter(row => row.payment_id).length, 2);
    await assert.rejects(pay('cases', '0001-01-01', '9999-12-31', [12, 16], 540), /no longer payable/);
    await assert.rejects(pay('day', '2023-01-01', '2026-01-01', null, 100), /valid completion date range/);
  });
  await t.test('diagnosis-fee shares use the same release and restore rules', async () => {
    await db.exec(`
      insert into public.appointments values('${uuid(21)}','${uuid(10)}','Completed','2025-06-01T10:00:00Z');
      insert into public.patient_invoices values(21,'${uuid(10)}','unpaid');
      insert into public.patient_invoice_items values(21,21,'${uuid(21)}','${uuid(4)}','diagnosis_fee','C',300,1,'${uuid(1)}','${uuid(21)}');
      insert into private.hr_doctor_salary_transfers values('${uuid(21)}',21,'${uuid(1)}','whole','[]',jsonb_build_object('doctor_id','${uuid(1)}','appointment_id','${uuid(21)}'));
    `);
    assert.equal(Number((await review('2025-01-01', '2025-12-31'))[0].salary_amount), 90);
    await release(21); assert.ok(!(await payable()).some(row => row.finding_id === uuid(21)));
    await release(21, false); assert.ok((await payable()).some(row => row.finding_id === uuid(21)));
  });
  await t.test('anonymous users, read-only HR users, and direct table access cannot change releases', async () => {
    await db.exec('set role anon'); await assert.rejects(release(11), /permission denied/);
    await db.exec("reset role; set role authenticated; select set_config('test.access','hr',false)");
    assert.ok((await review()).length);
    await assert.rejects(release(11), /HR modify access/);
    await assert.rejects(query('select * from private.hr_doctor_salary_releases'), /permission denied/);
    await db.exec("reset role; select set_config('test.access','admin',false); select set_config('test.actor','',false)");
    await assert.rejects(release(11), /HR modify access/);
    await db.exec(`select set_config('test.actor','${uuid(1)}',false)`);
    await assert.rejects(release(999), /no longer available/);
    assert.equal((await query("select relrowsecurity from pg_class where oid='private.hr_doctor_salary_releases'::regclass"))[0].relrowsecurity, true);
  });
});
