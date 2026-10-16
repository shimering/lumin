-- Each Lumin deployment is one clinic. Inventory uses the existing active-staff RBAC.
-- Writes are available only through the private, validated ledger operation below.
alter table public.role_permissions drop constraint role_permissions_page_key_check;
alter table public.role_permissions add constraint role_permissions_page_key_check check (page_key in (
  'patients','chart','appointments','finances','analytics','hr','implants','prices',
  'dashboard_invoices','loyalty','finance_depts','whatsapp_notifications',
  'inventory','inventory_manage','inventory_receive','inventory_use','inventory_adjust'
));

create table public.inventory_categories (
  id uuid primary key default gen_random_uuid(),
  key text not null unique default gen_random_uuid()::text,
  name text not null check (length(btrim(name)) between 1 and 80),
  name_ar text not null default '' check (length(name_ar) <= 80),
  parent_id uuid references public.inventory_categories(id),
  active boolean not null default true,
  revision bigint not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  check (parent_id is distinct from id)
);
create unique index inventory_category_name on public.inventory_categories
  (coalesce(parent_id,'00000000-0000-0000-0000-000000000000'::uuid),lower(btrim(name)));
create index inventory_category_parent on public.inventory_categories(parent_id);
create unique index inventory_category_arabic_name on public.inventory_categories
  (coalesce(parent_id,'00000000-0000-0000-0000-000000000000'::uuid),lower(btrim(name_ar))) where name_ar<>'';

create table public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 160),
  category_id uuid references public.inventory_categories(id),
  quantity numeric(14,3) check (quantity >= 0 and quantity <= 1000000000),
  minimum numeric(14,3) check (minimum >= 0 and minimum <= 1000000000),
  unit text not null default '' check (length(unit) <= 40),
  sku text not null default '' check (length(sku) <= 80),
  location text not null default '' check (length(location) <= 120),
  supplier text not null default '' check (length(supplier) <= 120),
  notes text not null default '' check (length(notes) <= 2000),
  review_note text not null default '' check (length(review_note) <= 1000),
  source_data jsonb not null default '{}'::jsonb,
  import_key text unique,
  active boolean not null default true,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid
);
create index inventory_item_category on public.inventory_items(category_id);
create index inventory_item_active_name on public.inventory_items(lower(name),id) where active;

create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.inventory_items(id),
  request_id uuid not null,
  kind text not null check (kind in ('opening','receive','use','count','waste','reversal')),
  quantity numeric(14,3) not null,
  before_quantity numeric(14,3),
  after_quantity numeric(14,3) not null check (after_quantity >= 0 and after_quantity <= 1000000000),
  unit text not null,
  item_name text not null,
  category_name text not null default '',
  category_name_ar text not null default '',
  movement_date date not null,
  reason text not null default '' check (length(reason) <= 1000),
  reference text not null default '' check (length(reference) <= 160),
  reversal_of uuid references public.inventory_movements(id),
  actor_id uuid not null,
  actor_name text not null,
  created_at timestamptz not null default now(),
  unique (request_id,item_id),
  check (before_quantity is null or after_quantity = before_quantity + quantity)
);
create unique index inventory_one_reversal on public.inventory_movements(reversal_of) where reversal_of is not null;
create index inventory_movement_item_date on public.inventory_movements(item_id,created_at desc,id);
create index inventory_movement_date on public.inventory_movements(movement_date desc,created_at desc,id);

create table private.inventory_requests (
  id uuid primary key,
  actor_id uuid not null,
  operation text not null,
  payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);

-- Authorization lookup needs the private role directory, not user-editable claims.
create function private.inventory_allowed(p_capability text default 'view') returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and p_capability in ('view','manage','receive','use','adjust') and exists (
    select 1 from public.user_profiles u join public.access_roles r on r.id=u.role_id
    where u.user_id=(select auth.uid()) and u.active and (r.is_admin or (
      exists (select 1 from public.role_permissions p where p.role_id=r.id and p.page_key='inventory' and p.can_view)
      and (p_capability='view' or exists (select 1 from public.role_permissions p where p.role_id=r.id
        and p.page_key='inventory_'||p_capability and p.can_view))
    ))
  );
$$;
revoke all on function private.inventory_allowed(text) from public,anon;
grant execute on function private.inventory_allowed(text) to authenticated;

