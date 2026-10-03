-- Aggregate each child table once over the matching invoice set, keeping invoker RLS.
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
  with matching as materialized (
    select invoice.id, invoice.patient_id, patient.name::text as patient_name, patient.phone::text as patient_phone,
      patient.patient_number::bigint, invoice.invoice_date, invoice.created_at,
      invoice.paid_amount, invoice.loyalty_discount_amount, invoice.manual_discount_amount
    from public.patient_invoices invoice join public.patients patient on patient.id=invoice.patient_id
    where invoice.status in ('unpaid','partial')
      and (p_patient_id is null or invoice.patient_id=p_patient_id)
      and (nullif(btrim(p_patient_search),'') is null or patient.name ilike '%'||btrim(p_patient_search)||'%')
      and (p_start_date is null or invoice.invoice_date>=p_start_date)
      and (p_end_date is null or invoice.invoice_date<=p_end_date)
  ), items as (
    select item.invoice_id, sum(item.unit_price*item.quantity) as total
    from public.patient_invoice_items item join matching on matching.id=item.invoice_id group by item.invoice_id
  ), payments as (
    select payment.invoice_id, sum(payment.amount) as paid
    from public.invoice_payments payment join matching on matching.id=payment.invoice_id group by payment.invoice_id
  ), releases as (
    select release.invoice_id, sum(release.amount) as released
    from public.invoice_releases release join matching on matching.id=release.invoice_id group by release.invoice_id
  ), amounts as (
    select matching.id, matching.patient_id, matching.patient_name, matching.patient_phone,
      matching.patient_number, matching.invoice_date, matching.created_at,
      greatest(coalesce(items.total,0)-coalesce(matching.loyalty_discount_amount,0)-coalesce(matching.manual_discount_amount,0),0) as total,
      coalesce(payments.paid,matching.paid_amount,0) as paid,coalesce(releases.released,0) as released
    from matching left join items on items.invoice_id=matching.id
      left join payments on payments.invoice_id=matching.id left join releases on releases.invoice_id=matching.id
  )
  select amounts.id,amounts.patient_id,amounts.patient_name,amounts.patient_phone,amounts.patient_number,
    amounts.invoice_date,amounts.created_at,amounts.total,amounts.paid,amounts.released,
    greatest(amounts.total-amounts.paid-amounts.released,0)
  from amounts where amounts.total-amounts.paid-amounts.released>0;
end;
$$;
