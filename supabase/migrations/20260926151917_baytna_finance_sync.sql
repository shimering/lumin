-- Durable, one-way, cash-basis synchronization. Existing transactions are excluded.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

create table private.baytna_sync_connection (
  id boolean primary key default true check(id),
  token_secret_id uuid not null,
  receiver_url text not null check(receiver_url='https://wljaulrqgzputgayxyoi.supabase.co/functions/v1/lumin-finance-sync')
);
alter table private.baytna_sync_connection enable row level security;
revoke all on private.baytna_sync_connection from public, anon, authenticated, service_role;

create table public.finance_sync_settings (
  id boolean primary key default true check(id),
  enabled boolean not null default false,
  sync_income boolean not null default true,
  sync_expenses boolean not null default true,
  started_at timestamptz not null default now(),
  accounts jsonb not null default '[]',
  categories jsonb not null default '[]',
  payment_routes jsonb not null default '{}',
  income_category text,
  expense_categories jsonb not null default '{}',
  catalogue_refreshed_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into public.finance_sync_settings(id) values(true);

create table public.finance_sync_events (
  id bigint generated always as identity primary key,
  source_key text not null,
  operation text not null check(operation in ('upsert','delete','catalog')),
  payload jsonb not null default '{}',
  payment_method_id uuid,
  status text not null check(status in ('pending','sending','synced','failed','skipped','needs_method')),
  reason text,
  attempts integer not null default 0,
  request_id bigint,
  sent_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  synced_at timestamptz
);
create index finance_sync_events_source_idx on public.finance_sync_events(source_key,id desc);
create index finance_sync_events_pending_idx on public.finance_sync_events(next_attempt_at,id) where status in ('pending','sending','failed');
create index finance_sync_events_created_idx on public.finance_sync_events(created_at desc);

-- Each future expense installment has its own method; pre-existing paid amounts are never reconstructed.
alter table public.expenses add column sync_payment_method_id uuid references public.payment_methods(id) on delete restrict;
create table public.expense_payment_entries (
  id uuid primary key default gen_random_uuid(),
  sequence_number bigint generated always as identity unique,
  expense_id uuid not null references public.expenses(id) on delete cascade,
  payment_method_id uuid references public.payment_methods(id) on delete restrict,
  amount numeric(12,2) not null check(amount>=0),
  payment_date date not null default current_date,
  created_at timestamptz not null default now()
);
create index expense_payment_entries_expense_idx on public.expense_payment_entries(expense_id,created_at desc);
create index expense_payment_entries_method_idx on public.expense_payment_entries(payment_method_id);

alter table public.finance_sync_settings enable row level security;
alter table public.finance_sync_events enable row level security;
alter table public.expense_payment_entries enable row level security;
create policy finance_sync_settings_admin on public.finance_sync_settings for select to authenticated using((select private.is_admin()));
create policy finance_sync_events_admin on public.finance_sync_events for select to authenticated using((select private.is_admin()));
create policy expense_payment_entries_read on public.expense_payment_entries for select to authenticated using((select private.has_page_permission('finances')));
revoke all on public.finance_sync_settings,public.finance_sync_events,public.expense_payment_entries from anon,authenticated;
grant select on public.finance_sync_settings,public.finance_sync_events,public.expense_payment_entries to authenticated;
grant all on public.finance_sync_settings,public.finance_sync_events,public.expense_payment_entries to service_role;
grant usage,select on sequence public.finance_sync_events_id_seq to service_role;

create function private.queue_finance_sync(p_key text,p_kind text,p_method uuid,p_amount numeric,p_date date,p_note text,p_category text,p_delete boolean default false)
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

create function private.capture_lumin_income()
returns trigger language plpgsql security definer set search_path='' as $$
declare r public.invoice_payments; s public.finance_sync_settings;
begin
  if tg_op='DELETE' then r:=old; else r:=new; end if;
  select * into s from public.finance_sync_settings where id;
  -- Edits/deletions of old payments are ignored unless this integration has seen their creation.
  if tg_op<>'INSERT' and not exists(select 1 from public.finance_sync_events where source_key='income:'||r.id) then return null; end if;
  perform private.queue_finance_sync('income:'||r.id,'income',r.payment_method_id,r.amount,r.payment_date,
    'Lumin · Payment #'||r.id||' · Invoice #'||r.invoice_id,s.income_category,tg_op='DELETE');
  return null;
end; $$;
create trigger capture_lumin_income after insert or update or delete on public.invoice_payments for each row execute function private.capture_lumin_income();

create function private.capture_expense_payment_entry()
returns trigger language plpgsql security definer set search_path='' as $$
declare r public.expense_payment_entries; e public.expenses; s public.finance_sync_settings; category text;
begin
  if tg_op='DELETE' then r:=old; else r:=new; end if;
  select * into e from public.expenses where id=r.expense_id;
  select * into s from public.finance_sync_settings where id;
  category:=coalesce(s.expense_categories->>e.expense_type_id::text,s.expense_categories->>'default');
  perform private.queue_finance_sync('expense:'||r.id,'expense',r.payment_method_id,r.amount,r.payment_date,
    'Lumin · '||coalesce(e.name,'Expense payment'),category,tg_op='DELETE');
  return null;
end; $$;
create trigger capture_expense_payment_entry after insert or update or delete on public.expense_payment_entries for each row execute function private.capture_expense_payment_entry();

create function private.capture_lumin_expense()
returns trigger language plpgsql security definer set search_path='' as $$
declare delta numeric; reduction numeric; item public.expense_payment_entries; entry_date date;
begin
  delta:=new.paid_amount-case when tg_op='INSERT' then 0 else old.paid_amount end;
  if delta>0 then
    entry_date:=coalesce(nullif(current_setting('lumin.expense_payment_date',true),'')::date,
      case when tg_op='INSERT' then new.expense_date else (now() at time zone 'Africa/Cairo')::date end);
    insert into public.expense_payment_entries(expense_id,payment_method_id,amount,payment_date)
    values(new.id,new.sync_payment_method_id,delta,entry_date);
  elsif delta<0 then
    reduction:=-delta;
    for item in select * from public.expense_payment_entries where expense_id=new.id and amount>0 order by sequence_number desc for update loop
      update public.expense_payment_entries set amount=greatest(0,item.amount-reduction) where id=item.id;
      reduction:=reduction-least(reduction,item.amount);
      exit when reduction<=0;
    end loop;
    -- Any remainder belongs to a pre-integration payment and is deliberately not imported.
  elsif tg_op='UPDATE' and (new.name is distinct from old.name or new.expense_type_id is distinct from old.expense_type_id) then
    update public.expense_payment_entries set amount=amount where expense_id=new.id and amount>0;
  end if;
  return null;
end; $$;
create trigger capture_lumin_expense after insert or update on public.expenses for each row execute function private.capture_lumin_expense();

create function public.record_expense_payment(p_expense_id uuid,p_amount numeric,p_payment_method_id uuid,p_payment_date date default current_date)
returns numeric language plpgsql set search_path='' as $$
declare result numeric; previous_date text;
begin
  if not exists(select 1 from public.payment_methods where id=p_payment_method_id and active) then raise exception 'Choose an active payment method.'; end if;
  if p_amount is null or round(p_amount,2)<=0 or p_payment_date is null then raise exception 'Enter a positive payment amount and date.'; end if;
  previous_date:=current_setting('lumin.expense_payment_date',true);
  perform set_config('lumin.expense_payment_date',p_payment_date::text,true);
  update public.expenses set paid_amount=paid_amount+round(p_amount,2),sync_payment_method_id=p_payment_method_id
  where id=p_expense_id and paid_amount+round(p_amount,2)<=total returning paid_amount into result;
  if not found then raise exception 'Expense was not found or payment exceeds the remaining amount.'; end if;
  perform set_config('lumin.expense_payment_date',coalesce(previous_date,''),true);
  return result;
end; $$;
revoke all on function public.record_expense_payment(uuid,numeric,uuid,date) from public,anon;
grant execute on function public.record_expense_payment(uuid,numeric,uuid,date) to authenticated;

create function private.dispatch_baytna_sync()
returns void language plpgsql security definer set search_path='' as $$
declare event public.finance_sync_events; response net._http_response; connection private.baytna_sync_connection;
  token text; request bigint; decoded jsonb; enabled boolean; signed_body jsonb;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('lumin-baytna-dispatch',0)) then return; end if;
  for event in select * from public.finance_sync_events where status='sending' order by id limit 100 for update skip locked loop
    select * into response from net._http_response where id=event.request_id;
    if response.id is not null then
      decoded:=null;
      begin decoded:=response.content::jsonb; exception when others then null; end;
      if response.status_code=200 and decoded->>'ok'='true' and decoded->>'version'=event.id::text then
        update public.finance_sync_events set status='synced',synced_at=now(),reason=null where id=event.id;
        if event.operation='catalog' then
          update public.finance_sync_settings set accounts=decoded->'catalog'->'accounts',categories=decoded->'catalog'->'categories',catalogue_refreshed_at=now() where id;
        end if;
      else
        update public.finance_sync_events set status='failed',reason=case when response.status_code=401 then 'Connection authentication failed.'
          when response.status_code=422 then 'Destination account, category, or event needs review.' else 'Destination unavailable; delivery will retry.' end,
          next_attempt_at=now()+make_interval(secs=>least(3600,30*power(2,least(attempts,7)))::integer) where id=event.id;
      end if;
    elsif event.sent_at<now()-interval '90 seconds' then
      update public.finance_sync_events set status='failed',reason='Delivery timed out; it is safe to retry.',next_attempt_at=now() where id=event.id;
    end if;
  end loop;
  select * into connection from private.baytna_sync_connection where id;
  if connection is null then return; end if;
  select encode(extensions.digest(decrypted_secret,'sha256'),'hex') into token from vault.decrypted_secrets where id=connection.token_secret_id;
  select s.enabled into enabled from public.finance_sync_settings s where id;
  for event in select * from public.finance_sync_events where status in ('pending','failed') and next_attempt_at<=now() and attempts<12
    and (enabled or operation='catalog') order by id limit 25 for update skip locked loop
    signed_body:=jsonb_build_object('source_project','pqbayjkypzfxvnksgwwf','version',event.id,'source_key',event.source_key,'operation',event.operation,'payload',event.payload);
    request:=net.http_post(url:=connection.receiver_url,headers:=jsonb_build_object('Content-Type','application/json','x-lumin-sync-signature',
      encode(extensions.hmac(signed_body::text,token,'sha256'),'hex')),body:=signed_body,timeout_milliseconds:=10000);
    update public.finance_sync_events set status='sending',request_id=request,sent_at=now(),attempts=attempts+1 where id=event.id;
  end loop;
