const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const root=path.resolve(__dirname,'..');
const migrationFile='20261013212226_automatic_procedure_payroll_on_invoice.sql';
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');

test('invoiced procedures enter payroll automatically and wait for explicit HR settlement',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(fs.readFileSync(path.join(__dirname,'fixtures/clinic-management.sql'),'utf8'));
  await db.exec(`
    alter table public.patient_invoices add column created_by uuid;
    alter table private.hr_doctor_salary_transfers add primary key(finding_id),
      add column transferred_by uuid,add column transferred_at timestamptz default now();
    create function private.patient_chart_finding_rows(state jsonb) returns table(finding_id uuid,operation_status text)
      language sql as $$select key::uuid,value->>'status' from jsonb_each(state)$$;
    create function private.sync_patient_invoice_item_statuses_from_chart() returns trigger language plpgsql as $$
    begin
      with current_statuses as (
        select item.id invoice_item_id,min(finding.operation_status) operation_status
        from public.patient_invoice_items item join public.patient_invoices invoice on invoice.id=item.invoice_id and invoice.patient_id=new.id
        cross join lateral private.patient_chart_finding_rows(new.chart_state) finding
        where item.finding_id=finding.finding_id and finding.operation_status in('P','In','C','E')
        group by item.id having count(distinct finding.operation_status)=1
      ) update public.patient_invoice_items item set operation_status=current_status.operation_status
        from current_statuses current_status where item.id=current_status.invoice_item_id
        and item.operation_status is distinct from current_status.operation_status;
      return new;
    end; $$;
    create trigger sync_patient_invoice_item_statuses_from_chart after update of chart_state on public.patients
      for each row when(old.chart_state is distinct from new.chart_state)
      execute function private.sync_patient_invoice_item_statuses_from_chart();
    update public.patients set chart_state=jsonb_set(jsonb_set(chart_state,
      '{${uuid(13)},steps,0,status}','"C"'),'{${uuid(13)},steps,1,status}','"C"');
    insert into private.hr_doctor_salary_payment_items values('${uuid(11)}','${uuid(1)}',850,'${uuid(99)}');
  `);
  const assignments=fs.readFileSync(path.join(root,'supabase/migrations/20260924091500_split_doctor_salary_by_procedure_steps.sql'),'utf8');
  await db.exec(assignments.slice(assignments.indexOf('create or replace function private.doctor_salary_assignment_signature('),assignments.indexOf('-- Existing transfers')));
  await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261013143556_clinic_management_overview.sql'),'utf8'));
  const originalPaid=(await db.query('select * from private.hr_doctor_salary_transfers where finding_id=$1',[uuid(11)])).rows[0];
  await db.exec(fs.readFileSync(path.join(root,'supabase/migrations',migrationFile),'utf8'));
  const ledger=async id=>(await db.query('select * from private.hr_doctor_salary_transfers where finding_id=$1',[uuid(id)])).rows[0];
  const call=async sql=>(await db.query('select '+sql+' result')).rows[0].result;
  const finding=async(id,value)=>db.query('update public.patients set chart_state=jsonb_set(chart_state,$1::text[],$2::jsonb) where id=$3',[[uuid(id)],JSON.stringify(value),uuid(10)]);
  const invoice=async(id,findingId,status='C',price=600)=>{
    await db.query("insert into public.patient_invoices(id,patient_id,status,created_by) values($1,$2,'unpaid',$3)",[id,uuid(10),uuid(1)]);
    await db.query(`insert into public.patient_invoice_items(id,invoice_id,finding_id,operation_id,operation_code,operation_status,unit_price,quantity)
      values($1,$1,$2,$3,'composite',$4,$5,1)`,[id,uuid(findingId),uuid(3),status,price]);
  };
  const completed={status:'C',doctorId:uuid(1),completedAt:'2026-10-13T10:00:00Z'};

  await t.test('installation preserves historical records; later invoice updates include unpaid cases in HR',async()=>{
    assert.deepEqual(await ledger(11),originalPaid,'Existing paid salary allocation is never rewritten');
    assert.equal(await ledger(12),undefined,'Installing automation does not backfill historical procedures');
    assert.equal(await ledger(13),undefined);
    await db.exec('update public.patient_invoice_items set unit_price=unit_price where id in(12,13,16)');
    assert.equal((await ledger(12)).assignment_mode,'whole');
    const split=await ledger(13);assert.equal(split.assignment_mode,'steps');
    assert.deepEqual(split.allocations.map(row=>[row.doctor_id,row.percentage]),[[uuid(1),33.33],[uuid(2),66.67]]);
    const day=await call(`public.get_clinic_doctor_day_payroll('2026-10-13','${uuid(1)}')`);
    assert.equal(day.ready_amount,739.98);assert.equal(day.untransferred_amount,0);
    const filtered=await call(`public.get_clinic_doctor_day_payroll('2026-10-13','${uuid(1)}',1,1,true)`);
    assert.equal(filtered.total_count,3);assert.equal(filtered.ready_amount,739.98,'Pagination does not define the payroll total');
    const overview=await call("public.get_clinic_management_overview('2026-10-13','2026-10-13')");
    assert.equal(overview.hr.payroll_doctor_count,2);assert.equal(overview.hr.payroll_invoice_count,3);assert.equal(overview.hr.payroll_amount,873.32);
    assert.equal((await db.query('select count(*)::int count from private.hr_doctor_salary_payment_items')).rows[0].count,1,'Automatic inclusion never makes a salary payment');
  });
  await t.test('a completed procedure becomes ready when invoiced and repeated updates are idempotent',async()=>{
    await finding(20,completed);assert.equal(await ledger(20),undefined);
    await invoice(20,20);const transfer=await ledger(20);
    assert.equal(transfer.doctor_id,uuid(1));assert.equal(transfer.transferred_by,uuid(1));
    await db.query('update public.patient_invoice_items set unit_price=unit_price where id=20');
    assert.deepEqual(await ledger(20),transfer);
  });
  await t.test('an earlier invoice becomes payable after clinical completion and later doctor assignment',async()=>{
    await finding(21,{...completed,status:'In'});await invoice(21,21,'In');assert.equal(await ledger(21),undefined);
    await finding(21,completed);assert.equal((await ledger(21)).doctor_id,uuid(1));
    await finding(22,{...completed,doctorId:null});await invoice(22,22);assert.equal(await ledger(22),undefined);
    await finding(22,completed);assert.equal((await ledger(22)).doctor_id,uuid(1));
    await finding(22,{...completed,doctorId:uuid(2)});assert.equal((await ledger(22)).doctor_id,uuid(2),'Unpaid assignments follow the current doctor');
  });
  await t.test('incomplete splits, cancelled invoices, zero amounts and inactive doctors stay out of payable payroll',async()=>{
    const steps=[{id:'first',payrollFindingId:uuid(31),doctorId:uuid(1),percentage:50,status:'C'},
      {id:'second',payrollFindingId:uuid(32),doctorId:uuid(2),percentage:50,status:'In'}];
    await finding(30,{...completed,doctorId:null,steps});await invoice(30,30);assert.equal(await ledger(30),undefined);
    steps[1].status='C';await finding(30,{...completed,doctorId:null,steps});assert.equal((await ledger(30)).allocations.length,2);
    await finding(40,completed);await invoice(40,40,'C',0);assert.equal(await ledger(40),undefined);
    await db.query('insert into public.user_profiles values($1,$2,false,true)',[uuid(5),'Inactive doctor']);
    await finding(41,{...completed,doctorId:uuid(5)});await invoice(41,41);assert.equal(await ledger(41),undefined);
    await db.query('update public.user_profiles set active=true where user_id=$1',[uuid(5)]);assert.equal((await ledger(41)).doctor_id,uuid(5));
    await finding(42,completed);await db.query("insert into public.patient_invoices(id,patient_id,status) values(42,$1,'cancelled')",[uuid(10)]);
    await db.query("insert into public.patient_invoice_items(id,invoice_id,finding_id,operation_id,operation_code,operation_status,unit_price,quantity) values(42,42,$1,$2,'composite','C',600,1)",[uuid(42),uuid(3)]);
    assert.equal(await ledger(42),undefined);await db.query("update public.patient_invoices set status='unpaid' where id=42");assert.equal((await ledger(42)).doctor_id,uuid(1));
  });
  await t.test('a linked expense under another doctor preserves the ledger and no payment records are created',async()=>{
    const before=await ledger(22);
    await db.query('insert into private.hr_doctor_salary_payment_items values($1,$2,180,$3)',[uuid(22),uuid(2),uuid(98)]);
    await finding(22,completed);assert.deepEqual(await ledger(22),before);
    assert.equal((await db.query('select count(*)::int count from private.hr_doctor_salary_payment_items')).rows[0].count,2);
    const privileges=(await db.query("select has_function_privilege('authenticated','private.sync_procedure_salary_transfer(bigint)','execute') direct,has_function_privilege('anon','private.auto_transfer_procedure_salary()','execute') anonymous")).rows[0];
    assert.equal(privileges.direct,false);assert.equal(privileges.anonymous,false);
    await db.exec("select set_config('test.access','analytics',false)");
    assert.equal((await call("public.get_clinic_management_overview('2026-10-13','2026-10-13')")).hr,null);
    await assert.rejects(call("public.get_clinic_doctor_day_payroll('2026-10-13')"),/HR access/);
  });
});
