begin;
update public.prescription_print_settings set logo_data_url='data:image/png;base64,Zm9ybWxvZ28=' where id=1;
update public.quotation_settings set logo_data_url='data:image/png;base64,bGVnYWN5' where id=1;
do $$
declare actor uuid;
begin
  select p.user_id into actor from public.user_profiles p join public.access_roles r on r.id=p.role_id where p.active and r.is_admin limit 1;
  if actor is null then raise exception 'An active administrator is required for this rolled-back test.'; end if;
  insert into public.patients(id,name,chart_state) values ('11111111-1111-4111-8111-111111111111','Quotation test patient','{"1":{"wholeOperations":[{"id":"00000000-0000-4000-8000-000000000001","code":"crown","status":"P","price":100,"notes":"PRIVATE NOTE"}]}}');
  insert into public.patient_quotations(id,patient_id,selected_ids,token,expires_at,created_by) values
    ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111',array['00000000-0000-4000-8000-000000000001'::uuid],repeat('a',64),now()+interval '30 days',actor),
    ('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111',array['00000000-0000-4000-8000-000000000001'::uuid],repeat('b',64),now()-interval '1 day',actor),
    ('44444444-4444-4444-8444-444444444444','11111111-1111-4111-8111-111111111111',array['00000000-0000-4000-8000-000000000001'::uuid],repeat('c',64),now()+interval '30 days',actor);
  update public.patient_quotations set revoked_at=now() where token=repeat('c',64);
  if has_table_privilege('anon','public.patient_quotations','SELECT') then raise exception 'Anonymous quotation table access'; end if;
  if has_table_privilege('anon','public.quotation_settings','SELECT') then raise exception 'Anonymous settings table access'; end if;
  if has_table_privilege('authenticated','public.patient_quotations','INSERT') or has_table_privilege('authenticated','public.patient_quotations','UPDATE') then raise exception 'Staff writes must pass the management endpoint'; end if;
  if has_function_privilege('anon','public.quotation_source(text)','EXECUTE') or has_function_privilege('authenticated','public.quotation_source(text)','EXECUTE') then raise exception 'Private source RPC exposed'; end if;
  perform set_config('request.jwt.claims',json_build_object('sub',actor,'role','authenticated')::text,true);
end;
$$;
set local role authenticated;
do $$ begin
  if (select count(*) from public.patient_quotations where patient_id='11111111-1111-4111-8111-111111111111') <> 3 then raise exception 'Admin quotation history unavailable'; end if;
end; $$;
reset role;
select set_config('request.jwt.claims','{"sub":"99999999-9999-4999-8999-999999999999","role":"authenticated"}',true);
set local role authenticated;
do $$ begin
  if exists(select 1 from public.patient_quotations) then raise exception 'Unconfigured staff can read quotations'; end if;
  if exists(select 1 from public.quotation_settings) then raise exception 'Unconfigured staff can read settings'; end if;
end; $$;
reset role;
set local role service_role;
do $$ begin
  if public.quotation_source(repeat('a',64))->>'patient_name' <> 'Quotation test patient' then raise exception 'Valid source unavailable'; end if;
  if public.quotation_source(repeat('a',64))#>>'{clinic,logo}' is distinct from 'data:image/png;base64,Zm9ybWxvZ28=' then raise exception 'Quotation did not use the form logo'; end if;
  if public.quotation_source(repeat('b',64)) is not null then raise exception 'Expired source available'; end if;
  if public.quotation_source(repeat('c',64)) is not null then raise exception 'Revoked source available'; end if;
  if public.quotation_source(repeat('d',64)) is not null then raise exception 'Invalid source available'; end if;
end; $$;
reset role;
update public.prescription_print_settings set logo_data_url='data:image/webp;base64,dXBkYXRlZA==' where id=1;
set local role service_role;
do $$ begin
  if public.quotation_source(repeat('a',64))#>>'{clinic,logo}' is distinct from 'data:image/webp;base64,dXBkYXRlZA==' then raise exception 'Existing link did not follow form logo changes'; end if;
end; $$;
reset role;
update public.prescription_print_settings set logo_data_url=null where id=1;
set local role service_role;
do $$ begin
  if public.quotation_source(repeat('a',64))#>>'{clinic,logo}' is distinct from '' then raise exception 'Removed form logo fell back to the legacy quotation logo'; end if;
end; $$;
reset role;
delete from public.patients where id='11111111-1111-4111-8111-111111111111';
do $$ begin
  if exists(select 1 from public.patient_quotations where patient_id='11111111-1111-4111-8111-111111111111') then raise exception 'Patient deletion left accessible quotations'; end if;
end; $$;
rollback;
