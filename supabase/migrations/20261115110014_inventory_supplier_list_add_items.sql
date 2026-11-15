-- Support adding current inventory items while keeping existing document snapshots and links.
create or replace function public.get_inventory_supplier_candidates(p_scope text) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare v_result jsonb;
begin
  if not (private.inventory_allowed('manage') or private.inventory_allowed('receive')) then
    raise exception 'INVENTORY_ACCESS' using errcode='42501';
  end if;
  if p_scope is null or p_scope not in ('out','low','both','all') then raise exception 'INVENTORY_SUPPLIER_SCOPE' using errcode='22023';end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',i.id,'revision',i.revision,'name_en',i.name_en,'name_ar',i.name_ar,
    'quantity',i.quantity,'minimum',i.minimum,'unit',i.unit,'image_version',photo.revision,
    'category_name',coalesce(g.name,p.name,c.name,''),
    'category_name_ar',coalesce(g.name_ar,p.name_ar,c.name_ar,'')
  ) order by i.name,i.id),'[]'::jsonb) into v_result
  from public.inventory_items i
  left join public.inventory_item_images photo on photo.item_id=i.id
  left join public.inventory_categories c on c.id=i.category_id
  left join public.inventory_categories p on p.id=c.parent_id
  left join public.inventory_categories g on g.id=p.parent_id
  where i.deleted_at is null and (
    p_scope='all' or (p_scope in ('out','both') and i.quantity=0)
    or (p_scope in ('low','both') and i.quantity>0 and i.minimum is not null and i.quantity<=i.minimum)
  );
  return v_result;
end;
$$;
revoke all on function public.get_inventory_supplier_candidates(text) from public,anon;
grant execute on function public.get_inventory_supplier_candidates(text) to authenticated;

create or replace function private.create_inventory_supplier_list(p_scope text,p_items jsonb,p_request_id uuid,p_language text) returns jsonb
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
  if octet_length(p_items::text)>4194304 then raise exception 'INVENTORY_SUPPLIER_INPUT' using errcode='22023';end if;
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
      'inventory_item_id',candidate->>'id',
      'name_en',candidate->>'name_en','name_ar',candidate->>'name_ar','unit',candidate->>'unit',
      'requested_quantity',(selection.item->>'requested_quantity')::numeric,
      'image_data_url',private.inventory_supplier_thumbnail(selection.item->>'image_data_url'),
      'category_name',candidate->>'category_name','category_name_ar',candidate->>'category_name_ar'
    ) order by selection.ordinality) into v_items
    from jsonb_array_elements(public.get_inventory_supplier_candidates(p_scope)) candidate
    join jsonb_array_elements(p_items) with ordinality selection(item,ordinality)
      on candidate->>'id'=selection.item->>'id' and candidate->>'revision'=selection.item->>'revision'
      and (not (selection.item ? 'image_version') or candidate->>'image_version' is not distinct from selection.item->>'image_version');
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

