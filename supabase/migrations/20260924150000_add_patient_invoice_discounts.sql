-- Invoice-level patient discount. Procedure unit prices remain the basis for doctor payroll.
alter table public.patient_invoices
  add column manual_discount_type text,
  add column manual_discount_value numeric(12,2) not null default 0,
  add column manual_discount_amount numeric(12,2) not null default 0;

alter table public.patient_invoices
  add constraint patient_invoice_manual_discount_check
  check (
    (manual_discount_type is null and manual_discount_value = 0 and manual_discount_amount = 0)
    or (manual_discount_type = 'amount' and manual_discount_value > 0 and manual_discount_amount >= 0)
    or (manual_discount_type = 'percent' and manual_discount_value > 0 and manual_discount_value <= 100 and manual_discount_amount >= 0)
  );

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
  if auth.uid() is null or not private.is_active_user()
    or not (private.is_admin() or private.has_page_permission('patients')) then
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

create trigger validate_invoice_manual_discount
before update of manual_discount_type, manual_discount_value, manual_discount_amount
on public.patient_invoices for each row
execute function private.validate_invoice_manual_discount();

create or replace function private.sync_invoice_manual_discount()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.recalculate_invoice_payment_state(new.id);
  return null;
end;
$$;

create trigger sync_invoice_manual_discount
after update of manual_discount_type, manual_discount_value, manual_discount_amount
on public.patient_invoices for each row
when (old.manual_discount_type is distinct from new.manual_discount_type
  or old.manual_discount_value is distinct from new.manual_discount_value
  or old.manual_discount_amount is distinct from new.manual_discount_amount)
execute function private.sync_invoice_manual_discount();

create or replace function private.guard_manual_discount_invoice_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    if exists (select 1 from public.patient_invoices invoice
      where invoice.id = old.invoice_id and invoice.manual_discount_amount > 0) then
      raise exception 'Remove the invoice discount before changing invoice procedures.' using errcode = '23503';
    end if;
  end if;
  if tg_op <> 'DELETE' then
    if exists (select 1 from public.patient_invoices invoice
      where invoice.id = new.invoice_id and invoice.manual_discount_amount > 0) then
      raise exception 'Remove the invoice discount before changing invoice procedures.' using errcode = '23503';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger guard_manual_discount_invoice_item
before insert or update or delete on public.patient_invoice_items
for each row execute function private.guard_manual_discount_invoice_item();

create or replace function private.guard_manual_discount_loyalty()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice public.patient_invoices;
  v_subtotal numeric(12,2);
  v_paid numeric(12,2);
  v_released numeric(12,2);
begin
  select * into v_invoice from public.patient_invoices where id = new.invoice_id for update;
  if not found then return new; end if;
  select coalesce(sum(unit_price * quantity), 0) into v_subtotal
    from public.patient_invoice_items where invoice_id = new.invoice_id;
  select coalesce(sum(amount), 0) into v_paid
    from public.invoice_payments where invoice_id = new.invoice_id;
  select coalesce(sum(amount), 0) into v_released
    from public.invoice_releases where invoice_id = new.invoice_id;
  if new.amount > greatest(v_subtotal - v_paid - v_released
    - v_invoice.manual_discount_amount - private.invoice_loyalty_discount(new.invoice_id), 0) then
    raise exception 'Loyalty discount exceeds the remaining patient balance after invoice discount.' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger guard_manual_discount_loyalty
before insert on public.loyalty_redemptions
for each row execute function private.guard_manual_discount_loyalty();

create or replace function public.set_patient_invoice_discount(
  p_invoice_id bigint, p_discount_type text, p_discount_value numeric
)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice public.patient_invoices;
begin
  if auth.uid() is null or not private.is_active_user()
    or not (private.is_admin() or private.has_page_permission('patients')) then
    raise exception 'You are not authorized to change invoice discounts.' using errcode = '42501';
  end if;
  select * into v_invoice from public.patient_invoices where id = p_invoice_id for update;
  if not found then raise exception 'Invoice not found.' using errcode = 'P0002'; end if;
  update public.patient_invoices
    set manual_discount_type = p_discount_type,
        manual_discount_value = p_discount_value
    where id = p_invoice_id
    returning * into v_invoice;
  return v_invoice.manual_discount_amount;
end;
$$;

revoke all on function public.set_patient_invoice_discount(bigint, text, numeric) from public, anon;
grant execute on function public.set_patient_invoice_discount(bigint, text, numeric) to authenticated;

