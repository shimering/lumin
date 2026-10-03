-- Verify persistence and RLS in one transaction, leaving all clinic data unchanged.
begin;
create temporary table media_test_context (patient_id uuid, file_path text);
insert into media_test_context
select id, '__lumin_metadata_test__/' || gen_random_uuid()::text || '.png'
from public.patients limit 1;
grant select on media_test_context to authenticated;

do $$
declare admin_id uuid;
begin
  select profile.user_id into admin_id
  from public.user_profiles profile
  join public.access_roles role on role.id = profile.role_id
  where profile.active and role.is_admin limit 1;
  if admin_id is null or not exists (select 1 from media_test_context) then
    raise exception 'An active administrator and a patient are needed for this regression test.';
  end if;
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
end $$;

set local role authenticated;
do $$
declare context media_test_context; saved public.patient_media_details;
begin
  select * into context from media_test_context;
  insert into public.patient_media_details(patient_id, relative_path, display_name, note, tooth_id)
  values (context.patient_id, context.file_path, 'Pre-op UR6', E'Clinical note\nSecond line', '3');
  select * into saved from public.patient_media_details
  where patient_id = context.patient_id and relative_path = context.file_path;
  if saved.tooth_id is distinct from '3' or saved.note is distinct from E'Clinical note\nSecond line' then
    raise exception 'Permanent tooth and multiline note did not persist.';
  end if;

  insert into public.patient_media_details(patient_id, relative_path, display_name, note, tooth_id)
  values (context.patient_id, context.file_path, 'أشعة متابعة', 'ملاحظة تحت الصورة', 'A')
  on conflict (patient_id, relative_path) do update
  set display_name = excluded.display_name, note = excluded.note, tooth_id = excluded.tooth_id;
  select * into saved from public.patient_media_details
  where patient_id = context.patient_id and relative_path = context.file_path;
  if saved.display_name is distinct from 'أشعة متابعة' or saved.tooth_id is distinct from 'A' then
    raise exception 'Rename and deciduous tooth did not persist.';
  end if;

  -- New clients can select permanent and deciduous teeth together, without duplicates.
  update public.patient_media_details set tooth_ids = array['3','4','A','3']
  where patient_id = context.patient_id and relative_path = context.file_path;
  select * into saved from public.patient_media_details
  where patient_id = context.patient_id and relative_path = context.file_path;
  if saved.tooth_ids is distinct from array['3','4','A'] or saved.tooth_id is distinct from '3' then
    raise exception 'Multiple teeth were not saved and normalized.';
  end if;

  -- Supabase upserts from an older client omit tooth_ids (NULL in excluded).
  insert into public.patient_media_details(patient_id, relative_path, display_name, note, tooth_id)
  values (context.patient_id, context.file_path, 'Legacy rename', 'Edited note', '3')
  on conflict (patient_id, relative_path) do update set display_name = excluded.display_name,
    note = excluded.note, tooth_id = excluded.tooth_id, tooth_ids = excluded.tooth_ids;
  select * into saved from public.patient_media_details
  where patient_id = context.patient_id and relative_path = context.file_path;
  if saved.tooth_ids is distinct from array['3','4','A'] or saved.display_name <> 'Legacy rename' then
    raise exception 'A legacy metadata upsert erased multiple teeth.';
  end if;

  update public.patient_media_details set tooth_id = 'B'
  where patient_id = context.patient_id and relative_path = context.file_path;
  select * into saved from public.patient_media_details
  where patient_id = context.patient_id and relative_path = context.file_path;
  if saved.tooth_ids is distinct from array['B'] then raise exception 'Legacy tooth editing failed.'; end if;

  update public.patient_media_details set tooth_ids = '{}'
  where patient_id = context.patient_id and relative_path = context.file_path;
  select * into saved from public.patient_media_details
  where patient_id = context.patient_id and relative_path = context.file_path;
  if saved.tooth_id is not null or cardinality(saved.tooth_ids) <> 0 then
    raise exception 'Clearing all teeth failed.';
  end if;

  begin
    update public.patient_media_details set tooth_ids = array['3','33']
    where patient_id = context.patient_id and relative_path = context.file_path;
    raise exception 'An invalid multiple tooth assignment was accepted.';
  exception when check_violation then null;
  end;
  begin
    update public.patient_media_details set tooth_ids = array['3',null]
    where patient_id = context.patient_id and relative_path = context.file_path;
    raise exception 'A null tooth was accepted.';
  exception when check_violation then null;
  end;
  begin
    update public.patient_media_details set tooth_ids = array[['3','4'],['A','B']]
    where patient_id = context.patient_id and relative_path = context.file_path;
    raise exception 'A multidimensional tooth array was accepted.';
  exception when check_violation then null;
  end;

  begin
    update public.patient_media_details set tooth_id = '33'
    where patient_id = context.patient_id and relative_path = context.file_path;
    raise exception 'Invalid tooth was accepted.';
  exception when check_violation then null;
  end;
  begin
    insert into public.patient_media_details(patient_id, relative_path)
    values (gen_random_uuid(), context.file_path);
    raise exception 'An inaccessible patient was accepted.';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
do $$
begin
  perform set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
end $$;
set local role authenticated;
do $$
declare context media_test_context;
begin
  if exists (select 1 from public.patient_media_details) then
    raise exception 'An unknown login could read photo details.';
  end if;
  select * into context from media_test_context;
  begin
    insert into public.patient_media_details(patient_id, relative_path)
    values (context.patient_id, context.file_path || '.other');
    raise exception 'An unknown login could write photo details.';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
set local role anon;
do $$
begin
  begin
    perform 1 from public.patient_media_details;
    raise exception 'Anonymous access to photo details was allowed.';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
rollback;
select 'Photo metadata persistence, tooth validation, and RLS passed; test changes rolled back.' as result;
