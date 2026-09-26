create or replace function private.queue_finance_sync(p_key text,p_kind text,p_method uuid,p_amount numeric,p_date date,p_note text,p_category text,p_delete boolean default false)
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
  -- A correction must remove any previously delivered entry when its method becomes excluded.
  if event_status='skipped' and has_previous then event_operation:='delete'; event_status:='pending'; end if;
  if event_operation='delete' and not has_previous then return; end if;
  insert into public.finance_sync_events(source_key,operation,payload,payment_method_id,status,reason)
  values(p_key,event_operation,jsonb_build_object('kind',p_kind,'account_id',account_id,'amount_minor',round(coalesce(p_amount,0)*100)::bigint,
    'occurred_at',(p_date::timestamp at time zone 'Africa/Cairo'),'note',left(p_note,250),'category_key',p_category),p_method,event_status,event_reason);
end; $$;
