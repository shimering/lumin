-- Read-only production checks. All role/settings changes roll back; no payroll is paid.
begin;
select set_config('request.jwt.claim.sub',(select profile.user_id::text
  from public.user_profiles profile join public.access_roles role on role.id=profile.role_id
  where profile.active and role.is_admin limit 1),true);
set local role authenticated;
do $$
declare report jsonb; payroll jsonb; doctor record; test_day date; expected numeric; zone text;
begin
  select coalesce(nullif(attendance_timezone,''),'Africa/Cairo') into zone from public.clinic_settings where id=1;
  report:=public.get_clinic_management_overview('2026-10-01','2026-10-13');
  if jsonb_array_length(report#>'{finance,days}')<>13 then raise exception 'Missing calendar days';end if;
  select coalesce(sum(amount),0) into expected from public.invoice_payments where payment_date between '2026-10-01' and '2026-10-13';
  if (report#>>'{finance,income_total}')::numeric<>expected then raise exception 'Income does not match the ledger';end if;
  if (report#>>'{finance,expense_total}')::numeric<>coalesce((select sum((value->>'amount')::numeric) from jsonb_array_elements(report#>'{finance,expense_types}')),0) then
    raise exception 'Expense categories do not match paid total';end if;
  if (report#>>'{finance,net_total}')::numeric<>(report#>>'{finance,income_total}')::numeric-(report#>>'{finance,expense_total}')::numeric then raise exception 'Net cash does not reconcile';end if;
  for doctor in select user_id from public.user_profiles where active and is_doctor loop
    foreach test_day in array array[(now() at time zone zone)::date,(now() at time zone zone)::date-1] loop
      payroll:=public.get_clinic_doctor_day_payroll(test_day,doctor.user_id);
      select coalesce(sum(salary_amount),0) into expected from public.get_hr_doctor_payroll_cases(test_day,test_day,doctor.user_id) where payment_id is null;
      if (payroll->>'ready_amount')::numeric<>expected then raise exception 'Day total differs from existing HR settlement';end if;
      if (public.get_clinic_doctor_day_payroll(test_day,doctor.user_id,1,1,true)->>'ready_amount')::numeric<>expected then raise exception 'Paging/filter changed payment total';end if;
    end loop;
  end loop;
  if has_function_privilege('anon','public.get_clinic_management_overview(date,date)','execute')
    or has_function_privilege('anon','public.get_clinic_doctor_day_payroll(date,uuid,integer,integer,boolean)','execute')
    or has_function_privilege('authenticated','private.clinic_doctor_invoice_lines(date,date,uuid)','execute') then raise exception 'Private payroll projection exposed';end if;
  perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  begin perform public.get_clinic_management_overview('2026-10-01','2026-10-13');raise exception 'Unauthorized user accepted';exception when insufficient_privilege then null;end;
  perform set_config('request.jwt.claim.sub','',true);
  begin perform public.get_clinic_doctor_day_payroll('2026-10-13');raise exception 'Signed-out payroll accepted';exception when insufficient_privilege then null;end;
end;
$$;
rollback;
