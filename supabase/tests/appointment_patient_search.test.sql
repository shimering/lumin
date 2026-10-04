-- Fixtures, JWT settings, and patient changes are all rolled back.
begin;
insert into public.patients (name, phone, patient_number, created_at)
select 'LuminSearchFixture ' || case i
  when 1 then 'Alpha Beta'
  when 2 then 'أَحْمَد يحيى'
  when 3 then 'Élodie'
  when 7 then 'O''Reilly'
  when 8 then 'Literal %,(name)'
  else 'Patient ' || i end,
  '(010) 555-000' || i, 9000000000000 + i,
  timestamptz '2099-01-01 00:00:00+00' + i * interval '1 minute'
from generate_series(1, 8) i;

do $$
declare actor uuid;
begin
  select profile.user_id into actor from public.user_profiles profile
    join public.access_roles role on role.id = profile.role_id
    where profile.active and role.is_admin limit 1;
  if actor is null then raise exception 'An active admin fixture is required'; end if;
  perform set_config('request.jwt.claim.sub', actor::text, true);
end;
$$;
set local role authenticated;

do $$
declare result jsonb; item jsonb;
begin
  if public.search_appointment_patients(null) <> '[]'::jsonb
    or public.search_appointment_patients('   ') <> '[]'::jsonb then
    raise exception 'Empty queries must return no patients';
  end if;
  if private.normalise_appointment_patient_search('أَحْمَد Élodie يحيى')
    <> 'احمد elodie يحيي' then raise exception 'Arabic and accent normalization failed'; end if;
  result := public.search_appointment_patients('luminsearchfixture');
  if jsonb_array_length(result) <> 5
    or (result->0->>'patient_number')::bigint <> 9000000000008
    or (result->4->>'patient_number')::bigint <> 9000000000004 then
    raise exception 'Search cap or newest-first ordering failed';
  end if;
  for item in select value from jsonb_array_elements(result) loop
    if (select count(*) from jsonb_object_keys(item)) <> 4
      or not (item ?& array['id','patient_number','name','phone']) then
      raise exception 'Search returned more than a lightweight summary';
    end if;
  end loop;
  result := public.search_appointment_patients('Beta LuminSearchFixture Alpha');
  if jsonb_array_length(result) <> 1 then raise exception 'Multiword matching changed'; end if;
  result := public.search_appointment_patients('LuminSearchFixture احمد يحيي');
  if jsonb_array_length(result) <> 1 or (result->0->>'patient_number')::bigint <> 9000000000002 then
    raise exception 'Flexible Arabic spelling failed';
  end if;
  result := public.search_appointment_patients('LuminSearchFixture ELODIE');
  if jsonb_array_length(result) <> 1 then raise exception 'Accent and case matching failed'; end if;
  result := public.search_appointment_patients('900000000000');
  if jsonb_array_length(result) <> 5 then raise exception 'Partial patient numbers failed'; end if;
  result := public.search_appointment_patients('#9000000000001');
  if jsonb_array_length(result) <> 1 then raise exception 'Patient number with # failed'; end if;
  result := public.search_appointment_patients('(010) 555—0001');
  if jsonb_array_length(result) <> 1 then raise exception 'Formatted phone matching failed'; end if;
  result := public.search_appointment_patients('LuminSearchFixture %');
  if jsonb_array_length(result) <> 1 then raise exception 'Wildcards must be literal search text'; end if;
  result := public.search_appointment_patients('LuminSearchFixture O''Reilly');
  if jsonb_array_length(result) <> 1 then raise exception 'Quoted search text failed'; end if;
  if public.search_appointment_patients('__no_appointment_search_fixture__') <> '[]'::jsonb then
    raise exception 'No-match query failed';
  end if;
  begin
    perform public.search_appointment_patients(repeat('a', 121));
    raise exception 'Oversized search was accepted';
  exception when invalid_parameter_value then null;
  end;
  if has_function_privilege('anon','public.search_appointment_patients(text)','execute')
    or has_function_privilege('anon','private.normalise_appointment_patient_search(text)','execute') then
    raise exception 'Anonymous search access exposed';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where p.proname in ('search_appointment_patients','normalise_appointment_patient_search')
      and n.nspname in ('public','private') and p.prosecdef) then
    raise exception 'Patient search must retain invoker rights';
  end if;
end;
$$;
reset role;

do $$ begin perform set_config('request.jwt.claim.sub', gen_random_uuid()::text, true); end; $$;
set local role authenticated;
do $$
begin
  if public.search_appointment_patients('LuminSearchFixture') <> '[]'::jsonb then
    raise exception 'Patient RLS was bypassed';
  end if;
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    perform public.search_appointment_patients('LuminSearchFixture');
    raise exception 'Missing authentication was accepted';
  exception when insufficient_privilege then null;
  end;
end;
$$;
rollback;
select 'Appointment patient search SQL checks passed' as result;
