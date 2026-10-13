const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const api=require('../lumin-clinic-management.js');
test('overview ranges use actual calendar dates and limit payload size',()=>{
  assert.equal(api.validRange('2024-02-29','2024-02-29'),true);
  assert.equal(api.validRange('2026-02-29','2026-03-01'),false);
  assert.equal(api.validRange('2026-10-13','2026-10-12'),false);
  assert.equal(api.validRange('2026-01-01','2027-01-01'),true);
  assert.equal(api.validRange('2026-01-01','2027-01-02'),false);
  assert.equal(api.validRange('','2026-01-01'),false);
});
test('cash chart sums daily payments, retaining zero-activity days',()=>{
  assert.deepEqual(api.cumulativeDays([{day:'2026-10-01',income:120,expense:10},{day:'2026-10-02',income:0,expense:0},{day:'2026-10-03',income:30,expense:70}]),[
    {day:'2026-10-01',income:120,expense:10},{day:'2026-10-02',income:120,expense:10},{day:'2026-10-03',income:150,expense:80}]);
});
test('day payroll separates untransferred and already-paid compensation',()=>{
  assert.deepEqual(api.payrollTotals([{transferred:true,doctor_amount:900},{transferred:true,doctor_amount:360},{transferred:false,doctor_amount:180},{transferred:true,payment_id:'paid',doctor_amount:250}]),{ready:1260,pending:180,paid:250});
});
test('SQL projections calculate split shares, snapshots, permissions and ledger accounting',async()=>{
  const {PGlite}=require('@electric-sql/pglite');const db=new PGlite();
  try{
    await db.exec(fs.readFileSync(path.join(__dirname,'fixtures/clinic-management.sql'),'utf8'));
    await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261013143556_clinic_management_overview.sql'),'utf8'));
    await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261013210209_exclude_settled_clinic_salary_alerts.sql'),'utf8'));
    const call=async sql=>(await db.query('select '+sql+' as result')).rows[0].result;
    const day=await call("public.get_clinic_doctor_day_payroll('2026-10-13','00000000-0000-4000-8000-000000000001')");
    assert.equal(day.ready_amount,900);assert.equal(day.untransferred_amount,739.98);assert.equal(day.invoice_count,4);assert.equal(day.rows.length,4);
    assert.equal(day.rows.find(r=>r.invoice_id===3).doctor_amount,199.98);assert.equal(day.rows.find(r=>r.invoice_id===5).doctor_amount,180,'Clinic timezone defines the single day');
    const other=await call("public.get_clinic_doctor_day_payroll('2026-10-13','00000000-0000-4000-8000-000000000002')");
    assert.equal(other.rows[0].doctor_amount,133.34,'Fixed compensation uses allocated quantity');
    const page=await call("public.get_clinic_doctor_day_payroll('2026-10-13','00000000-0000-4000-8000-000000000001',1,1,true)");
    assert.equal(page.rows.length,1);assert.equal(page.total_count,3);assert.equal(page.ready_amount,900,'Pagination never changes settlement totals');
    await db.exec("insert into private.hr_doctor_salary_payment_items values('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000001',850,'00000000-0000-4000-8000-000000000099')");
    const paid=await call("public.get_clinic_doctor_day_payroll('2026-10-13','00000000-0000-4000-8000-000000000001')");
    assert.equal(paid.ready_amount,0);assert.equal(paid.rows.find(r=>r.invoice_id===1).doctor_amount,850,'Paid compensation uses saved snapshots');
    const overview=await call("public.get_clinic_management_overview('2026-10-01','2026-10-03')");
    assert.equal(overview.finance.income_total,225);assert.equal(overview.finance.expense_total,45);assert.equal(overview.finance.net_total,180);
    assert.equal(overview.finance.expense_types[0].amount,45);assert.equal(overview.finance.days.length,3);assert.equal(overview.finance.days[2].income,0);
    assert.equal(overview.hr.untransferred_invoice_count,3);assert.equal(overview.hr.untransferred_doctor_count,2);assert.equal(overview.finance.unpaid_expense_total,30);
    assert.ok(overview.hr.untransferred_preview.some(row=>row.doctor_name==='Dr A'));
    assert.ok(overview.hr.untransferred_preview.some(row=>row.doctor_name==='Dr B'),'Pending invoices for every unpaid doctor appear');
    await db.exec("insert into private.hr_doctor_salary_payment_items values('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000002',300,'00000000-0000-4000-8000-000000000098')");
    const linkedPaid=await call("public.get_clinic_management_overview('2026-10-01','2026-10-03')");
    assert.equal(linkedPaid.hr.untransferred_invoice_count,2,'An invoice item paid under a previous doctor allocation cannot be transferred again');
    assert.equal(linkedPaid.hr.untransferred_amount,513.32);
    assert.ok(linkedPaid.hr.untransferred_preview.every(row=>row.invoice_item_id!==12));
    const existingPayroll=await call("public.get_clinic_doctor_day_payroll('2026-10-13','00000000-0000-4000-8000-000000000001')");
    assert.equal(existingPayroll.untransferred_amount,739.98,'Alert filtering does not change payroll calculations');
    assert.equal((await db.query('select count(*)::int count from private.hr_doctor_salary_payment_items')).rows[0].count,2,'The overview never changes existing salary payments');
    await db.exec("select set_config('test.access','analytics',false)");
    const analytics=await call("public.get_clinic_management_overview('2026-10-01','2026-10-03')");
    assert.equal(analytics.hr,null);assert.equal(analytics.finance.debt_total,undefined);assert.equal(analytics.finance.unpaid_expense_total,null);
    await assert.rejects(call("public.get_clinic_doctor_day_payroll('2026-10-13')"),/HR access/);
    await db.exec("select set_config('test.access','hr',false)");
    const hr=await call("public.get_clinic_management_overview('2026-10-01','2026-10-03')");assert.equal(hr.finance,null);assert.ok(hr.hr);
    await db.exec("select set_config('test.access','none',false)");
    await assert.rejects(call("public.get_clinic_management_overview('2026-10-01','2026-10-03')"),/access is required/);
    await db.exec("select set_config('test.access','admin',false),set_config('test.actor','',false)");
    await assert.rejects(call("public.get_clinic_management_overview('2026-10-01','2026-10-03')"),/access is required/);
    const privileges=await db.query("select has_function_privilege('anon','public.get_clinic_management_overview(date,date)','execute') allowed,has_function_privilege('authenticated','private.clinic_doctor_invoice_lines(date,date,uuid)','execute') direct");
    assert.equal(privileges.rows[0].allowed,false);assert.equal(privileges.rows[0].direct,false);
  }finally{await db.close();}
});