alter table public.inventory_categories enable row level security;
alter table public.inventory_items enable row level security;
alter table public.inventory_movements enable row level security;
alter table private.inventory_requests enable row level security;
create policy inventory_requests_no_direct_access on private.inventory_requests for all to authenticated using (false) with check (false);
revoke all on public.inventory_categories,public.inventory_items,public.inventory_movements from public,anon,authenticated;
revoke all on private.inventory_requests from public,anon,authenticated;
grant select on public.inventory_categories,public.inventory_items,public.inventory_movements to authenticated;
create policy inventory_categories_read on public.inventory_categories for select to authenticated using ((select private.inventory_allowed('view')));
create policy inventory_items_read on public.inventory_items for select to authenticated using ((select private.inventory_allowed('view')));
create policy inventory_movements_read on public.inventory_movements for select to authenticated using ((select private.inventory_allowed('view')));

insert into public.inventory_categories(key,name,name_ar) values ('consumables','Consumables','مستهلكات يومية');
insert into public.inventory_categories(key,name,name_ar,parent_id)
select v.key,v.name,v.name_ar,c.id from public.inventory_categories c cross join (values
  ('patient','Patient disposables','مستلزمات المرضى'),('anaesthesia','Anesthesia & needles','التخدير والإبر'),
  ('infection','Infection control','مكافحة العدوى'),('clinical','Clinical materials','مواد إكلينيكية'),
  ('surgical','Surgical supplies','مستلزمات جراحية')
) v(key,name,name_ar) where c.key='consumables';

create function private.inventory_condition(p_item public.inventory_items) returns text
language sql immutable security invoker set search_path = '' as $$
  select case when p_item.quantity is null then 'unknown' when p_item.quantity=0 then 'out'
    when p_item.minimum is null then 'unconfigured' when p_item.quantity<=p_item.minimum then 'low' else 'healthy' end;
$$;
revoke all on function private.inventory_condition(public.inventory_items) from public,anon;
grant execute on function private.inventory_condition(public.inventory_items) to authenticated;

create function public.get_inventory(p_filters jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_page integer:=greatest(1,least(100000,coalesce((p_filters->>'page')::integer,1)));
  v_size integer:=greatest(1,least(100,coalesce((p_filters->>'size')::integer,20)));
  v_query text:=lower(left(btrim(coalesce(p_filters->>'query','')),120));
  v_category text:=coalesce(p_filters->>'category','all');
  v_status text:=coalesce(p_filters->>'status','all');
  v_sort text:=coalesce(p_filters->>'sort','status');
  v_archived boolean:=coalesce((p_filters->>'archived')::boolean,false);
  v_total integer; v_rows jsonb; v_summary jsonb; v_categories jsonb;
begin
  if not private.inventory_allowed('view') then raise exception 'INVENTORY_ACCESS' using errcode='42501'; end if;
  select jsonb_build_object('total',count(*),'low',count(*) filter(where private.inventory_condition(i)='low'),
    'out',count(*) filter(where private.inventory_condition(i)='out'),'unknown',count(*) filter(where i.quantity is null),
    'review',count(*) filter(where i.quantity is null or i.minimum is null or i.unit='' or i.category_id is null or i.review_note<>''),
    'uncategorized',count(*) filter(where i.category_id is null),
    'categories',(select count(*) from public.inventory_categories c where c.active and not exists(select 1 from public.inventory_categories child where child.parent_id=c.id and child.active)))
  into v_summary from public.inventory_items i where i.active;
  select coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('item_count',(
    select count(*) from public.inventory_items i where i.active and (i.category_id=c.id or exists(
      select 1 from public.inventory_categories child where child.id=i.category_id and child.parent_id=c.id)))) order by c.parent_id nulls first,c.name),'[]'::jsonb)
  into v_categories from public.inventory_categories c;
  with filtered as (
    select i.*,private.inventory_condition(i) as stock_status,c.name as category_name,c.name_ar as category_name_ar
    from public.inventory_items i left join public.inventory_categories c on c.id=i.category_id
    where (nullif(p_filters->>'id','') is not null or i.active=(not v_archived))
      and (nullif(p_filters->>'id','') is null or i.id=(p_filters->>'id')::uuid)
      and (v_query='' or position(v_query in lower(i.name||' '||i.sku||' '||coalesce(i.source_data->>'category','')))>0
        or position(v_query in lower(coalesce(c.name,'')||' '||coalesce(c.name_ar,'')))>0)
      and (v_category='all' or (v_category='uncategorized' and i.category_id is null) or i.category_id::text=v_category
        or c.parent_id::text=v_category)
      and (v_status='all' or private.inventory_condition(i)=v_status or (v_status='review' and
        (i.quantity is null or i.minimum is null or i.unit='' or i.category_id is null or i.review_note<>'')))
  ), paged as (
    select * from filtered order by
      case when v_sort='status' then case stock_status when 'out' then 0 when 'low' then 1 when 'unknown' then 2 else 3 end end,
      case when v_sort='quantity' then quantity end nulls last,lower(name),id
    limit v_size offset (v_page-1)*v_size
  ) select (select count(*) from filtered),coalesce((select jsonb_agg(to_jsonb(p)) from paged p),'[]'::jsonb) into v_total,v_rows;
  return jsonb_build_object('items',v_rows,'total',v_total,'page',v_page,'size',v_size,'summary',v_summary,'categories',v_categories,
    'permissions',jsonb_build_object('manage',private.inventory_allowed('manage'),'receive',private.inventory_allowed('receive'),
      'use',private.inventory_allowed('use'),'adjust',private.inventory_allowed('adjust')));
