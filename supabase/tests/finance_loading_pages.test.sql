-- Read-only regression checks; session settings are restored by rollback.
begin;
do $$
declare
  actor uuid; result jsonb; expected_patients bigint; expected_invoices bigint;
  expected_remaining numeric; expected_paid numeric; expected_expense_remaining numeric;
  expected_expenses bigint; size integer; v_patient_id uuid; detail jsonb;
begin
  select profile.user_id into actor from public.user_profiles profile
    join public.access_roles role on role.id=profile.role_id where profile.active and role.is_admin limit 1;
  if actor is null then raise exception 'An active admin fixture is required'; end if;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  -- Independently calculate each invoice before grouping. Multiple children must not multiply money.
  with invoices as (
    select invoice.patient_id, greatest(
      greatest(coalesce((select sum(item.unit_price*item.quantity) from public.patient_invoice_items item where item.invoice_id=invoice.id),0)
        -coalesce(invoice.loyalty_discount_amount,0)-coalesce(invoice.manual_discount_amount,0),0)
      -coalesce((select sum(payment.amount) from public.invoice_payments payment where payment.invoice_id=invoice.id),invoice.paid_amount,0)
      -coalesce((select sum(release.amount) from public.invoice_releases release where release.invoice_id=invoice.id),0),0) remaining
    from public.patient_invoices invoice join public.patients patient on patient.id=invoice.patient_id
    where invoice.status in ('unpaid','partial')
  ) select count(distinct patient_id), count(*), coalesce(sum(remaining),0)
    into expected_patients, expected_invoices, expected_remaining from invoices where remaining>0;
  foreach size in array array[10,20,50] loop
    result:=public.get_finance_debt_page(p_page_size=>size);
    if jsonb_array_length(result->'groups')>size or (result->>'total_count')::bigint<>expected_patients
      or (result->>'invoice_count')::bigint<>expected_invoices or (result->>'remaining_total')::numeric<>expected_remaining then
      raise exception 'Debt page bounds or full-result totals differ from the ledger';
    end if;
  end loop;
  result:=public.get_finance_debt_page(p_patient_search=>'__no_matching_finance_fixture__');
  if jsonb_array_length(result->'groups')<>0 or (result->>'remaining_total')::numeric<>0 then raise exception 'Empty debt filters failed'; end if;
  result:=public.get_finance_debt_page();
  v_patient_id:=(result->'groups'->0->>'patient_id')::uuid;
  if v_patient_id is not null then
    detail:=public.get_finance_debt_invoices(v_patient_id,p_page_size=>10);
    if jsonb_array_length(detail->'invoices')>10 then raise exception 'Debt invoice page is unbounded'; end if;
    if exists(select 1 from jsonb_array_elements(detail->'invoices') item where item->>'patient_id'<>v_patient_id::text) then
      raise exception 'Debt invoices crossed patient boundaries'; end if;
  end if;
  select count(*),coalesce(sum(least(total,greatest(coalesce(paid_amount,case when paid then total else 0 end),0))),0),
    coalesce(sum(greatest(total-coalesce(paid_amount,case when paid then total else 0 end),0)),0)
    into expected_expenses,expected_paid,expected_expense_remaining from public.expenses;
  result:=public.get_finance_expense_page();
  if jsonb_array_length(result->'expenses')>10 or (result->>'total_count')::bigint<>expected_expenses
    or (result->>'paid_total')::numeric<>expected_paid or (result->>'remaining_total')::numeric<>expected_expense_remaining then
    raise exception 'Expense page totals differ from the ledger';
  end if;
  if (result-'expenses')<>public.get_finance_expense_summary() then raise exception 'Expense aggregate endpoint differs'; end if;
  result:=public.get_finance_expense_page(p_search=>'__no_matching_finance_fixture__');
  if jsonb_array_length(result->'expenses')<>0 or (result->>'total_count')::bigint<>0 then raise exception 'Empty expense filters failed'; end if;
  perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  begin perform public.get_finance_debt_page(); raise exception 'Unauthorized debts exposed'; exception when insufficient_privilege then null; end;
  begin perform public.get_finance_debt_invoices(v_patient_id); raise exception 'Unauthorized invoice debts exposed'; exception when insufficient_privilege then null; end;
  begin perform public.get_finance_expense_page(); raise exception 'Unauthorized expenses exposed'; exception when insufficient_privilege then null; end;
  begin perform public.get_finance_expense_summary(); raise exception 'Unauthorized expense totals exposed'; exception when insufficient_privilege then null; end;
  if has_function_privilege('anon','public.get_finance_debt_page(text,date,date,integer,integer)','execute')
    or has_function_privilege('anon','public.get_finance_expense_page(text,uuid,date,date,integer,integer)','execute') then
    raise exception 'Anonymous finance access exposed';
  end if;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('get_finance_debt_page','get_finance_debt_invoices','get_finance_expense_page','get_finance_expense_summary') and p.prosecdef) then
    raise exception 'Finance readers bypass RLS';
  end if;
end;
$$;
rollback;
