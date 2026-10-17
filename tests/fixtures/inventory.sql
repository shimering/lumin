create schema auth;create schema private;create role anon;create role authenticated;create role service_role bypassrls;
create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
grant usage on schema public,private,auth to authenticated,anon;
create table public.access_roles(id uuid primary key,name text,is_admin boolean default false);
create table public.user_profiles(user_id uuid primary key,role_id uuid references public.access_roles(id),full_name text,active boolean default true);
create table public.role_permissions(role_id uuid references public.access_roles(id),page_key text,can_view boolean,can_modify boolean default false,primary key(role_id,page_key),constraint role_permissions_page_key_check check(page_key is not null));
create table public.clinic_settings(id integer primary key,attendance_timezone text);
create table public.app_change_events(id bigint generated always as identity primary key,table_name text constraint app_change_events_table_name_check check(table_name in ('patients')),changed_at timestamptz default now());
create function private.publish_app_change() returns trigger language plpgsql security definer set search_path='' as $$begin insert into public.app_change_events(table_name) values(tg_table_name);return null;end$$;
insert into public.clinic_settings values(1,'Africa/Cairo');
insert into public.access_roles(id,name,is_admin) select ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Role '||n,n=1 from generate_series(1,8)n;
insert into public.user_profiles(user_id,role_id,full_name,active) select id,id,'Staff '||name,id<>'00000000-0000-4000-8000-000000000008'::uuid from public.access_roles;
insert into public.role_permissions(role_id,page_key,can_view) select id,'inventory',true from public.access_roles where name in ('Role 2','Role 3','Role 4','Role 5','Role 6');
insert into public.role_permissions values
 ('00000000-0000-4000-8000-000000000003','inventory_manage',true,false),
 ('00000000-0000-4000-8000-000000000004','inventory_receive',true,false),
 ('00000000-0000-4000-8000-000000000005','inventory_use',true,false),
 ('00000000-0000-4000-8000-000000000006','inventory_adjust',true,false);