CREATE OR REPLACE FUNCTION private.recalculate_invoice_payment_state(p_invoice_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_total numeric(12,2);
  v_paid numeric(12,2);
  v_released numeric(12,2);
begin
  select coalesce(sum(item.unit_price * item.quantity), 0)
    into v_total
    from public.patient_invoice_items item
    where item.invoice_id = p_invoice_id;

  v_total := greatest(v_total - private.invoice_loyalty_discount(p_invoice_id) - coalesce((select manual_discount_amount from public.patient_invoices where id = p_invoice_id), 0), 0);

  select coalesce(sum(payment.amount), 0)
    into v_paid
    from public.invoice_payments payment
    where payment.invoice_id = p_invoice_id;

  select coalesce(sum(release.amount), 0)
    into v_released
    from public.invoice_releases release
    where release.invoice_id = p_invoice_id;

  update public.patient_invoices
     set paid_amount = v_paid, loyalty_discount_amount = private.invoice_loyalty_discount(p_invoice_id),
         status = case
           when status = 'cancelled' then 'cancelled'
           when v_total > 0 and v_paid + v_released >= v_total then 'paid'
           when v_paid + v_released > 0 then 'partial'
           else 'unpaid'
         end,
         updated_at = now()
   where id = p_invoice_id;
end;
$function$;

CREATE OR REPLACE FUNCTION private.validate_invoice_payment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_patient_id uuid;
  v_total numeric(12,2);
  v_paid numeric(12,2);
  v_released numeric(12,2);
  v_method_name text;
  v_item_invoice_id bigint;
  v_item_total numeric(12,2);
  v_item_paid numeric(12,2);
begin
  if auth.uid() is null
    or not private.is_active_user()
    or not (
      private.is_admin()
      or private.has_page_permission('dashboard')
      or private.has_page_permission('patients')
      or private.has_page_permission('appointments')
    ) then
    raise exception 'You are not authorized to record payments.' using errcode = '42501';
  end if;

  select invoice.patient_id
    into v_patient_id
    from public.patient_invoices invoice
    where invoice.id = new.invoice_id
    for update;

  if v_patient_id is null then
    raise exception 'Invoice not found.' using errcode = 'P0002';
  end if;

  select coalesce(sum(item.unit_price * item.quantity), 0)
    into v_total
    from public.patient_invoice_items item
    where item.invoice_id = new.invoice_id;

  v_total := greatest(v_total - private.invoice_loyalty_discount(new.invoice_id) - coalesce((select manual_discount_amount from public.patient_invoices where id = new.invoice_id), 0), 0);

  select method.name
    into v_method_name
    from public.payment_methods method
    where method.id = new.payment_method_id
      and method.active = true;

  if v_method_name is null then
    raise exception 'Choose an active payment method.' using errcode = '22023';
  end if;

  select coalesce(sum(payment.amount), 0)
    into v_paid
    from public.invoice_payments payment
    where payment.invoice_id = new.invoice_id;

  select coalesce(sum(release.amount), 0)
    into v_released
    from public.invoice_releases release
    where release.invoice_id = new.invoice_id;

  if new.amount <= 0 then
    raise exception 'Payment amount must be greater than zero.' using errcode = '22023';
  end if;

  if new.amount > greatest(v_total - v_paid - v_released, 0) then
    raise exception 'Payment amount cannot exceed the invoice remaining balance.' using errcode = '22023';
  end if;

  if new.invoice_item_id is not null then
    select item.invoice_id, item.unit_price * item.quantity
      into v_item_invoice_id, v_item_total
      from public.patient_invoice_items item
      where item.id = new.invoice_item_id;

    if not found then
      raise exception 'Invoice procedure not found.' using errcode = 'P0002';
    end if;

    if v_item_invoice_id <> new.invoice_id then
      raise exception 'The selected procedure does not belong to this invoice.' using errcode = '22023';
    end if;

    select coalesce(sum(allocation.amount), 0)
      into v_item_paid
      from public.invoice_payment_allocations allocation
      where allocation.invoice_item_id = new.invoice_item_id;

    if new.amount > greatest(v_item_total - v_item_paid, 0) then
      raise exception 'Payment amount cannot exceed the procedure remaining balance.' using errcode = '22023';
    end if;
  end if;

  new.patient_id := v_patient_id;
  new.payment_method_name := btrim(v_method_name);
  new.created_by := auth.uid();
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.release_patient_invoice(p_invoice_id bigint)
 RETURNS TABLE(invoice_id bigint, release_amount numeric, total_released numeric, remaining_amount numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_patient_id uuid;
  v_status text;
  v_total numeric(12,2);
  v_paid numeric(12,2);
  v_released numeric(12,2);
  v_release_amount numeric(12,2);
begin
  if auth.uid() is null
    or not private.is_active_user()
    or not (
      private.is_admin()
      or private.has_page_permission('dashboard')
      or private.has_page_permission('patients')
      or private.has_page_permission('appointments')
      or private.has_page_permission('finances')
    ) then
    raise exception 'You are not authorized to release invoice balances.' using errcode = '42501';
  end if;

  select invoice.patient_id, invoice.status
    into v_patient_id, v_status
    from public.patient_invoices invoice
    where invoice.id = p_invoice_id
    for update;

  if v_patient_id is null then
    raise exception 'Invoice not found.' using errcode = 'P0002';
  end if;

  if v_status = 'cancelled' then
    raise exception 'A cancelled invoice cannot be released.' using errcode = '22023';
  end if;

  select coalesce(sum(item.unit_price * item.quantity), 0)
    into v_total
    from public.patient_invoice_items item
    where item.invoice_id = p_invoice_id;

  v_total := greatest(v_total - private.invoice_loyalty_discount(p_invoice_id) - coalesce((select manual_discount_amount from public.patient_invoices where id = p_invoice_id), 0), 0);

  select coalesce(sum(payment.amount), 0)
    into v_paid
    from public.invoice_payments payment
    where payment.invoice_id = p_invoice_id;

  select coalesce(sum(release.amount), 0)
    into v_released
    from public.invoice_releases release
    where release.invoice_id = p_invoice_id;

  v_release_amount := greatest(v_total - v_paid - v_released, 0);

  if v_release_amount <= 0 then
    raise exception 'This invoice has no remaining balance to release.' using errcode = '22023';
  end if;

  insert into public.invoice_releases (invoice_id, amount, release_date, created_by)
  values (p_invoice_id, v_release_amount, current_date, auth.uid());

  return query
  select
    p_invoice_id,
    v_release_amount::numeric,
    (v_released + v_release_amount)::numeric,
    greatest(v_total - v_paid - v_released - v_release_amount, 0)::numeric;
end;
$function$;

CREATE OR REPLACE FUNCTION public.undo_latest_invoice_release(p_invoice_id bigint)
 RETURNS TABLE(invoice_id bigint, removed_release_id bigint, removed_amount numeric, total_released numeric, remaining_amount numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_patient_id uuid;
  v_total numeric(12,2);
  v_paid numeric(12,2);
  v_released numeric(12,2);
  v_release_id bigint;
  v_release_amount numeric(12,2);
begin
  if auth.uid() is null
    or not private.is_active_user()
    or not (
      private.is_admin()
      or private.has_page_permission('dashboard')
      or private.has_page_permission('patients')
      or private.has_page_permission('appointments')
      or private.has_page_permission('finances')
    ) then
    raise exception 'You are not authorized to undo invoice releases.' using errcode = '42501';
  end if;

  select invoice.patient_id
    into v_patient_id
    from public.patient_invoices invoice
    where invoice.id = p_invoice_id
    for update;

  if v_patient_id is null then
    raise exception 'Invoice not found.' using errcode = 'P0002';
  end if;

  select release.id, release.amount
    into v_release_id, v_release_amount
    from public.invoice_releases release
    where release.invoice_id = p_invoice_id
    order by release.created_at desc, release.id desc
    limit 1
    for update;

  if v_release_id is null then
    raise exception 'This invoice has no released money to undo.' using errcode = 'P0002';
  end if;

  delete from public.invoice_releases release
    where release.id = v_release_id;

  select coalesce(sum(item.unit_price * item.quantity), 0)
    into v_total
    from public.patient_invoice_items item
    where item.invoice_id = p_invoice_id;

  v_total := greatest(v_total - private.invoice_loyalty_discount(p_invoice_id) - coalesce((select manual_discount_amount from public.patient_invoices where id = p_invoice_id), 0), 0);

  select coalesce(sum(payment.amount), 0)
    into v_paid
    from public.invoice_payments payment
    where payment.invoice_id = p_invoice_id;

  select coalesce(sum(release.amount), 0)
    into v_released
    from public.invoice_releases release
    where release.invoice_id = p_invoice_id;

  return query
  select
    p_invoice_id,
    v_release_id,
    v_release_amount::numeric,
    v_released::numeric,
    greatest(v_total - v_paid - v_released, 0)::numeric;
end;
$function$;
