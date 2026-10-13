-- Storage compatibility RPCs are bearer-capability endpoints for paired servers.
-- The key must be the current clinic setting, have at least 32 characters, and
-- never be copied into frontend assets or committed configuration.
create or replace function private.valid_storage_server_key(p_key text)
returns boolean language sql security definer set search_path = '' stable
as $$
  select p_key is not null and length(p_key) >= 32 and exists (
    select 1 from public.clinic_settings s
    where s.id = 1 and length(s.storage_secret_key) >= 32 and s.storage_secret_key = p_key
  );
$$;
revoke all on function private.valid_storage_server_key(text) from public, anon, authenticated;

-- Storage Server Sync: Expose patient media details and provide synchronization endpoint for local storage servers.

create or replace function public.get_all_patients_media_details(clinic_key text)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_res json;
begin
  if private.valid_storage_server_key(clinic_key) then
    select json_agg(json_build_object(
      'patient_id', patient_id,
      'relative_path', relative_path,
      'display_name', display_name,
      'note', note,
      'tooth_id', tooth_id,
      'tooth_ids', tooth_ids,
      'scan_date', scan_date,
      'scan_config', scan_config
    )) into v_res
    from public.patient_media_details;
    return coalesce(v_res, '[]'::json);
  end if;
  return '[]'::json;
end;
$$;

revoke all on function public.get_all_patients_media_details(text) from public;
grant execute on function public.get_all_patients_media_details(text) to anon, authenticated;

create or replace function public.upsert_patient_media_details_from_storage(
  p_patient_uuid uuid,
  p_relative_path text,
  p_display_name text,
  p_note text,
  p_tooth_id text,
  p_tooth_ids text[],
  p_scan_date date,
  p_scan_config jsonb,
  clinic_key text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.valid_storage_server_key(clinic_key) then
    insert into public.patient_media_details (
      patient_id, relative_path, display_name, note, tooth_id, tooth_ids, scan_date, scan_config
    ) values (
      p_patient_uuid, p_relative_path, coalesce(p_display_name, ''), coalesce(p_note, ''),
      p_tooth_id, p_tooth_ids, p_scan_date, p_scan_config
    )
    on conflict (patient_id, relative_path) do update set
      display_name = case when EXCLUDED.display_name <> '' then EXCLUDED.display_name else public.patient_media_details.display_name end,
      note = case when EXCLUDED.note <> '' then EXCLUDED.note else public.patient_media_details.note end,
      tooth_id = coalesce(EXCLUDED.tooth_id, public.patient_media_details.tooth_id),
      tooth_ids = coalesce(EXCLUDED.tooth_ids, public.patient_media_details.tooth_ids),
      scan_date = coalesce(EXCLUDED.scan_date, public.patient_media_details.scan_date),
      scan_config = coalesce(EXCLUDED.scan_config, public.patient_media_details.scan_config);
    return true;
  end if;
  return false;
end;
$$;

revoke all on function public.upsert_patient_media_details_from_storage(uuid, text, text, text, text, text[], date, jsonb, text) from public;
grant execute on function public.upsert_patient_media_details_from_storage(uuid, text, text, text, text, text[], date, jsonb, text) to anon, authenticated;
