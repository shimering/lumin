-- Rolled-back verification: no fixture files or patient changes are retained.
begin;
do $$
declare
  pid uuid;
  got jsonb;
begin
  select id into pid from public.patients limit 1;
  if pid is null then raise exception 'A fixture patient is required'; end if;
  insert into public.patient_media_details(patient_id, relative_path, display_name, scan_date, scan_config)
  values (pid, '__scan_verification__/3D-Scans/test.zip', 'Scan', date '2026-10-05',
    '{"version":1,"original_filename":"Original.zip","upper_path":"upper.obj","lower_path":"lower.obj","orientation":"z-up"}');
  update public.patient_media_details set display_name = 'Renamed'
    where patient_id = pid and relative_path = '__scan_verification__/3D-Scans/test.zip';
  select scan_config into got from public.patient_media_details
    where patient_id = pid and relative_path = '__scan_verification__/3D-Scans/test.zip';
  if got->>'original_filename' <> 'Original.zip' then raise exception 'Scan metadata was lost'; end if;
  begin
    update public.patient_media_details set scan_config = jsonb_set(got, '{orientation}', 'null')
      where patient_id = pid and relative_path = '__scan_verification__/3D-Scans/test.zip';
    raise exception 'Null orientation was accepted';
  exception when check_violation then null;
  end;
  begin
    update public.patient_media_details set scan_config = jsonb_set(got, '{lower_path}', '"upper.obj"')
      where patient_id = pid and relative_path = '__scan_verification__/3D-Scans/test.zip';
    raise exception 'Identical arch selections were accepted';
  exception when check_violation then null;
  end;
end $$;
set local role authenticated;
do $$ begin
  if exists(select 1 from public.patient_media_details) then
    raise exception 'Unauthenticated identity can read patient metadata';
  end if;
end $$;
set local role anon;
do $$ begin
  perform 1 from public.patient_media_details limit 1;
  raise exception 'Anonymous role can access patient metadata';
exception when insufficient_privilege then null;
end $$;
rollback;
