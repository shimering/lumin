-- Appointment search returns only five small summaries and retains patient table RLS.
-- Unicode Mark ranges mirror normalisePatientSearchText's JavaScript \p{M}.
create or replace function private.normalise_appointment_patient_search(p_value text)
returns text
language sql immutable parallel safe security invoker set search_path = '' as $$
  select btrim(regexp_replace(lower(translate(
    regexp_replace(normalize(coalesce(p_value, ''), NFKD), U&'[\0300-\036f\0483-\0489\0591-\05bd\05bf\05c1-\05c2\05c4-\05c5\05c7\0610-\061a\064b-\065f\0670\06d6-\06dc\06df-\06e4\06e7-\06e8\06ea-\06ed\0711\0730-\074a\07a6-\07b0\07eb-\07f3\07fd\0816-\0819\081b-\0823\0825-\0827\0829-\082d\0859-\085b\0897-\089f\08ca-\08e1\08e3-\0903\093a-\093c\093e-\094f\0951-\0957\0962-\0963\0981-\0983\09bc\09be-\09c4\09c7-\09c8\09cb-\09cd\09d7\09e2-\09e3\09fe\0a01-\0a03\0a3c\0a3e-\0a42\0a47-\0a48\0a4b-\0a4d\0a51\0a70-\0a71\0a75\0a81-\0a83\0abc\0abe-\0ac5\0ac7-\0ac9\0acb-\0acd\0ae2-\0ae3\0afa-\0aff\0b01-\0b03\0b3c\0b3e-\0b44\0b47-\0b48\0b4b-\0b4d\0b55-\0b57\0b62-\0b63\0b82\0bbe-\0bc2\0bc6-\0bc8\0bca-\0bcd\0bd7\0c00-\0c04\0c3c\0c3e-\0c44\0c46-\0c48\0c4a-\0c4d\0c55-\0c56\0c62-\0c63\0c81-\0c83\0cbc\0cbe-\0cc4\0cc6-\0cc8\0cca-\0ccd\0cd5-\0cd6\0ce2-\0ce3\0cf3\0d00-\0d03\0d3b-\0d3c\0d3e-\0d44\0d46-\0d48\0d4a-\0d4d\0d57\0d62-\0d63\0d81-\0d83\0dca\0dcf-\0dd4\0dd6\0dd8-\0ddf\0df2-\0df3\0e31\0e34-\0e3a\0e47-\0e4e\0eb1\0eb4-\0ebc\0ec8-\0ece\0f18-\0f19\0f35\0f37\0f39\0f3e-\0f3f\0f71-\0f84\0f86-\0f87\0f8d-\0f97\0f99-\0fbc\0fc6\102b-\103e\1056-\1059\105e-\1060\1062-\1064\1067-\106d\1071-\1074\1082-\108d\108f\109a-\109d\135d-\135f\1712-\1715\1732-\1734\1752-\1753\1772-\1773\17b4-\17d3\17dd\180b-\180d\180f\1885-\1886\18a9\1920-\192b\1930-\193b\1a17-\1a1b\1a55-\1a5e\1a60-\1a7c\1a7f\1ab0-\1ace\1b00-\1b04\1b34-\1b44\1b6b-\1b73\1b80-\1b82\1ba1-\1bad\1be6-\1bf3\1c24-\1c37\1cd0-\1cd2\1cd4-\1ce8\1ced\1cf4\1cf7-\1cf9\1dc0-\1dff\20d0-\20f0\2cef-\2cf1\2d7f\2de0-\2dff\302a-\302f\3099-\309a\a66f-\a672\a674-\a67d\a69e-\a69f\a6f0-\a6f1\a802\a806\a80b\a823-\a827\a82c\a880-\a881\a8b4-\a8c5\a8e0-\a8f1\a8ff\a926-\a92d\a947-\a953\a980-\a983\a9b3-\a9c0\a9e5\aa29-\aa36\aa43\aa4c-\aa4d\aa7b-\aa7d\aab0\aab2-\aab4\aab7-\aab8\aabe-\aabf\aac1\aaeb-\aaef\aaf5-\aaf6\abe3-\abea\abec-\abed\fb1e\fe00-\fe0f\fe20-\fe2f\+0101fd\+0102e0\+010376-\+01037a\+010a01-\+010a03\+010a05-\+010a06\+010a0c-\+010a0f\+010a38-\+010a3a\+010a3f\+010ae5-\+010ae6\+010d24-\+010d27\+010d69-\+010d6d\+010eab-\+010eac\+010efc-\+010eff\+010f46-\+010f50\+010f82-\+010f85\+011000-\+011002\+011038-\+011046\+011070\+011073-\+011074\+01107f-\+011082\+0110b0-\+0110ba\+0110c2\+011100-\+011102\+011127-\+011134\+011145-\+011146\+011173\+011180-\+011182\+0111b3-\+0111c0\+0111c9-\+0111cc\+0111ce-\+0111cf\+01122c-\+011237\+01123e\+011241\+0112df-\+0112ea\+011300-\+011303\+01133b-\+01133c\+01133e-\+011344\+011347-\+011348\+01134b-\+01134d\+011357\+011362-\+011363\+011366-\+01136c\+011370-\+011374\+0113b8-\+0113c0\+0113c2\+0113c5\+0113c7-\+0113ca\+0113cc-\+0113d0\+0113d2\+0113e1-\+0113e2\+011435-\+011446\+01145e\+0114b0-\+0114c3\+0115af-\+0115b5\+0115b8-\+0115c0\+0115dc-\+0115dd\+011630-\+011640\+0116ab-\+0116b7\+01171d-\+01172b\+01182c-\+01183a\+011930-\+011935\+011937-\+011938\+01193b-\+01193e\+011940\+011942-\+011943\+0119d1-\+0119d7\+0119da-\+0119e0\+0119e4\+011a01-\+011a0a\+011a33-\+011a39\+011a3b-\+011a3e\+011a47\+011a51-\+011a5b\+011a8a-\+011a99\+011c2f-\+011c36\+011c38-\+011c3f\+011c92-\+011ca7\+011ca9-\+011cb6\+011d31-\+011d36\+011d3a\+011d3c-\+011d3d\+011d3f-\+011d45\+011d47\+011d8a-\+011d8e\+011d90-\+011d91\+011d93-\+011d97\+011ef3-\+011ef6\+011f00-\+011f01\+011f03\+011f34-\+011f3a\+011f3e-\+011f42\+011f5a\+013440\+013447-\+013455\+01611e-\+01612f\+016af0-\+016af4\+016b30-\+016b36\+016f4f\+016f51-\+016f87\+016f8f-\+016f92\+016fe4\+016ff0-\+016ff1\+01bc9d-\+01bc9e\+01cf00-\+01cf2d\+01cf30-\+01cf46\+01d165-\+01d169\+01d16d-\+01d172\+01d17b-\+01d182\+01d185-\+01d18b\+01d1aa-\+01d1ad\+01d242-\+01d244\+01da00-\+01da36\+01da3b-\+01da6c\+01da75\+01da84\+01da9b-\+01da9f\+01daa1-\+01daaf\+01e000-\+01e006\+01e008-\+01e018\+01e01b-\+01e021\+01e023-\+01e024\+01e026-\+01e02a\+01e08f\+01e130-\+01e136\+01e2ae\+01e2ec-\+01e2ef\+01e4ec-\+01e4ef\+01e5ee-\+01e5ef\+01e8d0-\+01e8d6\+01e944-\+01e94a\+0e0100-\+0e01ef]', '', 'g'),
    'أإآٱىؤئة', 'اااايويه'
  )), U&'[\0009-\000d\0020\00a0\1680\2000-\200a\2028-\2029\202f\205f\3000\feff]+', ' ', 'g'));
$$;
revoke all on function private.normalise_appointment_patient_search(text) from public, anon;
grant execute on function private.normalise_appointment_patient_search(text) to authenticated;

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
    limit 5
  ) matches;
  return result;
end;
$$;
revoke all on function public.search_appointment_patients(text) from public, anon;
grant execute on function public.search_appointment_patients(text) to authenticated;