end;
$$;
revoke all on function public.get_inventory(jsonb) from public,anon;
grant execute on function public.get_inventory(jsonb) to authenticated;

create function public.get_inventory_movements(p_filters jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare v_total integer;v_rows jsonb;v_page integer:=greatest(1,coalesce((p_filters->>'page')::integer,1));
begin
  if not private.inventory_allowed('view') then raise exception 'INVENTORY_ACCESS' using errcode='42501';end if;
  if v_page>100000 then raise exception 'INVENTORY_INVALID' using errcode='22023';end if;
  with filtered as (
    select m.* from public.inventory_movements m
    where (nullif(p_filters->>'item_id','') is null or m.item_id=(p_filters->>'item_id')::uuid)
      and (nullif(p_filters->>'kind','') is null or m.kind=p_filters->>'kind')
      and (nullif(p_filters->>'start','') is null or m.movement_date>=(p_filters->>'start')::date)
      and (nullif(p_filters->>'end','') is null or m.movement_date<=(p_filters->>'end')::date)
      and (nullif(p_filters->>'query','') is null or position(lower(left(p_filters->>'query',120)) in lower(m.item_name||' '||m.reference||' '||m.actor_name))>0)
  ), paged as (select * from filtered order by created_at desc,id limit 30 offset (v_page-1)*30)
  select (select count(*) from filtered),coalesce((select jsonb_agg(to_jsonb(p)) from paged p),'[]'::jsonb) into v_total,v_rows;
  return jsonb_build_object('rows',v_rows,'total',v_total,'page',v_page,'size',30);
end;
$$;
revoke all on function public.get_inventory_movements(jsonb) from public,anon;
grant execute on function public.get_inventory_movements(jsonb) to authenticated;

-- No direct DML grants: only this private function may update balances and append history.
-- Public wrappers remain invokers. Every operation validates current RBAC before taking locks.
create function private.inventory_write(p_operation text,p_payload jsonb,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_cap text;v_actor uuid:=auth.uid();v_actor_name text;v_request private.inventory_requests;
  v_item public.inventory_items;v_category public.inventory_categories;v_movement public.inventory_movements;
  v_id uuid;v_category_id uuid;v_name text;v_ar text;v_unit text;v_before numeric;v_after numeric;v_quantity numeric;v_minimum numeric;
  v_kind text;v_reason text;v_reference text;v_date date;v_today date;v_zone text;v_result jsonb;v_row jsonb;v_count integer:=0;
begin
  v_cap:=case when p_operation in ('category_save','category_archive','item_save','item_archive','assign','import') then 'manage'
    when p_operation='receive' then 'receive' when p_operation='use' then 'use'
    when p_operation in ('count','waste','reverse') then 'adjust' else null end;
  if v_cap is null or not private.inventory_allowed(v_cap) then raise exception 'INVENTORY_ACCESS' using errcode='42501';end if;
  if p_request_id is null or jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>1048576 then
    raise exception 'INVENTORY_INVALID' using errcode='22023';end if;
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
    if exists(select 1 from public.inventory_items i where i.category_id=v_id and i.active)
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
      select * into v_item from public.inventory_items where id=(v_row->>'id')::uuid and active for update;
      if not found then raise exception 'INVENTORY_ITEM' using errcode='22023';end if;
      if v_item.revision is distinct from (v_row->>'revision')::bigint then raise exception 'INVENTORY_STALE' using errcode='40001';end if;
      update public.inventory_items set category_id=v_category_id,revision=revision+1,updated_at=now(),updated_by=v_actor where id=v_item.id;
      v_count:=v_count+1;
    end loop;
    v_result:=jsonb_build_object('updated',v_count);
  elsif p_operation in ('item_save','import') then
    if p_operation='import' then
      if jsonb_typeof(p_payload->'rows') is distinct from 'array' or jsonb_array_length(p_payload->'rows') not between 1 and 500 then
        raise exception 'INVENTORY_INVALID' using errcode='22023';end if;
    end if;
    for v_row in select value from jsonb_array_elements(case when p_operation='import' then p_payload->'rows' else jsonb_build_array(p_payload) end) loop
      v_id:=case when p_operation='item_save' then nullif(v_row->>'id','')::uuid else null end;
      v_name:=btrim(coalesce(v_row->>'name',''));v_unit:=btrim(coalesce(v_row->>'unit',''));
      v_minimum:=nullif(v_row->>'minimum','')::numeric;
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
        if p_operation='import' and exists(select 1 from public.inventory_items where import_key=md5(lower(btrim(coalesce(v_row#>>'{source_data,category}','')))||':'||lower(v_name))) then
          raise exception 'INVENTORY_ALREADY_IMPORTED' using errcode='23505';end if;
        insert into public.inventory_items(name,category_id,quantity,minimum,unit,sku,location,supplier,notes,review_note,source_data,import_key,updated_by)
        values(v_name,v_category_id,v_after,v_minimum,v_unit,left(coalesce(v_row->>'sku',''),80),left(coalesce(v_row->>'location',''),120),
          left(coalesce(v_row->>'supplier',''),120),left(coalesce(v_row->>'notes',''),2000),left(coalesce(v_row->>'review_note',''),1000),
          case when p_operation='import' then coalesce(v_row->'source_data','{}'::jsonb) else '{}'::jsonb end,
          case when p_operation='import' then md5(lower(btrim(coalesce(v_row#>>'{source_data,category}','')))||':'||lower(v_name)) else null end,v_actor)
        returning * into v_item;
        v_id:=v_item.id;
        if v_after is not null then
          insert into public.inventory_movements(item_id,request_id,kind,quantity,before_quantity,after_quantity,unit,item_name,category_name,category_name_ar,movement_date,reason,actor_id,actor_name)
          values(v_id,p_request_id,'opening',v_after,null,v_after,v_unit,v_name,coalesce((select name from public.inventory_categories where id=v_category_id),''),
            coalesce((select name_ar from public.inventory_categories where id=v_category_id),''),v_date,case when p_operation='import' then 'CSV opening balance' else 'Opening count' end,v_actor,v_actor_name);
        end if;
      else
        update public.inventory_items set name=v_name,category_id=v_category_id,minimum=v_minimum,unit=v_unit,
          sku=left(coalesce(v_row->>'sku',''),80),location=left(coalesce(v_row->>'location',''),120),supplier=left(coalesce(v_row->>'supplier',''),120),
          notes=left(coalesce(v_row->>'notes',''),2000),review_note=left(coalesce(v_row->>'review_note',''),1000),
          revision=revision+1,updated_at=now(),updated_by=v_actor where id=v_id;
      end if;
      v_count:=v_count+1;
    end loop;
    v_result:=jsonb_build_object('id',v_id,'imported',case when p_operation='import' then v_count else 0 end);
  else
    v_id:=(p_payload->>'id')::uuid;
    select * into v_item from public.inventory_items where id=v_id for update;
    if not found then raise exception 'INVENTORY_ITEM' using errcode='22023';end if;
    if v_item.revision is distinct from (p_payload->>'revision')::bigint then raise exception 'INVENTORY_STALE' using errcode='40001';end if;
    if p_operation='item_archive' then
      if coalesce((p_payload->>'archived')::boolean,true)=false and v_item.category_id is not null
        and not exists(select 1 from public.inventory_categories where id=v_item.category_id and active) then
        raise exception 'INVENTORY_CATEGORY' using errcode='22023';end if;
      update public.inventory_items set active=not coalesce((p_payload->>'archived')::boolean,true),revision=revision+1,updated_at=now(),updated_by=v_actor where id=v_id;
      v_result:=jsonb_build_object('id',v_id);
    else
      if not v_item.active then raise exception 'INVENTORY_ARCHIVED' using errcode='22023';end if;
      if v_item.unit='' then raise exception 'INVENTORY_UNIT_REQUIRED' using errcode='22023';end if;
      v_before:=v_item.quantity;v_reason:=left(btrim(coalesce(p_payload->>'reason','')),1000);v_reference:=left(btrim(coalesce(p_payload->>'reference','')),160);
      v_quantity:=nullif(p_payload->>'quantity','')::numeric;v_kind:=p_operation;
      if p_operation='reverse' then
        select * into v_movement from public.inventory_movements where id=(p_payload->>'movement_id')::uuid and item_id=v_id;
        if not found or v_movement.kind in ('opening','count','reversal') or v_movement.unit<>v_item.unit then raise exception 'INVENTORY_REVERSAL' using errcode='22023';end if;
        if exists(select 1 from public.inventory_movements where reversal_of=v_movement.id) then raise exception 'INVENTORY_REVERSAL' using errcode='22023';end if;
        v_quantity:=-v_movement.quantity;v_after:=v_before+v_quantity;v_kind:='reversal';
      else
        if v_quantity is null or v_quantity<0 or v_quantity>1000000000 or v_quantity<>round(v_quantity,3) or (p_operation<>'count' and v_quantity=0) then
          raise exception 'INVENTORY_INVALID' using errcode='22023';end if;
        if p_operation='count' then v_after:=v_quantity;v_quantity:=v_after-coalesce(v_before,0);v_kind:=case when v_before is null then 'opening' else 'count' end;
        else
          if v_before is null then raise exception 'INVENTORY_COUNT_REQUIRED' using errcode='22023';end if;
          v_quantity:=v_quantity*case when p_operation in ('use','waste') then -1 else 1 end;v_after:=v_before+v_quantity;
        end if;
      end if;
      if p_operation in ('count','waste','reverse') and v_reason='' then raise exception 'INVENTORY_REASON' using errcode='22023';end if;
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
end;
$$;
revoke all on function private.inventory_write(text,jsonb,uuid) from public,anon;
grant execute on function private.inventory_write(text,jsonb,uuid) to authenticated;
create function public.inventory_write(p_operation text,p_payload jsonb,p_request_id uuid) returns jsonb
language sql security invoker set search_path = '' as $$ select private.inventory_write(p_operation,p_payload,p_request_id); $$;
revoke all on function public.inventory_write(text,jsonb,uuid) from public,anon;
grant execute on function public.inventory_write(text,jsonb,uuid) to authenticated;

-- Reuse Lumin's change-event channel; no patient or stock payload is broadcast.
do $$ declare v_check text; begin
  if to_regprocedure('private.publish_app_change()') is not null then
    select pg_get_expr(conbin,conrelid) into v_check from pg_constraint
      where conrelid='public.app_change_events'::regclass and conname='app_change_events_table_name_check';
    if v_check is not null then
      alter table public.app_change_events drop constraint app_change_events_table_name_check;
      execute format('alter table public.app_change_events add constraint app_change_events_table_name_check check ((%s) or table_name in (''inventory_categories'',''inventory_items'',''inventory_movements''))',v_check);
    end if;
    create trigger inventory_categories_publish_app_change after insert or update or delete on public.inventory_categories for each statement execute function private.publish_app_change();
    create trigger inventory_items_publish_app_change after insert or update or delete on public.inventory_items for each statement execute function private.publish_app_change();
    create trigger inventory_movements_publish_app_change after insert or update or delete on public.inventory_movements for each statement execute function private.publish_app_change();
  end if;
end $$;
notify pgrst,'reload schema';
