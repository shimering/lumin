-- Keep the item catalog focused on name, category, unit, stock and minimum.
-- Existing quantities, category assignments and posted movements are preserved.
do $$ begin
  if exists(select 1 from public.inventory_items where not active) then
    raise exception 'Restore archived inventory items before removing item archival';
  end if;
end $$;

-- Canonical payloads retain only supported fields, including inside imported rows.
-- Removed metadata is also cleared from the private retry cache below.
create function private.inventory_payload(p_operation text,p_payload jsonb) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare v_result jsonb;v_keys text[];
begin
  v_keys:=case p_operation
    when 'category_save' then array['id','revision','name','name_ar','parent_id']
    when 'category_archive' then array['id','revision']
    when 'assign' then array['category_id','items']
    when 'item_save' then array['id','revision','name','category_id','unit','minimum','quantity','date']
    when 'import' then array['date','rows']
    when 'minimum_step' then array['id','revision','delta']
    else array['id','revision','quantity','date','reason','reference','movement_id'] end;
  select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into v_result
  from jsonb_each(p_payload) where key=any(v_keys);
  if p_operation='import' and jsonb_typeof(v_result->'rows')='array' then
    v_result:=jsonb_set(v_result,'{rows}',coalesce((
      select jsonb_agg((select coalesce(jsonb_object_agg(key,value),'{}'::jsonb)
        from jsonb_each(row_data) where key=any(array['name','category_id','unit','minimum','quantity'])) order by ordinal)
      from jsonb_array_elements(v_result->'rows') with ordinality r(row_data,ordinal)
    ),'[]'::jsonb));
  end if;
  return v_result;
end $$;
revoke all on function private.inventory_payload(text,jsonb) from public,anon,authenticated;

update private.inventory_requests set payload=private.inventory_payload(operation,payload);
update public.inventory_items set import_key=md5(lower(btrim(name))) where import_key is not null;

create or replace function public.get_inventory(p_filters jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare
  v_page integer:=greatest(1,least(100000,coalesce((p_filters->>'page')::integer,1)));
  v_size integer:=greatest(1,least(100,coalesce((p_filters->>'size')::integer,20)));
  v_query text:=lower(left(btrim(coalesce(p_filters->>'query','')),120));
  v_category text:=coalesce(p_filters->>'category','all');
  v_status text:=coalesce(p_filters->>'status','all');
  v_sort text:=coalesce(p_filters->>'sort','status');
  v_total integer;v_rows jsonb;v_summary jsonb;v_categories jsonb;
begin
  if not private.inventory_allowed('view') then raise exception 'INVENTORY_ACCESS' using errcode='42501';end if;
  select jsonb_build_object('total',count(*),'low',count(*) filter(where private.inventory_condition(i)='low'),
    'out',count(*) filter(where private.inventory_condition(i)='out'),'unknown',count(*) filter(where i.quantity is null),
    'review',count(*) filter(where i.quantity is null or i.minimum is null or i.unit='' or i.category_id is null),
    'uncategorized',count(*) filter(where i.category_id is null),
    'categories',(select count(*) from public.inventory_categories c where c.active and not exists(
      select 1 from public.inventory_categories child where child.parent_id=c.id and child.active)))
  into v_summary from public.inventory_items i;
  select coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('item_count',(
    select count(*) from public.inventory_items i where i.category_id=c.id or exists(
      select 1 from public.inventory_categories child where child.id=i.category_id and child.parent_id=c.id)))
    order by c.parent_id nulls first,c.name),'[]'::jsonb) into v_categories from public.inventory_categories c;
  with filtered as (
    select i.*,private.inventory_condition(i) as stock_status,c.name as category_name,c.name_ar as category_name_ar
    from public.inventory_items i left join public.inventory_categories c on c.id=i.category_id
    where (nullif(p_filters->>'id','') is null or i.id=(p_filters->>'id')::uuid)
      and (v_query='' or position(v_query in lower(i.name))>0
        or position(v_query in lower(coalesce(c.name,'')||' '||coalesce(c.name_ar,'')))>0)
      and (v_category='all' or (v_category='uncategorized' and i.category_id is null)
        or i.category_id::text=v_category or c.parent_id::text=v_category)
      and (v_status='all' or private.inventory_condition(i)=v_status or (v_status='review' and
        (i.quantity is null or i.minimum is null or i.unit='' or i.category_id is null)))
  ), paged as (
    select * from filtered order by
      case when v_sort='status' then case stock_status when 'out' then 0 when 'low' then 1 when 'unknown' then 2 else 3 end end,
      case when v_sort='quantity' then quantity end nulls last,lower(name),id
    limit v_size offset (v_page-1)*v_size
  ) select (select count(*) from filtered),coalesce((select jsonb_agg(to_jsonb(p)) from paged p),'[]'::jsonb) into v_total,v_rows;
  return jsonb_build_object('items',v_rows,'total',v_total,'page',v_page,'size',v_size,'summary',v_summary,'categories',v_categories,
    'permissions',jsonb_build_object('manage',private.inventory_allowed('manage'),'receive',private.inventory_allowed('receive'),
      'use',private.inventory_allowed('use'),'adjust',private.inventory_allowed('adjust')));
