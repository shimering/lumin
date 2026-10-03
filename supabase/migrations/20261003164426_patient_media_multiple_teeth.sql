-- NULL distinguishes legacy clients that omit the array from an intentional [] clear.
alter table public.patient_media_details add column tooth_ids text[];
update public.patient_media_details
set tooth_ids = case when tooth_id is null then '{}'::text[] else array[tooth_id] end;

alter table public.patient_media_details add constraint patient_media_details_tooth_ids_check check (
  tooth_ids is null or (
    (cardinality(tooth_ids) = 0 or array_ndims(tooth_ids) = 1)
    and cardinality(tooth_ids) <= 52
    and array_position(tooth_ids, null) is null
    and tooth_ids <@ array['1','2','3','4','5','6','7','8','9','10','11','12','13','14','15','16','17','18','19','20','21','22','23','24','25','26','27','28','29','30','31','32','A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T']::text[]
  )
);

create function private.sync_patient_media_teeth()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if TG_OP = 'UPDATE' then
    if NEW.tooth_ids is null then
      -- An older upsert can rename a file without erasing its multiple assignments.
      NEW.tooth_ids := case when NEW.tooth_id is not distinct from OLD.tooth_id
        then OLD.tooth_ids
        when NEW.tooth_id is null then '{}'::text[] else array[NEW.tooth_id] end;
    elsif NEW.tooth_ids is not distinct from OLD.tooth_ids and NEW.tooth_id is distinct from OLD.tooth_id then
      NEW.tooth_ids := case when NEW.tooth_id is null then '{}'::text[] else array[NEW.tooth_id] end;
    end if;
  end if;
  if NEW.tooth_ids is not null then
    -- Validate before unnest so malformed arrays cannot be flattened or cleaned silently.
    if cardinality(NEW.tooth_ids) > 52 or coalesce(array_ndims(NEW.tooth_ids), 1) <> 1 then
      raise check_violation using message = 'Tooth assignments must be a one-dimensional array of up to 52 teeth.';
    end if;
    if array_position(NEW.tooth_ids, null) is not null then
      raise check_violation using message = 'Tooth assignments cannot contain null teeth.';
    end if;
    select coalesce(array_agg(tooth order by first_position), '{}'::text[]) into NEW.tooth_ids
    from (select tooth, min(position) first_position from unnest(NEW.tooth_ids) with ordinality as choices(tooth, position) group by tooth) unique_teeth;
    NEW.tooth_id := NEW.tooth_ids[1];
  end if;
  return NEW;
end;
$$;
revoke all on function private.sync_patient_media_teeth() from public, anon, authenticated;
create trigger sync_patient_media_teeth before insert or update on public.patient_media_details
for each row execute function private.sync_patient_media_teeth();