create or replace function private.write_inventory_supplier_list(p_id uuid,p_revision bigint,p_name text,p_items jsonb,p_request_id uuid,p_delete boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=auth.uid();v_saved private.inventory_supplier_lists;v_request private.inventory_requests;
  v_operation text:=case when p_delete then 'supplier_list_delete' else 'supplier_list_save' end;
  v_payload jsonb;v_items jsonb;v_count integer;v_added_count integer;v_result jsonb;
begin
  if v_actor is null or not(private.inventory_allowed('manage') or private.inventory_allowed('receive')) then
    raise exception 'INVENTORY_ACCESS' using errcode='42501';
  end if;
  if p_request_id is null or p_id is null or p_revision is null or p_delete is null then
    raise exception 'INVENTORY_SUPPLIER_INPUT' using errcode='22023';
  end if;
  if not p_delete and (length(coalesce(p_name,''))>120 or jsonb_typeof(p_items) is distinct from 'array' or octet_length(p_items::text)>4194304) then
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
    if v_count not between 1 and 5000 then
      raise exception 'INVENTORY_SUPPLIER_INPUT' using errcode='22023';
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_items) as selected(item)
      where case
        when item ? 'position' and not (item ? 'id') and jsonb_typeof(item->'position')='number' then
          (item->>'position')::numeric not between 1 and jsonb_array_length(v_saved.items)
          or trunc((item->>'position')::numeric)<>(item->>'position')::numeric
        when item ? 'position' then true
        else item->>'id' is null or item->>'revision' is null or not (item ? 'image_version')
      end
    ) then
      raise exception 'INVENTORY_SUPPLIER_INPUT' using errcode='22023';
    end if;
    if (
      select count(distinct coalesce((item->>'position')::numeric::integer::text,item->>'id'))
      from jsonb_array_elements(p_items) as selected(item)
    ) <> v_count then
      raise exception 'INVENTORY_SUPPLIER_INPUT' using errcode='22023';
    end if;

    if exists (
      select 1 from jsonb_array_elements(p_items) as selected(item)
      where case when jsonb_typeof(item->'requested_quantity')='number' then
        (item->>'requested_quantity')::numeric not between 1 and 1000000
        or trunc((item->>'requested_quantity')::numeric)<>(item->>'requested_quantity')::numeric
      else true end
    ) then
      raise exception 'INVENTORY_SUPPLIER_QUANTITY' using errcode='22023';
    end if;

    select count(*) into v_added_count
    from jsonb_array_elements(p_items) as selected(item)
    where item ? 'id';

    -- Existing lines keep their snapshots. Only new lines read the current catalog.
    with selection as (
      select item,ordinality from jsonb_array_elements(p_items) with ordinality as selected(item,ordinality)
    ), catalog as materialized (
      select candidate
      from jsonb_array_elements(case when v_added_count>0
        then public.get_inventory_supplier_candidates('all') else '[]'::jsonb end) as catalog(candidate)
    ), snapshots as (
      select ordinality, (v_saved.items->((item->>'position')::numeric::integer-1))
        || jsonb_build_object('requested_quantity',(item->>'requested_quantity')::numeric::integer) as snapshot
      from selection where item ? 'position'
      union all
      select ordinality, jsonb_build_object(
        'inventory_item_id',candidate->>'id',
        'name_en',candidate->>'name_en','name_ar',candidate->>'name_ar','unit',candidate->>'unit',
        'requested_quantity',(item->>'requested_quantity')::numeric::integer,
        'image_data_url',private.inventory_supplier_thumbnail(item->>'image_data_url'),
        'category_name',candidate->>'category_name','category_name_ar',candidate->>'category_name_ar'
      )
      from selection join catalog
        on candidate->>'id'=item->>'id' and candidate->>'revision'=item->>'revision'
        and (candidate->>'image_version' is not distinct from item->>'image_version')
      where item ? 'id'
    )
    select jsonb_agg(snapshot order by ordinality) into v_items from snapshots;

    if coalesce(jsonb_array_length(v_items),0)<>v_count then
      raise exception 'INVENTORY_SUPPLIER_ITEM_STALE' using errcode='40001';
    end if;

    -- Legacy snapshots have no source ID. Compare both saved names in that case.
    if v_added_count>0 and exists (
      select 1
      from jsonb_array_elements(p_items) with ordinality as selected(item,ordinality)
      cross join jsonb_array_elements(v_saved.items) as previous(snapshot)
      cross join lateral (select v_items->(selected.ordinality::integer-1) as snapshot) as added
      where selected.item ? 'id' and case when previous.snapshot->>'inventory_item_id' is not null then
        previous.snapshot->>'inventory_item_id'=added.snapshot->>'inventory_item_id'
      else
        coalesce(previous.snapshot->>'name_en','')=coalesce(added.snapshot->>'name_en','')
        and coalesce(previous.snapshot->>'name_ar','')=coalesce(added.snapshot->>'name_ar','')
      end
    ) then
      raise exception 'INVENTORY_SUPPLIER_DUPLICATE' using errcode='22023';
    end if;
    update private.inventory_supplier_lists set name=btrim(coalesce(p_name,'')),items=v_items,updated_at=now(),revision=revision+1 where id=p_id returning * into v_saved;
  end if;
  v_result:=jsonb_build_object('id',v_saved.id,'revision',v_saved.revision,'deleted',p_delete);
  insert into private.inventory_requests(id,actor_id,operation,payload,result) values(p_request_id,v_actor,v_operation,v_payload,v_result);
  return v_result;
end;
$$;
revoke all on function private.write_inventory_supplier_list(uuid,bigint,text,jsonb,uuid,boolean) from public,anon;
grant execute on function private.write_inventory_supplier_list(uuid,bigint,text,jsonb,uuid,boolean) to authenticated;

-- Source IDs are available to staff only and never included in the public supplier document.
create or replace function public.inventory_supplier_source(p_token text) returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('reference','SL-'||upper(left(id::text,8)),
    'language',language,'clinic_name',clinic_name,'items',(select coalesce(jsonb_agg(item-'inventory_item_id' order by position),'[]'::jsonb)
      from jsonb_array_elements(items) with ordinality as snapshot(item,position)),'created_at',created_at,'expires_at',expires_at)
  from private.inventory_supplier_lists
  where p_token ~ '^[a-f0-9]{64}$' and token=p_token and expires_at>now() and deleted_at is null;
$$;
revoke all on function public.inventory_supplier_source(text) from public,anon,authenticated;
grant execute on function public.inventory_supplier_source(text) to service_role;
notify pgrst,'reload schema';
