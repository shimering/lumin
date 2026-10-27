-- Read-only parity, authorization and projection checks. No salaries are paid.
begin;
set local statement_timeout = '20s';

do $$
declare mismatches integer;
begin
  -- Compare the optimized lookup with the original full-chart projection for
  -- every finding in charts currently used by the salary transfer ledger.
  with charts as materialized (
    select distinct patient.id, patient.chart_state
    from private.hr_doctor_salary_transfers transfer
    join public.patient_invoice_items item on item.id = transfer.invoice_item_id
    join public.patient_invoices invoice on invoice.id = item.invoice_id
    join public.patients patient on patient.id = invoice.patient_id
  ), expected as materialized (
    select distinct on (chart.id, row.finding_id) chart.id, row.finding_id, row.finding
    from charts chart cross join lateral private.patient_chart_finding_rows(chart.chart_state) row
    where row.finding_id is not null
    order by chart.id, row.finding_id,
      case row.finding_kind when 'mouth' then 1 when 'whole' then 2 when 'surface' then 3 else 4 end
  )
  select count(*) into mismatches
  from expected join charts chart on chart.id = expected.id
  where private.chart_finding_by_id(chart.chart_state, expected.finding_id) is distinct from expected.finding;
  if mismatches <> 0 then raise exception 'Finding lookup changed % chart projections', mismatches; end if;
  if has_function_privilege('authenticated','private.chart_finding_by_id(jsonb,uuid)','execute')
    or has_function_privilege('anon','private.chart_finding_by_id(jsonb,uuid)','execute') then
    raise exception 'Internal lookup must not be directly exposed';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', (select profile.user_id::text
  from public.user_profiles profile join public.access_roles role on role.id = profile.role_id
  where profile.active and role.is_admin limit 1), true);
set local role authenticated;

do $$
declare month_start date := date_trunc('month', now() at time zone 'Africa/Cairo')::date;
  month_end date; summary numeric; day_value date; doctor uuid;
begin
  month_end := (month_start + interval '1 month - 1 day')::date;
  select coalesce(sum(salary_amount),0) into summary from public.get_hr_doctor_payroll(month_start);
  -- Exercise the public API after the internal lookup ACL/configuration change.
  perform count(*) from public.get_hr_doctor_payroll_cases(month_start, month_end, null);
  perform public.get_clinic_management_overview(month_start, month_end);
  select user_id into doctor from public.user_profiles where active and is_doctor order by user_id limit 1;
  day_value := (now() at time zone 'Africa/Cairo')::date;
  perform public.get_clinic_doctor_day_payroll(day_value, doctor, 1, 20, false);
  if summary < 0 then raise exception 'Unexpected negative aggregate compensation'; end if;
  perform set_config('request.jwt.claim.sub','',true);
  begin
    perform count(*) from public.get_hr_doctor_payroll(month_start);
    raise exception 'Signed-out payroll access was accepted';
  exception when insufficient_privilege then null; end;
end;
$$;
rollback;
