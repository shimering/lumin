-- Immutable, minimal supplier snapshots. There is no direct browser access.
create table private.inventory_supplier_lists (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null,
  request_id uuid not null,
  fingerprint text not null,
  token text not null unique check (token ~ '^[a-f0-9]{64}$'),
  language text not null check (language in ('en','ar')),
  clinic_name text not null,
  items jsonb not null check (jsonb_typeof(items)='array' and jsonb_array_length(items) between 1 and 5000),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '30 days',
  unique(created_by,request_id)
);
alter table private.inventory_supplier_lists enable row level security;
revoke all on private.inventory_supplier_lists from public,anon,authenticated;
grant usage on schema private to service_role;
grant select on private.inventory_supplier_lists to service_role;

-- Full inventory, independent of the stock screen's search, category and pagination.
create function public.get_inventory_supplier_candidates(p_scope text) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare v_result jsonb;
begin
  if not (private.inventory_allowed('manage') or private.inventory_allowed('receive')) then
    raise exception 'INVENTORY_ACCESS' using errcode='42501';
  end if;
  if p_scope is null or p_scope not in ('out','low','both') then raise exception 'INVENTORY_SUPPLIER_SCOPE' using errcode='22023';end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',i.id,'revision',i.revision,'name_en',i.name_en,'name_ar',i.name_ar,
    'quantity',i.quantity,'minimum',i.minimum,'unit',i.unit,
    'category_name',coalesce(g.name,p.name,c.name,''),
    'category_name_ar',coalesce(g.name_ar,p.name_ar,c.name_ar,'')
  ) order by i.name,i.id),'[]'::jsonb) into v_result
  from public.inventory_items i
  left join public.inventory_categories c on c.id=i.category_id
  left join public.inventory_categories p on p.id=c.parent_id
  left join public.inventory_categories g on g.id=p.parent_id
  where i.deleted_at is null and (
    (p_scope in ('out','both') and i.quantity=0)
    or (p_scope in ('low','both') and i.quantity>0 and i.minimum is not null and i.quantity<=i.minimum)
  );
  return v_result;
end;
$$;
revoke all on function public.get_inventory_supplier_candidates(text) from public,anon;
grant execute on function public.get_inventory_supplier_candidates(text) to authenticated;

-- A definer is needed only to write the inaccessible snapshot table. Authorization
-- uses the live staff directory; callers cannot supply names or arbitrary content.
create function private.create_inventory_supplier_list(p_scope text,p_items jsonb,p_request_id uuid,p_language text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=auth.uid();v_saved private.inventory_supplier_lists;v_items jsonb;
  v_fingerprint text;v_clinic text;v_count integer;
begin
  if v_actor is null or not (private.inventory_allowed('manage') or private.inventory_allowed('receive')) then
    raise exception 'INVENTORY_ACCESS' using errcode='42501';
  end if;
  if p_request_id is null or p_language is null or p_language not in ('en','ar') or p_scope is null or p_scope not in ('out','low','both') then raise exception 'INVENTORY_SUPPLIER_INPUT' using errcode='22023';end if;
  if p_items is null or jsonb_typeof(p_items)<>'array' then raise exception 'INVENTORY_SUPPLIER_INPUT' using errcode='22023';end if;
  v_count:=jsonb_array_length(p_items);
  if v_count<1 or v_count>5000 or (select count(distinct x->>'id') from jsonb_array_elements(p_items) x)<>v_count then raise exception 'INVENTORY_SUPPLIER_INPUT' using errcode='22023';end if;
  if exists(select 1 from jsonb_array_elements(p_items) x where case when jsonb_typeof(x->'requested_quantity')='number'
    then (x->>'requested_quantity')::numeric not between 1 and 1000000 or trunc((x->>'requested_quantity')::numeric)<>(x->>'requested_quantity')::numeric
    else true end) then raise exception 'INVENTORY_SUPPLIER_QUANTITY' using errcode='22023';end if;
  v_fingerprint:=md5(jsonb_build_array(p_scope,p_items,p_language)::text);
  perform pg_advisory_xact_lock(hashtextextended(v_actor::text||':'||p_request_id::text,0));
  select * into v_saved from private.inventory_supplier_lists where created_by=v_actor and request_id=p_request_id;
  if found then
    if v_saved.fingerprint<>v_fingerprint then raise exception 'INVENTORY_SUPPLIER_REQUEST' using errcode='22023';end if;
  else
    select jsonb_agg(jsonb_build_object(
      'name_en',candidate->>'name_en','name_ar',candidate->>'name_ar','unit',candidate->>'unit',
      'requested_quantity',(selection.item->>'requested_quantity')::numeric,
      'category_name',candidate->>'category_name','category_name_ar',candidate->>'category_name_ar'
    ) order by selection.ordinality) into v_items
    from jsonb_array_elements(public.get_inventory_supplier_candidates(p_scope)) candidate
    join jsonb_array_elements(p_items) with ordinality selection(item,ordinality)
      on candidate->>'id'=selection.item->>'id' and candidate->>'revision'=selection.item->>'revision';
    if v_items is null or jsonb_array_length(v_items)<>v_count then raise exception 'INVENTORY_SUPPLIER_STALE' using errcode='40001';end if;
    select clinic_name into v_clinic from public.quotation_settings where id=1;
    insert into private.inventory_supplier_lists(created_by,request_id,fingerprint,token,language,clinic_name,items)
    values(v_actor,p_request_id,v_fingerprint,replace(gen_random_uuid()::text||gen_random_uuid()::text,'-',''),p_language,coalesce(nullif(btrim(v_clinic),''),'Lumin'),v_items)
    returning * into v_saved;
  end if;
  return jsonb_build_object('id',v_saved.id,'token',v_saved.token,'expires_at',v_saved.expires_at);
end;
$$;
revoke all on function private.create_inventory_supplier_list(text,jsonb,uuid,text) from public,anon;
grant execute on function private.create_inventory_supplier_list(text,jsonb,uuid,text) to authenticated;
create function public.create_inventory_supplier_list(p_scope text,p_items jsonb,p_request_id uuid,p_language text) returns jsonb
language sql security invoker set search_path='' as $$select private.create_inventory_supplier_list(p_scope,p_items,p_request_id,p_language)$$;
revoke all on function public.create_inventory_supplier_list(text,jsonb,uuid,text) from public,anon;
grant execute on function public.create_inventory_supplier_list(text,jsonb,uuid,text) to authenticated;

-- Only the Edge service role can resolve a public capability. No staff identities,
-- item IDs, balances, minimums or internal notes cross this boundary.
create function public.inventory_supplier_source(p_token text) returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('reference','SL-'||upper(left(id::text,8)),
    'language',language,'clinic_name',clinic_name,'items',items,'created_at',created_at,'expires_at',expires_at)
  from private.inventory_supplier_lists
  where p_token ~ '^[a-f0-9]{64}$' and token=p_token and expires_at>now();
$$;
revoke all on function public.inventory_supplier_source(text) from public,anon,authenticated;
grant execute on function public.inventory_supplier_source(text) to service_role;
