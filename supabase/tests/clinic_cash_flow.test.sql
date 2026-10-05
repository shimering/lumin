-- Real ledger totals and permission checks; no financial records are changed.
begin;
select set_config('request.jwt.claim.sub', (select profile.user_id::text
  from public.user_profiles profile join public.access_roles role on role.id=profile.role_id
  where profile.active and role.is_admin limit 1), true);
set local role authenticated;
do $$
declare
  result jsonb; row jsonb; month_start date; month_end date;
  expected_income numeric; expected_expense numeric; expected_legacy numeric;
begin
  result := public.get_clinic_cash_flow('2026-01-01','2026-12-31');
  if jsonb_array_length(result->'months') <> 12 then raise exception 'Missing zero-activity months'; end if;
  -- Totals are checked per month independently of the function's grouped joins.
  for row in select value from jsonb_array_elements(result->'months') loop
    month_start := (row->>'month' || '-01')::date;
    month_end := (month_start + interval '1 month - 1 day')::date;
    -- The active admin fixture also has table access for these independent reads.
    select coalesce(sum(amount),0) into expected_income from public.invoice_payments
      where payment_date between month_start and month_end;
    select coalesce(sum(amount),0) into expected_expense from public.expense_payment_entries
      where payment_date between month_start and month_end and amount > 0;
    select coalesce(sum(greatest(e.paid_amount-coalesce((select sum(p.amount)
      from public.expense_payment_entries p where p.expense_id=e.id),0),0)),0)
      into expected_legacy from public.expenses e where expense_date between month_start and month_end;
    if (row->>'income')::numeric <> expected_income
      or (row->>'expense')::numeric <> expected_expense + expected_legacy
      or (row->>'net')::numeric <> expected_income-expected_expense-expected_legacy
      or (row->>'legacy_expense')::numeric <> expected_legacy then
      raise exception 'Monthly cash flow differs from ledger: %', row->>'month';
    end if;
  end loop;
  if (result->>'income_total')::numeric <> (select sum((value->>'income')::numeric) from jsonb_array_elements(result->'months'))
    or (result->>'expense_total')::numeric <> (select sum((value->>'expense')::numeric) from jsonb_array_elements(result->'months')) then
    raise exception 'Chart and summary totals differ';
  end if;
  result := public.get_clinic_cash_flow('1900-02-01','1900-02-28');
  if jsonb_array_length(result->'months') <> 1 or (result->>'net_total')::numeric <> 0 then raise exception 'Empty single month failed'; end if;
  result := public.get_clinic_cash_flow('2024-02-01','2024-02-29');
  if jsonb_array_length(result->'months') <> 1 then raise exception 'Leap month failed'; end if;
  result := public.get_clinic_cash_flow('2024-01-01','2026-12-31');
  if jsonb_array_length(result->'months') <> 36 then raise exception '36 month boundary failed'; end if;
  begin perform public.get_clinic_cash_flow('2026-02-01','2026-01-31'); raise exception 'Reversed range accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.get_clinic_cash_flow('2026-01-02','2026-02-28'); raise exception 'Partial month accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.get_clinic_cash_flow('2024-01-01','2027-01-31'); raise exception 'Oversized range accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.get_clinic_cash_flow(null,'2026-01-31'); raise exception 'Null range accepted'; exception when invalid_parameter_value then null; end;
  if has_function_privilege('anon','public.get_clinic_cash_flow(date,date)','execute')
    or has_function_privilege('anon','private.build_clinic_cash_flow(date,date)','execute') then raise exception 'Anonymous cash flow exposed'; end if;
  perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  begin perform public.get_clinic_cash_flow('2026-01-01','2026-12-31'); raise exception 'Unauthorized user accepted'; exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub','',true);
  begin perform public.get_clinic_cash_flow('2026-01-01','2026-12-31'); raise exception 'Signed-out user accepted'; exception when insufficient_privilege then null; end;
end;
$$;
rollback;
