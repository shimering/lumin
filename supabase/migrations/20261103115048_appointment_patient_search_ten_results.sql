-- Return up to ten lightweight appointment patient matches, retaining invoker rights and RLS.
create or replace function public.search_appointment_patients(p_query text)
returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  normalized_query text;
  compact_query text;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if char_length(coalesce(p_query, '')) > 120 then
    raise exception 'Patient search must be 120 characters or fewer.' using errcode = '22023';
  end if;
  normalized_query := private.normalise_appointment_patient_search(p_query);
  if normalized_query = '' then return '[]'::jsonb; end if;
  compact_query := regexp_replace(lower(btrim(p_query)), U&'[\0009-\000d\0020\00a0\1680\2000-\200a\2028-\2029\202f\205f\3000\feff()+–—-]', '', 'g');

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', matches.id, 'patient_number', matches.patient_number,
    'name', matches.name, 'phone', matches.phone
  ) order by matches.created_at desc nulls last, matches.id), '[]'::jsonb)
  into result
  from (
    select patient.id, patient.patient_number, patient.name, patient.phone, patient.created_at
    from public.patients patient
    where not exists (
      select 1 from unnest(string_to_array(normalized_query, ' ')) term
      where strpos(private.normalise_appointment_patient_search(
        coalesce(patient.patient_number::text, '') || ' #' || coalesce(patient.patient_number::text, '—')
        || ' ' || coalesce(patient.name, '') || ' '
        || regexp_replace(coalesce(patient.phone, ''), U&'[\0009-\000d\0020\00a0\1680\2000-\200a\2028-\2029\202f\205f\3000\feff_]', '', 'g')
      ), term) = 0
    ) or (
      compact_query <> '' and strpos(
        regexp_replace(lower(coalesce(patient.phone, '')), U&'[\0009-\000d\0020\00a0\1680\2000-\200a\2028-\2029\202f\205f\3000\feff_()+–—-]', '', 'g'),
        compact_query
      ) > 0
    )
    order by patient.created_at desc nulls last, patient.id
    limit 10
  ) matches;
  return result;
end;
$$;
revoke all on function public.search_appointment_patients(text) from public, anon;
grant execute on function public.search_appointment_patients(text) to authenticated;