end; $$;
select cron.schedule('lumin-baytna-sync','* * * * *','select private.dispatch_baytna_sync();');

create function public.configure_baytna_sync(p_token text,p_accounts jsonb,p_categories jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare secret_id uuid; cash_id text; bank_id text; v_income_category text; default_expense text;
begin
  if length(p_token)<32 then raise exception 'A dedicated integration token is required.'; end if;
  select vault.create_secret(p_token,'lumin_baytna_sync_token') into secret_id;
  insert into private.baytna_sync_connection(id,token_secret_id,receiver_url)
  values(true,secret_id,'https://wljaulrqgzputgayxyoi.supabase.co/functions/v1/lumin-finance-sync');
  select value->>'id' into cash_id from jsonb_array_elements(p_accounts) where value->>'name'='Cash wallet';
  select value->>'id' into bank_id from jsonb_array_elements(p_accounts) where value->>'name'='Main bank';
  select value->>'key' into v_income_category from jsonb_array_elements(p_categories) where value->>'kind'='income' and value->>'name'='Clinic salary';
  select value->>'key' into default_expense from jsonb_array_elements(p_categories) where value->>'kind'='expense' and value->>'name'='Clinic';
  update public.finance_sync_settings set accounts=p_accounts,categories=p_categories,income_category=v_income_category,
    expense_categories=jsonb_build_object('default',default_expense)||coalesce((select jsonb_object_agg(t.id::text,c.value->>'key') from public.expense_types t
      join jsonb_array_elements(p_categories) c on lower(c.value->>'name')=lower(t.name) and c.value->>'kind'='expense'),'{}'),
    payment_routes=coalesce((select jsonb_object_agg(id::text,case when lower(name)='cash' then cash_id when lower(replace(name,' ',''))='instapay' then bank_id else null end) from public.payment_methods),'{}') where id;
  insert into public.finance_sync_events(source_key,operation,status) values('catalog','catalog','pending');
  perform private.dispatch_baytna_sync();
end; $$;
revoke all on function public.configure_baytna_sync(text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.configure_baytna_sync(text,jsonb,jsonb) to service_role;

create function public.get_finance_sync_admin()
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not private.is_admin() then raise exception 'Administrator access required.' using errcode='42501'; end if;
  perform private.dispatch_baytna_sync();
  return jsonb_build_object('settings',(select to_jsonb(s) from public.finance_sync_settings s where id),
    'connected',exists(select 1 from private.baytna_sync_connection),
    'methods',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'active',active) order by sort_order) from public.payment_methods),'[]'),
    'expense_types',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by sort_order) from public.expense_types where active),'[]'),
    'counts',coalesce((select jsonb_object_agg(status,count) from (select status,count(*) from public.finance_sync_events where operation<>'catalog' group by status) counts),'{}'),
    'events',coalesce((select jsonb_agg(to_jsonb(e) order by e.id desc) from (select id,source_key,operation,payment_method_id,status,reason,attempts,created_at,synced_at,payload
      from public.finance_sync_events where operation<>'catalog' order by id desc limit 50) e),'[]'),
    'last_synced_at',(select max(synced_at) from public.finance_sync_events where operation<>'catalog'),
    'catalogue_error',(select reason from public.finance_sync_events where operation='catalog' order by id desc limit 1));
