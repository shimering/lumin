-- Small, read-only finance responses. Invoker rights retain the table RLS rules.
create or replace function private.finance_debt_balances(
  p_patient_search text default null, p_start_date date default null,
  p_end_date date default null, p_patient_id uuid default null
)
returns table (
  id bigint, patient_id uuid, patient_name text, patient_phone text,
  patient_number bigint, invoice_date date, created_at timestamptz,
  total_amount numeric, paid_amount numeric, released_amount numeric, remaining_amount numeric
)
language plpgsql stable security invoker set search_path = '' as $$
begin
  if auth.uid() is null or not private.has_finances_access()
    or not (private.is_admin() or private.has_page_permission('finance_depts')) then
    raise exception 'You are not authorized to view patient debts.' using errcode = '42501';
  end if;
  if p_start_date > p_end_date then
    raise exception 'The start date cannot be after the end date.' using errcode = '22023';
  end if;
  return query
  select invoice.id, invoice.patient_id, patient.name::text, patient.phone::text,
    patient.patient_number::bigint, invoice.invoice_date, invoice.created_at,
    amounts.total, amounts.paid, amounts.released,
    greatest(amounts.total - amounts.paid - amounts.released, 0)
  from public.patient_invoices invoice
  join public.patients patient on patient.id = invoice.patient_id
  cross join lateral (
    select greatest(coalesce((select sum(item.unit_price * item.quantity)
      from public.patient_invoice_items item where item.invoice_id = invoice.id), 0)
      - coalesce(invoice.loyalty_discount_amount, 0) - coalesce(invoice.manual_discount_amount, 0), 0) as total,
      coalesce((select sum(payment.amount) from public.invoice_payments payment
        where payment.invoice_id = invoice.id), invoice.paid_amount, 0) as paid,
      coalesce((select sum(release.amount) from public.invoice_releases release
        where release.invoice_id = invoice.id), 0) as released
  ) amounts
  where invoice.status in ('unpaid', 'partial')
    and (p_patient_id is null or invoice.patient_id = p_patient_id)
    and (nullif(btrim(p_patient_search), '') is null or patient.name ilike '%' || btrim(p_patient_search) || '%')
    and (p_start_date is null or invoice.invoice_date >= p_start_date)
    and (p_end_date is null or invoice.invoice_date <= p_end_date)
    and amounts.total - amounts.paid - amounts.released > 0;
end;
$$;

create or replace function public.get_finance_debt_page(
  p_patient_search text default null, p_start_date date default null,
  p_end_date date default null, p_page integer default 1, p_page_size integer default 10
)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with balances as materialized (
    select * from private.finance_debt_balances(p_patient_search, p_start_date, p_end_date)
  ), groups as (
    select patient_id, patient_name, patient_phone, patient_number,
      sum(remaining_amount) as remaining, count(*) as invoice_count
    from balances group by patient_id, patient_name, patient_phone, patient_number
  ), page as (
    select * from groups order by remaining desc, patient_name, patient_id
    limit (case when p_page_size in (10,20,50) then p_page_size else 10 end)
    offset ((greatest(coalesce(p_page,1),1)-1) * (case when p_page_size in (10,20,50) then p_page_size else 10 end))
  )
  select jsonb_build_object(
    'groups', coalesce((select jsonb_agg(to_jsonb(page) order by remaining desc, patient_name, patient_id) from page), '[]'::jsonb),
    'total_count', (select count(*) from groups),
    'invoice_count', (select count(*) from balances),
    'remaining_total', coalesce((select sum(remaining_amount) from balances),0)
  );
$$;

create or replace function public.get_finance_debt_invoices(
  p_patient_id uuid, p_start_date date default null, p_end_date date default null,
  p_page integer default 1, p_page_size integer default 10
)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with balances as materialized (
    select * from private.finance_debt_balances(null, p_start_date, p_end_date, p_patient_id)
    where patient_id = p_patient_id
  ), page as (
    select * from balances order by invoice_date desc, created_at desc, id desc
    limit (case when p_page_size in (10,20,50) then p_page_size else 10 end)
    offset ((greatest(coalesce(p_page,1),1)-1) * (case when p_page_size in (10,20,50) then p_page_size else 10 end))
  )
  select jsonb_build_object(
    'invoices', coalesce((select jsonb_agg(to_jsonb(page) order by invoice_date desc, created_at desc, id desc) from page), '[]'::jsonb),
    'total_count', (select count(*) from balances)
  );
$$;

