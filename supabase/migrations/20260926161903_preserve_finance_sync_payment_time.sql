-- A date-only midnight made new receipts disappear below the dashboard's recent entries.
-- Keep the selected Cairo payment date and the original entry's Cairo time of day.
create function private.queue_finance_sync_at(p_key text,p_kind text,p_method uuid,p_amount numeric,p_date date,p_note text,p_category text,p_delete boolean,p_recorded_at timestamptz)
returns void language plpgsql security definer set search_path='' as $$
declare
  settings public.finance_sync_settings;
  account_id text;
  event_status text:='pending';
  event_reason text;
  event_operation text:='upsert';
  has_previous boolean;
begin
  select * into settings from public.finance_sync_settings where id;
  select exists(select 1 from public.finance_sync_events where source_key=p_key and operation='upsert' and status not in ('skipped','needs_method')) into has_previous;
  account_id:=settings.payment_routes->>p_method::text;
  if p_delete or coalesce(p_amount,0)=0 then
    event_operation:='delete';
    update public.finance_sync_events set status='skipped',reason='Payment was removed or corrected to zero.' where source_key=p_key and status='needs_method';
  elsif not has_previous and ((p_kind='income' and not settings.sync_income) or (p_kind='expense' and not settings.sync_expenses)) then
    event_status:='skipped'; event_reason:='This transaction type is excluded.';
  elsif p_method is null then event_status:='needs_method'; event_reason:='Choose an expense payment method.';
  elsif account_id is null then event_status:='skipped'; event_reason:='Payment method is excluded or unmapped.';
  end if;
  if event_status='skipped' and has_previous then event_operation:='delete'; event_status:='pending'; end if;
  if event_operation='delete' and not has_previous then return; end if;
  insert into public.finance_sync_events(source_key,operation,payload,payment_method_id,status,reason)
  values(p_key,event_operation,jsonb_build_object('kind',p_kind,'account_id',account_id,'amount_minor',round(coalesce(p_amount,0)*100)::bigint,
    'occurred_at',((p_date + (coalesce(p_recorded_at,now()) at time zone 'Africa/Cairo')::time) at time zone 'Africa/Cairo'),
    'note',left(p_note,250),'category_key',p_category),p_method,event_status,event_reason);
end; $$;
revoke all on function private.queue_finance_sync_at(text,text,uuid,numeric,date,text,text,boolean,timestamptz) from public,anon,authenticated,service_role;

-- Retain the existing internal signature for any callers without an entry timestamp.
create or replace function private.queue_finance_sync(p_key text,p_kind text,p_method uuid,p_amount numeric,p_date date,p_note text,p_category text,p_delete boolean default false)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform private.queue_finance_sync_at(p_key,p_kind,p_method,p_amount,p_date,p_note,p_category,p_delete,now());
end; $$;

create or replace function private.capture_lumin_income()
returns trigger language plpgsql security definer set search_path='' as $$
declare r public.invoice_payments; s public.finance_sync_settings;
begin
  if tg_op='DELETE' then r:=old; else r:=new; end if;
  select * into s from public.finance_sync_settings where id;
  if tg_op<>'INSERT' and not exists(select 1 from public.finance_sync_events where source_key='income:'||r.id) then return null; end if;
  perform private.queue_finance_sync_at('income:'||r.id,'income',r.payment_method_id,r.amount,r.payment_date,
    'Lumin · Payment #'||r.id||' · Invoice #'||r.invoice_id,s.income_category,tg_op='DELETE',r.created_at);
  return null;
end; $$;

create or replace function private.capture_expense_payment_entry()
returns trigger language plpgsql security definer set search_path='' as $$
declare r public.expense_payment_entries; e public.expenses; s public.finance_sync_settings; category text;
begin
  if tg_op='DELETE' then r:=old; else r:=new; end if;
  select * into e from public.expenses where id=r.expense_id;
  select * into s from public.finance_sync_settings where id;
  category:=coalesce(s.expense_categories->>e.expense_type_id::text,s.expense_categories->>'default');
  perform private.queue_finance_sync_at('expense:'||r.id,'expense',r.payment_method_id,r.amount,r.payment_date,
    'Lumin · '||coalesce(e.name,'Expense payment'),category,tg_op='DELETE',r.created_at);
  return null;
end; $$;
