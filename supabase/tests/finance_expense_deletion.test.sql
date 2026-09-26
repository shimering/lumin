-- Every expense, HR payment, sync event and permission fixture is rolled back.
begin;
do $$
declare
  v_actor uuid; v_type uuid; v_cash uuid; v_expense uuid; v_entry uuid;
  v_staff uuid; v_doctor uuid; v_payment uuid; v_month date := '2099-12-01';
  v_result jsonb; v_role uuid; v_finance_actor uuid; v_old_role uuid;
begin
  select p.user_id into v_actor from public.user_profiles p join public.access_roles r on r.id=p.role_id where p.active and r.is_admin limit 1;
  perform set_config('request.jwt.claim.sub',v_actor::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_actor,'role','authenticated')::text,true);
  select id into v_type from public.expense_types where active limit 1;
  select id into v_cash from public.payment_methods where lower(name)='cash';
  insert into public.expenses(name,expense_type_id,total,paid_amount,quantity,expense_date,sync_payment_method_id)
    values('Expense deletion verification',v_type,100,100,1,current_date,v_cash) returning id into v_expense;
  select id into v_entry from public.expense_payment_entries where expense_id=v_expense;
  if v_entry is null then raise exception 'Paid deletion fixture has no sync payment'; end if;
  -- The RPC must enforce Finances access even though it runs as SECURITY DEFINER.
  perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  begin
    perform public.delete_finance_expense(v_expense);
    raise exception 'An unauthorized caller deleted an expense';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub',v_actor::text,true);
  v_result := public.delete_finance_expense(v_expense);
  if v_result->>'expense_id'<>v_expense::text or exists(select 1 from public.expenses where id=v_expense) then raise exception 'Expense deletion did not complete'; end if;
  if exists(select 1 from public.expense_payment_entries where expense_id=v_expense) then raise exception 'Deletion left payment installments'; end if;
  if not exists(select 1 from public.finance_sync_events where source_key='expense:'||v_entry and operation='delete' and status='pending') then raise exception 'Deletion did not queue a Baytna reversal'; end if;
  begin
    perform public.delete_finance_expense(v_expense);
    raise exception 'Repeated deletion reported success';
  exception when invalid_parameter_value then null; end;
  -- A paid staff payroll becomes locked again, while remaining payments stay intact.
  insert into public.hr_payroll_periods(pay_month,status,paid_at,paid_by) values(v_month,'paid',now(),v_actor);
  insert into public.expenses(name,expense_type_id,total,paid_amount,quantity,expense_date)
    values('Staff deletion verification',v_type,100,100,1,v_month) returning id into v_staff;
  insert into public.expenses(name,expense_type_id,total,paid_amount,quantity,expense_date)
    values('Doctor deletion verification',v_type,100,100,1,v_month) returning id into v_doctor;
  insert into public.hr_salary_payments(user_id,pay_month,attended_shifts,regular_shift_rate,regular_amount,extra_amount,performance_amount,total_amount,expense_id,paid_by,payment_kind)
    values(v_actor,v_month,0,0,100,0,0,100,v_staff,v_actor,'staff_monthly');
  insert into public.hr_salary_payments(user_id,pay_month,attended_shifts,regular_shift_rate,regular_amount,extra_amount,performance_amount,total_amount,expense_id,paid_by,payment_kind,scope_start,scope_end)
    values(v_actor,v_month,0,0,100,0,0,100,v_doctor,v_actor,'doctor_day',v_month,v_month) returning id into v_payment;
  -- A Finances-only caller cannot undo HR payments.
  insert into public.access_roles(name,is_admin) values('Expense deletion test role',false) returning id into v_role;
  insert into public.role_permissions(role_id,page_key,can_view,can_modify) values(v_role,'finances',true,true);
  select user_id,role_id into v_finance_actor,v_old_role from public.user_profiles where user_id<>v_actor and active limit 1;
  if v_finance_actor is null then raise exception 'A second active profile is required for permission verification'; end if;
  update public.user_profiles set role_id=v_role where user_id=v_finance_actor;
  perform set_config('request.jwt.claim.sub',v_finance_actor::text,true);
  begin
    perform public.delete_finance_expense(v_staff);
    raise exception 'Finances-only caller deleted an HR payment';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub',v_actor::text,true);
  update public.user_profiles set role_id=v_old_role where user_id=v_finance_actor;
  v_result := public.delete_finance_expense(v_staff);
  if v_result->>'salary_kind'<>'staff_monthly' or exists(select 1 from public.hr_salary_payments where expense_id=v_staff) then raise exception 'Staff payment was not reopened'; end if;
  if not exists(select 1 from public.hr_payroll_periods where pay_month=v_month and status='locked' and paid_at is null and paid_by is null) then raise exception 'Payroll remained paid after removing a staff payment'; end if;
  if not exists(select 1 from public.hr_salary_payments where id=v_payment) then raise exception 'An unrelated payment was removed'; end if;
  v_result := public.delete_finance_expense(v_doctor);
  if v_result->>'salary_kind'<>'doctor_day' or exists(select 1 from public.hr_salary_payments where id=v_payment) or exists(select 1 from public.expenses where id=v_doctor) then raise exception 'Doctor payment was not reopened'; end if;
  if has_function_privilege('anon','public.delete_finance_expense(uuid)','execute') then raise exception 'Anonymous delete is exposed'; end if;
  if not has_function_privilege('authenticated','public.delete_finance_expense(uuid)','execute') then raise exception 'Authenticated delete is unavailable'; end if;
end; $$;
rollback;
