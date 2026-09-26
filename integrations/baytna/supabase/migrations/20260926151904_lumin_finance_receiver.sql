-- Apply to Baytna Finance, not to Lumin. No historical entries are imported.
create extension if not exists pgcrypto with schema extensions;
create table private.lumin_import_config (
  id boolean primary key default true check (id),
  source_project text not null,
  token_hash text not null check (length(token_hash) = 64),
  owner_id uuid not null references public.profiles(id),
  space_id uuid not null references public.spaces(id)
);
create table private.lumin_import_records (
  source_key text primary key,
  last_version bigint not null,
  ledger_entry_id uuid unique references public.ledger_entries(id) on delete set null
);
alter table private.lumin_import_config enable row level security;
alter table private.lumin_import_records enable row level security;
revoke all on private.lumin_import_config, private.lumin_import_records from public, anon, authenticated, service_role;

alter table public.ledger_entries add column external_source text;
alter table public.ledger_entries add column external_source_key text;
create unique index ledger_entries_external_source_key_idx on public.ledger_entries(external_source, external_source_key)
  where external_source is not null;

create or replace function private.protect_lumin_entry()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user not in ('postgres', 'supabase_admin') and
    ((tg_op = 'INSERT' and new.external_source is not null) or
     (tg_op <> 'INSERT' and old.external_source is not null)) then
    raise exception 'Manage Lumin entries in Lumin.' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end; $$;
revoke all on function private.protect_lumin_entry() from public, anon, authenticated, service_role;
create trigger protect_lumin_entry before insert or update or delete on public.ledger_entries
for each row execute function private.protect_lumin_entry();

create function public.configure_lumin_import(p_token_hash text, p_source_project text, p_owner_id uuid, p_space_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.spaces where id=p_space_id and created_by=p_owner_id and kind='personal') then
    raise exception 'A personal space owned by the configured user is required.';
  end if;
  insert into private.lumin_import_config(id, token_hash, source_project, owner_id, space_id)
  values(true, p_token_hash, p_source_project, p_owner_id, p_space_id)
  on conflict(id) do update set token_hash=excluded.token_hash, source_project=excluded.source_project;
end; $$;
revoke all on function public.configure_lumin_import(text,text,uuid,uuid) from public, anon, authenticated;
grant execute on function public.configure_lumin_import(text,text,uuid,uuid) to service_role;

create or replace function public.receive_lumin_finance(p_token text, p_event jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  config private.lumin_import_config;
  record private.lumin_import_records;
  v_source_key text;
  version bigint;
  entry_id uuid;
  v_account_id uuid;
  v_category_key text;
  entry_kind text;
  amount bigint;
  previous_claims text;
  previous_sub text;
begin
  select * into config from private.lumin_import_config where id;
  if config is null or p_token is null or length(p_token)<>64 or
     encode(extensions.hmac(p_event::text,config.token_hash,'sha256'),'hex') <> p_token or
     p_event->>'source_project' is distinct from config.source_project then
    raise exception 'Invalid integration authentication.' using errcode='28000';
  end if;
  version := (p_event->>'version')::bigint;
  if version is null or version<=0 then raise exception 'Invalid event version.'; end if;
  if p_event->>'operation'='catalog' then
    return jsonb_build_object('ok',true,'version',version,'catalog',jsonb_build_object(
      'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'name_ar',name_ar,'type',type) order by created_at)
        from public.accounts where space_id=config.space_id and not is_archived),'[]'::jsonb),
      'categories',coalesce((select jsonb_agg(jsonb_build_object('key',coalesce(legacy_key,id::text),'kind',kind,'name',name,'name_ar',name_ar) order by created_at)
        from public.finance_categories where space_id=config.space_id and archived_at is null),'[]'::jsonb)));
  end if;
  v_source_key := p_event->>'source_key';
  if v_source_key is null or v_source_key !~ '^(income:[0-9]+|expense:[a-f0-9-]{36})$' then raise exception 'Invalid source reference.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('lumin:'||v_source_key,0));
  select * into record from private.lumin_import_records where source_key=v_source_key for update;
  if record.last_version is not null and record.last_version>=version then
    return jsonb_build_object('ok',true,'version',version,'duplicate',true);
  end if;
  entry_id:=record.ledger_entry_id;
  if p_event->>'operation'='delete' then
    delete from public.ledger_entries where id=entry_id and external_source='lumin';
    entry_id:=null;
  elsif p_event->>'operation'='upsert' then
    v_account_id:=(p_event->'payload'->>'account_id')::uuid;
    v_category_key:=p_event->'payload'->>'category_key';
    entry_kind:=p_event->'payload'->>'kind';
    amount:=(p_event->'payload'->>'amount_minor')::bigint;
    if not exists(select 1 from public.accounts a where a.id=v_account_id and a.space_id=config.space_id and not a.is_archived) then
      raise exception 'Destination account is unavailable.';
    end if;
    if entry_kind not in ('income','expense') or amount is null or amount<=0 or
       entry_kind is distinct from split_part(v_source_key,':',1) then raise exception 'Invalid financial amount or kind.'; end if;
    if v_category_key is not null and not exists(select 1 from public.finance_categories c
      where c.space_id=config.space_id and coalesce(c.legacy_key,c.id::text)=v_category_key and c.kind=entry_kind and c.archived_at is null) then
      raise exception 'Destination category is unavailable.';
    end if;
    if entry_kind='expense' then amount:=-amount; end if;
    -- Preserve the normal creator check; impersonation is confined to this service-only import transaction.
    previous_claims:=current_setting('request.jwt.claims',true);
    previous_sub:=current_setting('request.jwt.claim.sub',true);
    perform set_config('request.jwt.claim.sub',config.owner_id::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',config.owner_id,'role','service_role')::text,true);
    if entry_id is null then
      insert into public.ledger_entries(space_id,account_id,category_key,kind,amount_minor,note,occurred_at,created_by,external_source,external_source_key)
      values(config.space_id,v_account_id,v_category_key,entry_kind,amount,left(coalesce(p_event->'payload'->>'note','Lumin'),250),
        (p_event->'payload'->>'occurred_at')::timestamptz,config.owner_id,'lumin',v_source_key)
      returning id into entry_id;
    else
      update public.ledger_entries set account_id=v_account_id,category_key=v_category_key,
        amount_minor=amount,note=left(coalesce(p_event->'payload'->>'note','Lumin'),250),occurred_at=(p_event->'payload'->>'occurred_at')::timestamptz
      where id=entry_id and external_source='lumin';
    end if;
    perform set_config('request.jwt.claims',coalesce(previous_claims,''),true);
    perform set_config('request.jwt.claim.sub',coalesce(previous_sub,''),true);
  else raise exception 'Invalid operation.'; end if;
  insert into private.lumin_import_records(source_key,last_version,ledger_entry_id) values(v_source_key,version,entry_id)
  on conflict on constraint lumin_import_records_pkey do update set last_version=excluded.last_version,ledger_entry_id=excluded.ledger_entry_id;
  return jsonb_build_object('ok',true,'version',version);
end; $$;
revoke all on function public.receive_lumin_finance(text,jsonb) from public, anon, authenticated;
grant execute on function public.receive_lumin_finance(text,jsonb) to service_role;
