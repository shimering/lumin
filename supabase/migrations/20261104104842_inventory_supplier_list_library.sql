-- Manage the saved documents independently of live inventory stock.
alter table private.inventory_supplier_lists
  add column name text not null default '' check(length(name)<=120),
  add column revision bigint not null default 1,
  add column updated_at timestamptz not null default now(),
  add column deleted_at timestamptz;
update private.inventory_supplier_lists set updated_at=created_at;
create index inventory_supplier_lists_library_idx on private.inventory_supplier_lists(updated_at desc,id desc) where deleted_at is null;

create function private.get_inventory_supplier_lists(p_query text,p_status text,p_sort text,p_page integer,p_size integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_total integer;v_rows jsonb;
begin
  if auth.uid() is null or not(private.inventory_allowed('manage') or private.inventory_allowed('receive')) then
    raise exception 'INVENTORY_ACCESS' using errcode='42501';
  end if;
  if p_status is null or p_status not in('all','active','expired') or p_sort is null or p_sort not in('newest','oldest','name')
    or p_page is null or p_page not between 1 and 100000 or p_size is null or p_size not between 1 and 50 or length(coalesce(p_query,''))>120 then
    raise exception 'INVENTORY_SUPPLIER_INPUT' using errcode='22023';
  end if;
  with matching as materialized (
    select id,name,revision,created_at,updated_at,expires_at,jsonb_array_length(items) item_count,'SL-'||upper(left(id::text,8)) reference
    from private.inventory_supplier_lists
    where deleted_at is null and (p_status='all' or (p_status='active' and expires_at>now()) or (p_status='expired' and expires_at<=now()))
      and (coalesce(btrim(p_query),'')='' or position(lower(btrim(p_query)) in lower(name||' SL-'||left(id::text,8)))>0)
  ), selected as (
    select * from matching order by
      case when p_sort='name' then lower(coalesce(nullif(name,''),reference)) end,
      case when p_sort='oldest' then created_at end asc,
      updated_at desc,id desc limit p_size offset (p_page-1)*p_size
  ) select (select count(*)::integer from matching),coalesce(jsonb_agg(to_jsonb(selected)),'[]'::jsonb) into v_total,v_rows from selected;
  return jsonb_build_object('items',v_rows,'total',v_total,'page',p_page,'size',p_size);
end;
$$;
revoke all on function private.get_inventory_supplier_lists(text,text,text,integer,integer) from public,anon;
grant execute on function private.get_inventory_supplier_lists(text,text,text,integer,integer) to authenticated;
create function public.get_inventory_supplier_lists(p_query text default '',p_status text default 'all',p_sort text default 'newest',p_page integer default 1,p_size integer default 20) returns jsonb
language sql stable security invoker set search_path='' as $$select private.get_inventory_supplier_lists(p_query,p_status,p_sort,p_page,p_size)$$;
revoke all on function public.get_inventory_supplier_lists(text,text,text,integer,integer) from public,anon;
grant execute on function public.get_inventory_supplier_lists(text,text,text,integer,integer) to authenticated;

create function private.get_inventory_supplier_list(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_saved private.inventory_supplier_lists;
begin
  if auth.uid() is null or not(private.inventory_allowed('manage') or private.inventory_allowed('receive')) then
    raise exception 'INVENTORY_ACCESS' using errcode='42501';
  end if;
  select * into v_saved from private.inventory_supplier_lists where id=p_id and deleted_at is null;
  if not found then raise exception 'INVENTORY_SUPPLIER_MISSING' using errcode='22023';end if;
  return jsonb_build_object('id',v_saved.id,'name',v_saved.name,'revision',v_saved.revision,'reference','SL-'||upper(left(v_saved.id::text,8)),
    'created_at',v_saved.created_at,'updated_at',v_saved.updated_at,'expires_at',v_saved.expires_at,'token',v_saved.token,'items',v_saved.items);
end;
$$;
revoke all on function private.get_inventory_supplier_list(uuid) from public,anon;
grant execute on function private.get_inventory_supplier_list(uuid) to authenticated;
create function public.get_inventory_supplier_list(p_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$select private.get_inventory_supplier_list(p_id)$$;
revoke all on function public.get_inventory_supplier_list(uuid) from public,anon;
grant execute on function public.get_inventory_supplier_list(uuid) to authenticated;

-- Reuse the private request ledger so a lost response can be retried safely.
-- Only quantities and inclusion change; names, units and photos come from the
-- existing snapshot and can never be replaced by arbitrary public content.
create function private.write_inventory_supplier_list(p_id uuid,p_revision bigint,p_name text,p_items jsonb,p_request_id uuid,p_delete boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=auth.uid();v_saved private.inventory_supplier_lists;v_request private.inventory_requests;
  v_operation text:=case when p_delete then 'supplier_list_delete' else 'supplier_list_save' end;
  v_payload jsonb;v_items jsonb;v_count integer;v_result jsonb;
begin
  if v_actor is null or not(private.inventory_allowed('manage') or private.inventory_allowed('receive')) then
    raise exception 'INVENTORY_ACCESS' using errcode='42501';
  end if;
  if p_request_id is null or p_id is null or p_revision is null or p_delete is null then
    raise exception 'INVENTORY_SUPPLIER_INPUT' using errcode='22023';
  end if;
  if not p_delete and (length(coalesce(p_name,''))>120 or jsonb_typeof(p_items) is distinct from 'array' or octet_length(p_items::text)>1048576) then
    raise exception 'INVENTORY_SUPPLIER_INPUT' using errcode='22023';
  end if;
  v_payload:=jsonb_build_object('id',p_id,'revision',p_revision,'name',p_name,'items',p_items,'delete',p_delete);
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,851));
  select * into v_request from private.inventory_requests where id=p_request_id;
  if found then
    if v_request.actor_id<>v_actor or v_request.operation<>v_operation or v_request.payload<>v_payload then
      raise exception 'INVENTORY_SUPPLIER_REQUEST' using errcode='22023';
    end if;
    return v_request.result;
  end if;
  select * into v_saved from private.inventory_supplier_lists where id=p_id and deleted_at is null for update;
  if not found then raise exception 'INVENTORY_SUPPLIER_MISSING' using errcode='22023';end if;
  if v_saved.revision<>p_revision then raise exception 'INVENTORY_SUPPLIER_STALE' using errcode='40001';end if;
  if p_delete then
    update private.inventory_supplier_lists set deleted_at=now(),updated_at=now(),revision=revision+1 where id=p_id returning * into v_saved;
  else
    v_count:=jsonb_array_length(p_items);
    if v_count<1 or v_count>jsonb_array_length(v_saved.items) then raise exception 'INVENTORY_SUPPLIER_INPUT' using errcode='22023';end if;
    if exists(select 1 from jsonb_array_elements(p_items) x where
      case when jsonb_typeof(x->'position')='number' then
        (x->>'position')::numeric not between 1 and jsonb_array_length(v_saved.items) or trunc((x->>'position')::numeric)<>(x->>'position')::numeric else true end) then
      raise exception 'INVENTORY_SUPPLIER_INPUT' using errcode='22023';
    end if;
    if (select count(distinct (x->>'position')::integer) from jsonb_array_elements(p_items) x)<>v_count then raise exception 'INVENTORY_SUPPLIER_INPUT' using errcode='22023';end if;
    if exists(select 1 from jsonb_array_elements(p_items) x where
      case when jsonb_typeof(x->'requested_quantity')='number' then
        (x->>'requested_quantity')::numeric not between 1 and 1000000 or trunc((x->>'requested_quantity')::numeric)<>(x->>'requested_quantity')::numeric else true end) then
      raise exception 'INVENTORY_SUPPLIER_QUANTITY' using errcode='22023';
    end if;
    select jsonb_agg((v_saved.items->((selection.item->>'position')::integer-1))||jsonb_build_object('requested_quantity',(selection.item->>'requested_quantity')::integer) order by selection.ordinality)
      into v_items from jsonb_array_elements(p_items) with ordinality selection(item,ordinality);
    update private.inventory_supplier_lists set name=btrim(coalesce(p_name,'')),items=v_items,updated_at=now(),revision=revision+1 where id=p_id returning * into v_saved;
  end if;
  v_result:=jsonb_build_object('id',v_saved.id,'revision',v_saved.revision,'deleted',p_delete);
  insert into private.inventory_requests(id,actor_id,operation,payload,result) values(p_request_id,v_actor,v_operation,v_payload,v_result);
  return v_result;
end;
$$;
revoke all on function private.write_inventory_supplier_list(uuid,bigint,text,jsonb,uuid,boolean) from public,anon;
grant execute on function private.write_inventory_supplier_list(uuid,bigint,text,jsonb,uuid,boolean) to authenticated;
create function public.save_inventory_supplier_list(p_id uuid,p_revision bigint,p_name text,p_items jsonb,p_request_id uuid) returns jsonb
language sql security invoker set search_path='' as $$select private.write_inventory_supplier_list(p_id,p_revision,p_name,p_items,p_request_id,false)$$;
revoke all on function public.save_inventory_supplier_list(uuid,bigint,text,jsonb,uuid) from public,anon;
grant execute on function public.save_inventory_supplier_list(uuid,bigint,text,jsonb,uuid) to authenticated;
create function public.delete_inventory_supplier_list(p_id uuid,p_revision bigint,p_request_id uuid) returns jsonb
language sql security invoker set search_path='' as $$select private.write_inventory_supplier_list(p_id,p_revision,null,null,p_request_id,true)$$;
revoke all on function public.delete_inventory_supplier_list(uuid,bigint,uuid) from public,anon;
grant execute on function public.delete_inventory_supplier_list(uuid,bigint,uuid) to authenticated;

-- Deletion also revokes existing supplier links without touching stock.
create or replace function public.inventory_supplier_source(p_token text) returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('reference','SL-'||upper(left(id::text,8)),
    'language',language,'clinic_name',clinic_name,'items',items,'created_at',created_at,'expires_at',expires_at)
  from private.inventory_supplier_lists
  where p_token ~ '^[a-f0-9]{64}$' and token=p_token and expires_at>now() and deleted_at is null;
$$;
revoke all on function public.inventory_supplier_source(text) from public,anon,authenticated;
grant execute on function public.inventory_supplier_source(text) to service_role;
notify pgrst,'reload schema';
