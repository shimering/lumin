-- Original archives remain on the clinic storage server; only display metadata is stored here.
alter table public.patient_media_details
  add column if not exists scan_date date,
  add column if not exists scan_config jsonb;

alter table public.patient_media_details
  add constraint patient_media_scan_config_check check (
    scan_config is null or (
      jsonb_typeof(scan_config) = 'object'
      and octet_length(scan_config::text) <= 8192
      and scan_config ?& array['version','original_filename','upper_path','lower_path','orientation']
      and scan_config->>'version' = '1'
      and jsonb_typeof(scan_config->'version') = 'number'
      and jsonb_typeof(scan_config->'original_filename') = 'string'
      and length(scan_config->>'original_filename') between 1 and 255
      and jsonb_typeof(scan_config->'upper_path') = 'string'
      and jsonb_typeof(scan_config->'lower_path') = 'string'
      and length(scan_config->>'upper_path') between 1 and 1024
      and length(scan_config->>'lower_path') between 1 and 1024
      and scan_config->>'upper_path' <> scan_config->>'lower_path'
      and jsonb_typeof(scan_config->'orientation') = 'string'
      and scan_config->>'orientation' in ('z-up','y-up')
    )
  );

comment on column public.patient_media_details.scan_config is
  'Versioned original ZIP filename, selected arch paths, and whole-pair display orientation. Existing patient RLS applies.';
