-- Include stable parent keys so Lumin can distinguish main categories and subcategories.
create function private.lumin_finance_catalog(p_space_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object(
    'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'name_ar',a.name_ar,'type',a.type) order by a.created_at)
      from public.accounts a where a.space_id=p_space_id and not a.is_archived),'[]'::jsonb),
    'categories',coalesce((select jsonb_agg(jsonb_build_object('key',coalesce(c.legacy_key,c.id::text),'kind',c.kind,'name',c.name,'name_ar',c.name_ar,
      'parent_key',coalesce(parent.legacy_key,parent.id::text),'parent_name',parent.name,'parent_name_ar',parent.name_ar) order by c.created_at)
      from public.finance_categories c left join public.finance_categories parent on coalesce(parent.legacy_key,parent.id::text)=c.parent_id and parent.space_id=c.space_id
      where c.space_id=p_space_id and c.archived_at is null),'[]'::jsonb));
$$;
revoke all on function private.lumin_finance_catalog(uuid) from public,anon,authenticated,service_role;

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
    return jsonb_build_object('ok',true,'version',version,'catalog',private.lumin_finance_catalog(config.space_id));
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