end; $$;

create function public.save_finance_sync_settings(p_enabled boolean,p_sync_income boolean,p_sync_expenses boolean,p_routes jsonb,p_income_category text,p_expense_categories jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare s public.finance_sync_settings; route record; category record;
begin
  if not private.is_admin() then raise exception 'Administrator access required.' using errcode='42501'; end if;
  select * into s from public.finance_sync_settings where id for update;
  if p_enabled and not exists(select 1 from private.baytna_sync_connection) then raise exception 'The connection is not configured.'; end if;
  for route in select * from jsonb_each_text(p_routes) loop
    if not exists(select 1 from public.payment_methods where id::text=route.key) or
      (route.value is not null and not exists(select 1 from jsonb_array_elements(s.accounts) a where a->>'id'=route.value)) then raise exception 'Choose an available destination account.'; end if;
  end loop;
  if p_income_category is not null and not exists(select 1 from jsonb_array_elements(s.categories) c where c->>'key'=p_income_category and c->>'kind'='income') then raise exception 'Choose an income category.'; end if;
  for category in select * from jsonb_each_text(p_expense_categories) loop
    if (category.key<>'default' and not exists(select 1 from public.expense_types where id::text=category.key)) or
      (category.value is not null and not exists(select 1 from jsonb_array_elements(s.categories) c where c->>'key'=category.value and c->>'kind'='expense')) then raise exception 'Choose an expense category.'; end if;
  end loop;
  update public.finance_sync_settings set enabled=p_enabled,sync_income=p_sync_income,sync_expenses=p_sync_expenses,payment_routes=p_routes,
    income_category=p_income_category,expense_categories=p_expense_categories,updated_at=now() where id;
  perform private.dispatch_baytna_sync();
end; $$;

create function public.retry_finance_sync(p_refresh_catalogue boolean default false)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not private.is_admin() then raise exception 'Administrator access required.' using errcode='42501'; end if;
  if p_refresh_catalogue then insert into public.finance_sync_events(source_key,operation,status) values('catalog','catalog','pending');
  else update public.finance_sync_events set status='pending',attempts=0,next_attempt_at=now(),reason=null where status='failed'; end if;
  perform private.dispatch_baytna_sync();
end; $$;

create function public.assign_expense_sync_method(p_entry_id uuid,p_payment_method_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not private.is_admin() then raise exception 'Administrator access required.' using errcode='42501'; end if;
  if not exists(select 1 from public.payment_methods where id=p_payment_method_id and active) then raise exception 'Choose an active payment method.'; end if;
  update public.expense_payment_entries set payment_method_id=p_payment_method_id where id=p_entry_id and payment_method_id is null and amount>0;
  if not found then raise exception 'This expense payment no longer needs a method.'; end if;
  update public.finance_sync_events set status='skipped',reason='Payment method assigned in a newer event.' where source_key='expense:'||p_entry_id and status='needs_method';
  perform private.dispatch_baytna_sync();
end; $$;

revoke all on function public.get_finance_sync_admin(),public.save_finance_sync_settings(boolean,boolean,boolean,jsonb,text,jsonb),public.retry_finance_sync(boolean),public.assign_expense_sync_method(uuid,uuid) from public,anon;
grant execute on function public.get_finance_sync_admin(),public.save_finance_sync_settings(boolean,boolean,boolean,jsonb,text,jsonb),public.retry_finance_sync(boolean),public.assign_expense_sync_method(uuid,uuid) to authenticated;
revoke all on function private.queue_finance_sync(text,text,uuid,numeric,date,text,text,boolean),private.capture_lumin_income(),private.capture_expense_payment_entry(),private.capture_lumin_expense(),private.dispatch_baytna_sync() from public,anon,authenticated,service_role;
