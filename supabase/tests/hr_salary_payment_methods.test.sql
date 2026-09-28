-- All salary fixtures, settlements, and delivery events roll back. No HTTP dispatch is called.
begin;
do $test$
declare
  actor uuid; staff_a uuid; staff_b uuid; cash uuid; bank uuid; method uuid;
  month_value date := date '2099-01-01'; settings public.finance_sync_settings;
  payment public.hr_salary_payments; entry public.expense_payment_entries; event public.finance_sync_events;
  doctor_case record; routes jsonb; count_before bigint; batch_count integer;
begin
  select profile.user_id into actor from public.user_profiles profile join public.access_roles role on role.id=profile.role_id where profile.active and role.is_admin limit 1;
  if actor is null then raise exception 'Admin fixture required'; end if;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
  select id into cash from public.payment_methods where active and lower(name)='cash';
  select id into bank from public.payment_methods where active and lower(replace(name,' ',''))='instapay';
  if cash is null or bank is null then raise exception 'Cash and InstaPay fixtures required'; end if;
  select * into settings from public.finance_sync_settings where id;
  update public.finance_sync_settings set enabled=false,sync_expenses=true where id;
  routes:=public.get_hr_salary_payment_methods();
  if not exists(select 1 from jsonb_array_elements(routes->'methods') value where value->>'id'=cash::text and value->>'account_id'=settings.payment_routes->>cash::text) then raise exception 'HR route preview differs from saved mapping'; end if;
  if routes ? 'secret' or routes ? 'events' then raise exception 'HR received private sync details'; end if;
  select user_id into staff_a from public.user_profiles where active and not is_doctor order by user_id limit 1;
  select user_id into staff_b from public.user_profiles where active and not is_doctor and user_id<>staff_a order by user_id limit 1;
  if staff_a is null or staff_b is null then raise exception 'Two staff fixtures required'; end if;
  while exists(select 1 from public.hr_payroll_periods where pay_month=month_value) loop month_value:= (month_value+interval '1 month')::date; end loop;
  insert into public.hr_staff_settings(user_id) values(staff_a),(staff_b) on conflict do nothing;
  insert into public.hr_payroll_periods(pay_month,status) values(month_value,'draft');
  insert into public.hr_extra_shifts(user_id,shift_date,shift_count,rate,approved,note) values(staff_a,month_value,1,100,true,'Rollback salary test'),(staff_b,month_value,1,200,true,'Rollback salary test');
  update public.hr_payroll_periods set status='locked' where pay_month=month_value;
  select count(*) into count_before from public.finance_sync_events;
  begin
    perform public.hr_pay_salary_with_method(staff_a,month_value,null,100);
    raise exception 'Missing method accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.hr_pay_salary_with_method(staff_a,month_value,cash,99);
    raise exception 'Changed salary accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.hr_pay_staff_batch_with_method(month_value,bank,jsonb_build_array(jsonb_build_object('user_id',staff_a,'expected_amount',100),jsonb_build_object('user_id',staff_b,'expected_amount',201)));
    raise exception 'Changed batch accepted';
  exception when invalid_parameter_value then null; end;
  if exists(select 1 from public.hr_salary_payments where pay_month=month_value) or (select count(*) from public.finance_sync_events)<>count_before then raise exception 'Rejected payment left partial salary or sync events'; end if;
  -- Individual staff payments route one expense and one event each.
  begin
    foreach method in array array[cash,bank] loop
      payment:=public.hr_pay_salary_with_method(case when method=cash then staff_a else staff_b end,month_value,method,case when method=cash then 100 else 200 end);
      select * into entry from public.expense_payment_entries where expense_id=payment.expense_id;
      select * into event from public.finance_sync_events where source_key='expense:'||entry.id order by id desc limit 1;
      if entry.payment_method_id is distinct from method or entry.amount<>payment.total_amount or event.payment_method_id is distinct from method or event.payload->>'account_id' is distinct from settings.payment_routes->>method::text or event.status<>'pending' then raise exception 'Staff salary routing failed'; end if;
      if (select count(*) from public.expense_payment_entries where expense_id=payment.expense_id)<>1 then raise exception 'Staff salary created duplicate entries'; end if;
    end loop;
    raise exception using errcode='ZX001',message='Rollback individual staff fixtures';
  exception when sqlstate 'ZX001' then null; end;
  batch_count:=public.hr_pay_staff_batch_with_method(month_value,bank,jsonb_build_array(jsonb_build_object('user_id',staff_a,'expected_amount',100),jsonb_build_object('user_id',staff_b,'expected_amount',200)));
  if batch_count<>2 or (select status from public.hr_payroll_periods where pay_month=month_value)<>'paid' then raise exception 'Batch did not settle and finalize payroll'; end if;
  if exists(select 1 from public.expense_payment_entries ep join public.hr_salary_payments sp on sp.expense_id=ep.expense_id where sp.pay_month=month_value and ep.payment_method_id is distinct from bank) then raise exception 'Batch lost the chosen method'; end if;
  -- Use an eligible case without committing a settlement or exposing patient data.
  select line.* into doctor_case from private.hr_doctor_payroll_case_lines('2026-01-01','2026-12-31',null) line where salary_amount>0 and not exists(select 1 from private.hr_doctor_salary_payment_items paid where paid.finding_id=line.finding_id) limit 1;
  if doctor_case is null then raise exception 'Unpaid doctor case fixture required'; end if;
  foreach method in array array[cash,bank] loop
    begin
      payment:=public.hr_pay_doctor_procedures_with_method(doctor_case.doctor_id,'cases','2026-01-01','2026-12-31',array[doctor_case.finding_id],method,doctor_case.salary_amount);
      select * into entry from public.expense_payment_entries where expense_id=payment.expense_id;
      select * into event from public.finance_sync_events where source_key='expense:'||entry.id order by id desc limit 1;
      if entry.payment_method_id is distinct from method or event.payload->>'account_id' is distinct from settings.payment_routes->>method::text or event.status<>'pending' or entry.amount<>doctor_case.salary_amount then raise exception 'Doctor settlement routing failed'; end if;
      begin
        perform public.hr_pay_doctor_procedures_with_method(doctor_case.doctor_id,'cases','2026-01-01','2026-12-31',array[doctor_case.finding_id],method,doctor_case.salary_amount);
        raise exception 'Duplicate case accepted';
      exception when invalid_parameter_value or unique_violation then null; end;
      raise exception using errcode='ZX001',message='Rollback doctor fixture';
    exception when sqlstate 'ZX001' then null; end;
  end loop;
  if has_function_privilege('anon','public.hr_pay_salary_with_method(uuid,date,uuid,numeric)','execute') or has_function_privilege('anon','public.get_hr_salary_payment_methods()','execute') then raise exception 'Anonymous payroll access exposed'; end if;
  perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
  perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}',true);
  begin
    perform public.get_hr_salary_payment_methods();
    raise exception 'Non-HR route access accepted';
  exception when insufficient_privilege then null; end;
  begin
    perform public.hr_pay_salary_with_method(staff_a,month_value,cash,100);
    raise exception 'Non-HR salary payment accepted';
  exception when insufficient_privilege then null; end;
end; $test$;
rollback;
select 'Salary method, routing, duplicate, batch rollback, and access checks passed; all fixtures rolled back.' as result;