end $$;

create or replace function private.inventory_write(p_operation text,p_payload jsonb,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_cap text;v_actor uuid:=auth.uid();v_actor_name text;v_request private.inventory_requests;
  v_item public.inventory_items;v_category public.inventory_categories;v_movement public.inventory_movements;
  v_id uuid;v_category_id uuid;v_name text;v_ar text;v_unit text;v_before numeric;v_after numeric;v_quantity numeric;v_minimum numeric;
  v_kind text;v_reason text;v_reference text;v_date date;v_today date;v_zone text;v_result jsonb;v_row jsonb;v_count integer:=0;
begin
  v_cap:=case when p_operation in ('category_save','category_archive','item_save','assign','import','minimum_step') then 'manage'
    when p_operation='receive' then 'receive' when p_operation='use' then 'use' when p_operation='reverse' then 'adjust' else null end;
  if v_cap is null or not private.inventory_allowed(v_cap) then raise exception 'INVENTORY_ACCESS' using errcode='42501';end if;
  if p_request_id is null or jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>1048576 then
    raise exception 'INVENTORY_INVALID' using errcode='22023';end if;
  p_payload:=private.inventory_payload(p_operation,p_payload);
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,851));
  select * into v_request from private.inventory_requests where id=p_request_id;
  if found then
    if v_request.actor_id<>v_actor or v_request.operation<>p_operation or v_request.payload<>p_payload then
      raise exception 'INVENTORY_REQUEST_REUSED' using errcode='22023';end if;
    return v_request.result;
  end if;
  select coalesce(nullif(u.full_name,''),'Staff') into v_actor_name from public.user_profiles u where u.user_id=v_actor;
  select coalesce(nullif(c.attendance_timezone,''),'Africa/Cairo') into v_zone from public.clinic_settings c where c.id=1;
  v_today:=(now() at time zone coalesce(v_zone,'Africa/Cairo'))::date;
  v_date:=coalesce(nullif(p_payload->>'date','')::date,v_today);
  if v_date>v_today or v_date<'2000-01-01'::date then raise exception 'INVENTORY_DATE' using errcode='22023';end if;

  if p_operation='category_save' then
    v_name:=btrim(coalesce(p_payload->>'name',''));v_ar:=btrim(coalesce(p_payload->>'name_ar',''));
    if length(v_name) not between 1 and 80 or length(v_ar)>80 then raise exception 'INVENTORY_INVALID' using errcode='22023';end if;
    v_id:=nullif(p_payload->>'id','')::uuid;
    if v_id is null then
      v_category_id:=nullif(p_payload->>'parent_id','')::uuid;
      if v_category_id is not null then
        select * into v_category from public.inventory_categories where id=v_category_id for share;
        if not found or not v_category.active or v_category.parent_id is not null then raise exception 'INVENTORY_CATEGORY' using errcode='22023';end if;
      end if;
      insert into public.inventory_categories(name,name_ar,parent_id,updated_by) values(v_name,v_ar,v_category_id,v_actor) returning id into v_id;
    else
      select * into v_category from public.inventory_categories where id=v_id for update;
      if not found or not v_category.active then raise exception 'INVENTORY_CATEGORY' using errcode='22023';end if;
      if v_category.revision is distinct from (p_payload->>'revision')::bigint then raise exception 'INVENTORY_STALE' using errcode='40001';end if;
      update public.inventory_categories set name=v_name,name_ar=v_ar,revision=revision+1,updated_at=now(),updated_by=v_actor where id=v_id;
    end if;
    v_result:=jsonb_build_object('id',v_id);
  elsif p_operation='category_archive' then
    v_id:=(p_payload->>'id')::uuid;
    select * into v_category from public.inventory_categories where id=v_id for update;
    if not found or not v_category.active then raise exception 'INVENTORY_CATEGORY' using errcode='22023';end if;
    if v_category.revision is distinct from (p_payload->>'revision')::bigint then raise exception 'INVENTORY_STALE' using errcode='40001';end if;
    if exists(select 1 from public.inventory_items i where i.category_id=v_id)
      or exists(select 1 from public.inventory_categories c where c.parent_id=v_id and c.active) then
      raise exception 'INVENTORY_CATEGORY_IN_USE' using errcode='22023';end if;
    update public.inventory_categories set active=false,revision=revision+1,updated_at=now(),updated_by=v_actor where id=v_id;
    v_result:=jsonb_build_object('id',v_id);
  elsif p_operation='assign' then
    v_category_id:=(p_payload->>'category_id')::uuid;
    select * into v_category from public.inventory_categories where id=v_category_id and active for share;
    if not found then raise exception 'INVENTORY_CATEGORY' using errcode='22023';end if;
    if jsonb_typeof(p_payload->'items') is distinct from 'array' or jsonb_array_length(p_payload->'items') not between 1 and 100 then
      raise exception 'INVENTORY_INVALID' using errcode='22023';end if;
    for v_row in select value from jsonb_array_elements(p_payload->'items') order by value->>'id' loop
      select * into v_item from public.inventory_items where id=(v_row->>'id')::uuid for update;
      if not found then raise exception 'INVENTORY_ITEM' using errcode='22023';end if;
      if v_item.revision is distinct from (v_row->>'revision')::bigint then raise exception 'INVENTORY_STALE' using errcode='40001';end if;
      update public.inventory_items set category_id=v_category_id,revision=revision+1,updated_at=now(),updated_by=v_actor where id=v_item.id;
      v_count:=v_count+1;
    end loop;
    v_result:=jsonb_build_object('updated',v_count);
  elsif p_operation in ('item_save','import') then
    if p_operation='import' and (jsonb_typeof(p_payload->'rows') is distinct from 'array' or jsonb_array_length(p_payload->'rows') not between 1 and 500) then
      raise exception 'INVENTORY_INVALID' using errcode='22023';end if;
    for v_row in select value from jsonb_array_elements(case when p_operation='import' then p_payload->'rows' else jsonb_build_array(p_payload) end) loop
      v_id:=case when p_operation='item_save' then nullif(v_row->>'id','')::uuid else null end;
      v_name:=btrim(coalesce(v_row->>'name',''));v_unit:=btrim(coalesce(v_row->>'unit',''));v_minimum:=nullif(v_row->>'minimum','')::numeric;
      if length(v_name) not between 1 and 160 or length(v_unit)>40 or
        (v_minimum is not null and (v_minimum<0 or v_minimum>1000000000 or v_minimum<>round(v_minimum,3))) then
        raise exception 'INVENTORY_INVALID' using errcode='22023';end if;
      if v_id is not null then
        select * into v_item from public.inventory_items where id=v_id for update;
        if not found then raise exception 'INVENTORY_ITEM' using errcode='22023';end if;
        if v_item.revision is distinct from (v_row->>'revision')::bigint then raise exception 'INVENTORY_STALE' using errcode='40001';end if;
        if v_item.unit<>'' and v_item.unit<>v_unit and exists(select 1 from public.inventory_movements m where m.item_id=v_id) then
          raise exception 'INVENTORY_UNIT_LOCKED' using errcode='22023';end if;
      end if;
      v_category_id:=nullif(v_row->>'category_id','')::uuid;
      if v_category_id is not null then
        select * into v_category from public.inventory_categories where id=v_category_id and active for share;
        if not found then raise exception 'INVENTORY_CATEGORY' using errcode='22023';end if;
      end if;
      if p_operation='item_save' and v_id is null and (v_category_id is null or v_unit='' or v_minimum is null) then
        raise exception 'INVENTORY_INVALID' using errcode='22023';end if;
      if v_id is null then
        v_after:=nullif(v_row->>'quantity','')::numeric;
        if v_after is not null and not private.inventory_allowed('adjust') then raise exception 'INVENTORY_ACCESS' using errcode='42501';end if;
        if v_after is not null and (v_after<0 or v_after>1000000000 or v_after<>round(v_after,3)) then raise exception 'INVENTORY_INVALID' using errcode='22023';end if;
        if p_operation='import' and exists(select 1 from public.inventory_items where lower(btrim(name))=lower(v_name)) then
          raise exception 'INVENTORY_ALREADY_IMPORTED' using errcode='23505';end if;
        insert into public.inventory_items(name,category_id,quantity,minimum,unit,import_key,updated_by)
        values(v_name,v_category_id,v_after,v_minimum,v_unit,case when p_operation='import' then md5(lower(v_name)) else null end,v_actor) returning * into v_item;
        v_id:=v_item.id;v_before:=null;
      else
        v_before:=v_item.quantity;v_after:=v_before;
        if v_row?'quantity' and v_before is distinct from nullif(v_row->>'quantity','')::numeric then
          if v_before is not null then raise exception 'INVENTORY_USE_CONTROLS' using errcode='22023';end if;
          if not private.inventory_allowed('adjust') then raise exception 'INVENTORY_ACCESS' using errcode='42501';end if;
          v_after:=nullif(v_row->>'quantity','')::numeric;
          if v_after is not null and (v_unit='' or v_after<0 or v_after>1000000000 or v_after<>round(v_after,3)) then
            raise exception 'INVENTORY_INVALID' using errcode='22023';end if;
        end if;
        update public.inventory_items set name=v_name,category_id=v_category_id,minimum=v_minimum,unit=v_unit,quantity=v_after,
          revision=revision+1,updated_at=now(),updated_by=v_actor where id=v_id;
      end if;
      if v_before is null and v_after is not null then
        insert into public.inventory_movements(item_id,request_id,kind,quantity,before_quantity,after_quantity,unit,item_name,category_name,category_name_ar,movement_date,reason,actor_id,actor_name)
        values(v_id,p_request_id,'opening',v_after,null,v_after,v_unit,v_name,coalesce((select name from public.inventory_categories where id=v_category_id),''),
          coalesce((select name_ar from public.inventory_categories where id=v_category_id),''),v_date,case when p_operation='import' then 'CSV opening balance' else 'Opening count' end,v_actor,v_actor_name);
      end if;
      v_count:=v_count+1;
    end loop;
    v_result:=jsonb_build_object('id',v_id,'imported',case when p_operation='import' then v_count else 0 end);
  else
    v_id:=(p_payload->>'id')::uuid;
    select * into v_item from public.inventory_items where id=v_id for update;
    if not found then raise exception 'INVENTORY_ITEM' using errcode='22023';end if;
    if v_item.revision is distinct from (p_payload->>'revision')::bigint then raise exception 'INVENTORY_STALE' using errcode='40001';end if;
    if p_operation='minimum_step' then
      v_quantity:=(p_payload->>'delta')::numeric;
      if v_quantity is null or v_quantity not in (-1,1) then raise exception 'INVENTORY_INVALID' using errcode='22023';end if;
      v_minimum:=coalesce(v_item.minimum,0)+v_quantity;
      if v_minimum<0 or v_minimum>1000000000 then raise exception 'INVENTORY_NUMBER' using errcode='22023';end if;
      update public.inventory_items set minimum=v_minimum,revision=revision+1,updated_at=now(),updated_by=v_actor where id=v_id;
      v_result:=jsonb_build_object('id',v_id,'minimum',v_minimum);
    else
      if v_item.unit='' then raise exception 'INVENTORY_UNIT_REQUIRED' using errcode='22023';end if;
      v_before:=v_item.quantity;v_reason:=left(btrim(coalesce(p_payload->>'reason','')),1000);v_reference:=left(btrim(coalesce(p_payload->>'reference','')),160);
      v_quantity:=nullif(p_payload->>'quantity','')::numeric;v_kind:=p_operation;
      if p_operation='reverse' then
        select * into v_movement from public.inventory_movements where id=(p_payload->>'movement_id')::uuid and item_id=v_id;
        if not found or v_movement.kind in ('opening','count','reversal') or v_movement.unit<>v_item.unit then raise exception 'INVENTORY_REVERSAL' using errcode='22023';end if;
        if exists(select 1 from public.inventory_movements where reversal_of=v_movement.id) then raise exception 'INVENTORY_REVERSAL' using errcode='22023';end if;
        if v_reason='' then raise exception 'INVENTORY_REASON' using errcode='22023';end if;
        v_quantity:=-v_movement.quantity;v_after:=v_before+v_quantity;v_kind:='reversal';
      else
        if v_quantity is null or v_quantity<=0 or v_quantity>1000000000 or v_quantity<>round(v_quantity,3) then raise exception 'INVENTORY_INVALID' using errcode='22023';end if;
        if v_before is null then raise exception 'INVENTORY_COUNT_REQUIRED' using errcode='22023';end if;
        v_quantity:=v_quantity*case when p_operation='use' then -1 else 1 end;v_after:=v_before+v_quantity;
      end if;
      if v_after is null or v_after<0 or v_after>1000000000 then raise exception 'INVENTORY_BALANCE' using errcode='22023';end if;
      update public.inventory_items set quantity=v_after,revision=revision+1,updated_at=now(),updated_by=v_actor where id=v_id;
      insert into public.inventory_movements(item_id,request_id,kind,quantity,before_quantity,after_quantity,unit,item_name,category_name,category_name_ar,movement_date,reason,reference,reversal_of,actor_id,actor_name)
      values(v_id,p_request_id,v_kind,v_quantity,v_before,v_after,v_item.unit,v_item.name,coalesce((select name from public.inventory_categories where id=v_item.category_id),''),
        coalesce((select name_ar from public.inventory_categories where id=v_item.category_id),''),v_date,v_reason,v_reference,
        case when p_operation='reverse' then v_movement.id else null end,v_actor,v_actor_name) returning id into v_id;
      v_result:=jsonb_build_object('id',v_id,'quantity',v_after);
    end if;
  end if;
  insert into private.inventory_requests(id,actor_id,operation,payload,result) values(p_request_id,v_actor,p_operation,p_payload,v_result);
  return v_result;
end $$;

alter table public.inventory_items drop column sku,drop column location,drop column supplier,
  drop column notes,drop column review_note,drop column source_data,drop column active;
create index inventory_item_name on public.inventory_items(lower(name),id);
