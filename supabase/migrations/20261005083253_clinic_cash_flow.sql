-- A single monthly response; no patient or transaction details leave the database.
create index if not exists invoice_payments_cash_flow_date_idx on public.invoice_payments(payment_date);
create index if not exists expense_payments_cash_flow_date_idx on public.expense_payment_entries(payment_date);

-- Analytics-only users cannot read the underlying finance tables. Keep the
-- privileged aggregate private, using the same authorization as the income statement.
create or replace function private.build_clinic_cash_flow(p_start_date date, p_end_date date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if auth.uid() is null or not private.has_analytics_access() then
    raise exception 'Analytics access is required.' using errcode = '42501';
  end if;
  if p_start_date is null or p_end_date is null or p_end_date < p_start_date
    or p_start_date <> date_trunc('month', p_start_date)::date
    or p_end_date <> (date_trunc('month', p_end_date) + interval '1 month - 1 day')::date
    or p_end_date >= p_start_date + interval '36 months' then
    raise exception 'Choose a valid range of up to 36 complete months.' using errcode = '22023';
  end if;

  with months as (
    select month::date as month from generate_series(p_start_date::timestamp,
      date_trunc('month', p_end_date::timestamp), interval '1 month') month
  ), income as (
    select date_trunc('month', payment_date)::date as month, sum(amount) as amount
    from public.invoice_payments where payment_date between p_start_date and p_end_date
    group by 1
  ), expense_parts as (
    select payment_date as paid_date, amount, false as legacy
    from public.expense_payment_entries
    where payment_date between p_start_date and p_end_date and amount > 0
    union all
    -- Pre-integration payments have no payment-date history. Count only the
    -- untracked remainder, on its recorded expense date, to avoid double counting.
    select e.expense_date, greatest(e.paid_amount - coalesce((
      select sum(p.amount) from public.expense_payment_entries p where p.expense_id = e.id
    ), 0), 0), true
    from public.expenses e
    where e.expense_date between p_start_date and p_end_date and e.paid_amount > 0
  ), expense as (
    select date_trunc('month', paid_date)::date as month, sum(amount) as amount,
      coalesce(sum(amount) filter (where legacy), 0) as legacy_amount
    from expense_parts group by 1
  ), series as (
    select to_char(m.month, 'YYYY-MM') as month,
      coalesce(i.amount, 0) as income, coalesce(e.amount, 0) as expense,
      coalesce(i.amount, 0) - coalesce(e.amount, 0) as net,
      coalesce(e.legacy_amount, 0) as legacy_expense
    from months m left join income i on i.month = m.month left join expense e on e.month = m.month
  )
  select jsonb_build_object('start_date', p_start_date, 'end_date', p_end_date,
    'income_total', sum(income), 'expense_total', sum(expense), 'net_total', sum(net),
    'legacy_expense_total', sum(legacy_expense),
    'months', jsonb_agg(to_jsonb(series) order by month)) into result from series;
  return result;
end;
$$;

create or replace function public.get_clinic_cash_flow(p_start_date date, p_end_date date)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select private.build_clinic_cash_flow(p_start_date, p_end_date);
$$;
revoke all on function private.build_clinic_cash_flow(date,date) from public, anon, authenticated;
revoke all on function public.get_clinic_cash_flow(date,date) from public, anon, authenticated;
grant execute on function private.build_clinic_cash_flow(date,date) to authenticated;
grant execute on function public.get_clinic_cash_flow(date,date) to authenticated;
