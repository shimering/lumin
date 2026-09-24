-- Keep invoice discounts in sync when procedures are added or changed.
drop trigger guard_manual_discount_invoice_item on public.patient_invoice_items;
drop function private.guard_manual_discount_invoice_item();

create or replace function private.validate_invoice_manual_discount()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subtotal numeric(12,2);
  v_paid numeric(12,2);
  v_released numeric(12,2);
  v_loyalty numeric(12,2);
begin
  if (auth.uid() is null or not private.is_active_user()
    or not (private.is_admin() or private.has_page_permission('patients')))
    and coalesce(current_setting('lumin.manual_discount_sync', true), '') <> 'true' then
    raise exception 'You are not authorized to change invoice discounts.' using errcode = '42501';
  end if;
  if new.status = 'cancelled' then
    raise exception 'A cancelled invoice cannot be discounted.' using errcode = '22023';
  end if;
  if new.manual_discount_value is null or new.manual_discount_value < 0
    or new.manual_discount_value > 100000000 then
    raise exception 'Enter a valid discount value.' using errcode = '22023';
  end if;
  if new.manual_discount_value = 0 then
    new.manual_discount_type := null;
    new.manual_discount_amount := 0;
    return new;
  end if;
  if new.manual_discount_type not in ('amount', 'percent') or new.manual_discount_type is null then
    raise exception 'Choose an amount or percentage discount.' using errcode = '22023';
  end if;
  if new.manual_discount_type = 'percent' and new.manual_discount_value > 100 then
    raise exception 'Percentage discount cannot exceed 100%%.' using errcode = '22023';
  end if;

  select coalesce(sum(item.unit_price * item.quantity), 0)
    into v_subtotal from public.patient_invoice_items item where item.invoice_id = new.id;
  select coalesce(sum(payment.amount), 0)
    into v_paid from public.invoice_payments payment where payment.invoice_id = new.id;
  select coalesce(sum(release.amount), 0)
    into v_released from public.invoice_releases release where release.invoice_id = new.id;
  v_loyalty := private.invoice_loyalty_discount(new.id);
  new.manual_discount_amount := case
    when new.manual_discount_type = 'percent' then round(v_subtotal * new.manual_discount_value / 100, 2)
    else new.manual_discount_value
  end;
  if new.manual_discount_amount > greatest(v_subtotal - v_loyalty - v_paid - v_released, 0) then
    raise exception 'Discount cannot exceed the unpaid invoice balance.' using errcode = '22023';
  end if;
  return new;
end;
$$;

create or replace function private.sync_manual_discount_invoice_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice_id bigint;
begin
  for v_invoice_id in
    select distinct id from unnest(array[
      case when tg_op = 'INSERT' then null::bigint else old.invoice_id end,
      case when tg_op = 'DELETE' then null::bigint else new.invoice_id end
    ]) as invoice_ids(id) where id is not null
  loop
    perform set_config('lumin.manual_discount_sync', 'true', true);
    update public.patient_invoices
       set manual_discount_value = manual_discount_value
     where id = v_invoice_id and manual_discount_type is not null;
    perform set_config('lumin.manual_discount_sync', '', true);
  end loop;
  return null;
end;
$$;

create trigger sync_manual_discount_invoice_item
after insert or update or delete on public.patient_invoice_items
for each row execute function private.sync_manual_discount_invoice_item();

CREATE OR REPLACE FUNCTION public.delete_patient_invoice(p_invoice_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_patient_id uuid;
begin
  if auth.uid() is null
    or not private.is_active_user()
    or not (private.is_admin() or private.has_page_permission('patients')) then
    raise exception 'You are not authorized to delete invoices.'
      using errcode = '42501';
  end if;

  select patient_id into v_patient_id
    from public.patient_invoices
   where id = p_invoice_id;

  if not found then
    raise exception 'Invoice not found.'
      using errcode = 'P0002';
  end if;

  if exists (
    select 1
      from public.invoice_payments payment
     where payment.invoice_id = p_invoice_id
  ) or exists (
    select 1
      from public.invoice_payment_allocations allocation
      join public.patient_invoice_items item on item.id = allocation.invoice_item_id
     where item.invoice_id = p_invoice_id
  ) then
    raise exception 'Remove all payments before deleting this invoice.'
      using errcode = '23503';
  end if;

  if exists (
    select 1
      from public.invoice_releases release
     where release.invoice_id = p_invoice_id
  ) then
    raise exception 'A released invoice cannot be deleted.'
      using errcode = '23503';
  end if;

  update public.patient_invoices
     set manual_discount_type = null, manual_discount_value = 0
   where id = p_invoice_id and manual_discount_amount > 0;

  delete from public.patient_invoice_items
   where invoice_id = p_invoice_id;

  delete from public.patient_invoices
   where id = p_invoice_id;

  return true;
end;
$function$;
