-- Image bytes live in the clinic's private Google Drive. The browser receives only display metadata.
create table public.inventory_item_images (
  item_id uuid primary key references public.inventory_items(id) on delete cascade,
  revision uuid not null unique,
  drive_file_id text not null check(length(drive_file_id) between 1 and 200),
  sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text not null check(mime_type in ('image/webp','image/jpeg')),
  byte_size integer not null check(byte_size between 1 and 307200),
  width integer not null check(width between 1 and 1280),
  height integer not null check(height between 1 and 1280),
  updated_at timestamptz not null default now(),
  updated_by uuid not null
);
create table public.inventory_image_storage (
  id integer primary key check(id=1),
  drive_root_id text not null,
  drive_folder_id text not null
);
alter table public.inventory_item_images enable row level security;
alter table public.inventory_image_storage enable row level security;
revoke all on public.inventory_item_images,public.inventory_image_storage from public,anon,authenticated;
grant select(item_id,revision,mime_type,byte_size,width,height,updated_at) on public.inventory_item_images to authenticated;
grant all on public.inventory_item_images,public.inventory_image_storage to service_role;
create policy inventory_images_view on public.inventory_item_images for select to authenticated using(private.inventory_allowed('view'));
create policy inventory_images_service on public.inventory_item_images for all to service_role using(true) with check(true);
create policy inventory_image_storage_service on public.inventory_image_storage for all to service_role using(true) with check(true);
create function private.inventory_image_changed() returns trigger language plpgsql security definer set search_path='' as $$
begin insert into public.app_change_events(table_name) values('inventory_items');return null;end $$;
revoke all on function private.inventory_image_changed() from public,anon,authenticated;
create trigger inventory_image_publish_change after insert or update or delete on public.inventory_item_images
  for each statement execute function private.inventory_image_changed();

create or replace function public.get_inventory(p_filters jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare
  v_page integer:=greatest(1,least(100000,coalesce((p_filters->>'page')::integer,1)));
  v_size integer:=greatest(1,least(100,coalesce((p_filters->>'size')::integer,20)));
  v_query text:=lower(left(btrim(coalesce(p_filters->>'query','')),120));
  v_category text:=coalesce(p_filters->>'category','all');
  v_status text:=coalesce(p_filters->>'status','all');
  v_sort text:=coalesce(p_filters->>'sort','name');
  v_arabic boolean:=coalesce(p_filters->>'language','en')='ar';
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
  select coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('depth',case when parent.id is null then 0 when grandparent.id is null then 1 else 2 end,
    'path_ids',array_remove(array[grandparent.id,parent.id,c.id],null),'item_count',(
    select count(*) from public.inventory_items i
      left join public.inventory_categories child on child.id=i.category_id
      left join public.inventory_categories parent on parent.id=child.parent_id
      where c.id in (i.category_id,child.parent_id,parent.parent_id)))
    order by array_remove(array[grandparent.name,parent.name,c.name],null),c.id),'[]'::jsonb) into v_categories
  from public.inventory_categories c left join public.inventory_categories parent on parent.id=c.parent_id
  left join public.inventory_categories grandparent on grandparent.id=parent.parent_id;
  with filtered as (
    select i.*,photo.revision as image_version,photo.mime_type as image_mime,photo.width as image_width,photo.height as image_height,photo.byte_size as image_bytes,private.inventory_condition(i) as stock_status,c.name as category_name,c.name_ar as category_name_ar
    from public.inventory_items i left join public.inventory_item_images photo on photo.item_id=i.id
    left join public.inventory_categories c on c.id=i.category_id
    left join public.inventory_categories parent on parent.id=c.parent_id
    left join public.inventory_categories grandparent on grandparent.id=parent.parent_id
    where (nullif(p_filters->>'id','') is null or i.id=(p_filters->>'id')::uuid)
      and (v_query='' or position(v_query in lower(i.name||' '||i.name_en||' '||i.name_ar))>0
        or position(v_query in lower(coalesce(c.name,'')||' '||coalesce(c.name_ar,'')||' '||coalesce(parent.name,'')||' '||coalesce(parent.name_ar,'')||' '||coalesce(grandparent.name,'')||' '||coalesce(grandparent.name_ar,'')))>0)
      and (v_category='all' or (v_category='uncategorized' and i.category_id is null)
        or v_category=any(array[i.category_id::text,c.parent_id::text,parent.parent_id::text]))
      and (v_status='all' or private.inventory_condition(i)=v_status or (v_status='review' and
        (i.quantity is null or i.minimum is null or i.unit='' or i.category_id is null)))
  ), paged as (
    select * from filtered order by
      case when v_sort='status' then case stock_status when 'out' then 0 when 'low' then 1 when 'unknown' then 2 else 3 end end,
      case when v_sort='quantity' then quantity end nulls last,lower(case when v_arabic then coalesce(nullif(name_ar,''),nullif(name_en,''),name) else coalesce(nullif(name_en,''),nullif(name_ar,''),name) end),id
    limit v_size offset (v_page-1)*v_size
  ) select (select count(*) from filtered),coalesce((select jsonb_agg(to_jsonb(p)||jsonb_build_object('active',true)) from paged p),'[]'::jsonb) into v_total,v_rows;
  return jsonb_build_object('items',v_rows,'total',v_total,'page',v_page,'size',v_size,'summary',v_summary,'categories',v_categories,
    'permissions',jsonb_build_object('manage',private.inventory_allowed('manage'),'receive',private.inventory_allowed('receive'),
      'use',private.inventory_allowed('use'),'adjust',private.inventory_allowed('adjust')));
end $$;