create or replace function public.get_finance_expense_summary(
  p_search text default null, p_expense_type_id uuid default null,
  p_start_date date default null, p_end_date date default null
)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare result jsonb;
begin
  if auth.uid() is null or not private.has_finances_access() then
    raise exception 'You are not authorized to view expenses.' using errcode = '42501';
  end if;
  if p_start_date > p_end_date then
    raise exception 'The start date cannot be after the end date.' using errcode = '22023';
  end if;
  select jsonb_build_object('total_count', count(*),
    'paid_total', coalesce(sum(least(expense.total, greatest(coalesce(expense.paid_amount,
      case when expense.paid then expense.total else 0 end),0))),0),
    'remaining_total', coalesce(sum(greatest(expense.total - coalesce(expense.paid_amount,
      case when expense.paid then expense.total else 0 end),0)),0)) into result
  from public.expenses expense
  where (p_expense_type_id is null or expense.expense_type_id = p_expense_type_id)
    and (nullif(btrim(p_search),'') is null
      or strpos(lower(coalesce(expense.name,'') || ' ' || coalesce(expense.description,'')), lower(btrim(p_search))) > 0)
    and (p_start_date is null or expense.expense_date >= p_start_date)
    and (p_end_date is null or expense.expense_date <= p_end_date);
  return result;
end;
$$;

create or replace function public.get_finance_expense_page(
  p_search text default null, p_expense_type_id uuid default null,
  p_start_date date default null, p_end_date date default null,
  p_page integer default 1, p_page_size integer default 10
)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare result jsonb;
begin
  if auth.uid() is null or not private.has_finances_access() then
    raise exception 'You are not authorized to view expenses.' using errcode = '42501';
  end if;
  if p_start_date > p_end_date then
    raise exception 'The start date cannot be after the end date.' using errcode = '22023';
  end if;
  with filtered as materialized (
    select expense.id, expense.expense_type_id, expense.name, expense.total, expense.paid_amount,
      expense.quantity, expense.expense_date, expense.description, expense.paid, expense.created_at, expense.updated_at
    from public.expenses expense
    where (p_expense_type_id is null or expense.expense_type_id = p_expense_type_id)
      and (nullif(btrim(p_search),'') is null
        or strpos(lower(coalesce(expense.name,'') || ' ' || coalesce(expense.description,'')), lower(btrim(p_search))) > 0)
      and (p_start_date is null or expense.expense_date >= p_start_date)
      and (p_end_date is null or expense.expense_date <= p_end_date)
  ), page as (
    select filtered.*, (select jsonb_build_object('id', type.id, 'name', type.name, 'color', type.color,
      'active', type.active, 'sort_order', type.sort_order) from public.expense_types type
      where type.id = filtered.expense_type_id) as expense_types
    from filtered order by expense_date desc, created_at desc, id desc
    limit (case when p_page_size in (10,20,50) then p_page_size else 10 end)
    offset ((greatest(coalesce(p_page,1),1)-1) * (case when p_page_size in (10,20,50) then p_page_size else 10 end))
  )
  select jsonb_build_object(
    'expenses', coalesce((select jsonb_agg(to_jsonb(page) order by expense_date desc, created_at desc, id desc) from page), '[]'::jsonb),
    'total_count', (select count(*) from filtered),
    'paid_total', coalesce((select sum(least(total, greatest(coalesce(paid_amount, case when paid then total else 0 end),0))) from filtered),0),
    'remaining_total', coalesce((select sum(greatest(total-coalesce(paid_amount, case when paid then total else 0 end),0)) from filtered),0)
  ) into result;
  return result;
end;
$$;
revoke all on function public.get_finance_expense_page(text,uuid,date,date,integer,integer) from public, anon;
grant execute on function public.get_finance_expense_page(text,uuid,date,date,integer,integer) to authenticated;

revoke all on function private.finance_debt_balances(text,date,date,uuid) from public, anon;
revoke all on function public.get_finance_debt_page(text,date,date,integer,integer) from public, anon;
revoke all on function public.get_finance_debt_invoices(uuid,date,date,integer,integer) from public, anon;
revoke all on function public.get_finance_expense_summary(text,uuid,date,date) from public, anon;
grant execute on function private.finance_debt_balances(text,date,date,uuid) to authenticated;
grant execute on function public.get_finance_debt_page(text,date,date,integer,integer) to authenticated;
grant execute on function public.get_finance_debt_invoices(uuid,date,date,integer,integer) to authenticated;
grant execute on function public.get_finance_expense_summary(text,uuid,date,date) to authenticated;
