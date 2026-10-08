create table public.quotation_settings (
  id smallint primary key default 1 check (id = 1),
  clinic_name text not null default 'Lumin Dental' check (length(btrim(clinic_name)) between 1 and 120),
  logo_data_url text not null default '' check (length(logo_data_url) <= 300000 and (logo_data_url = '' or logo_data_url ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$')),
  whatsapp_phone text not null default '' check (whatsapp_phone = '' or whatsapp_phone ~ '^[1-9][0-9]{6,14}$'),
  updated_at timestamptz not null default now()
);
insert into public.quotation_settings (id) values (1);
alter table public.quotation_settings enable row level security;
revoke all on public.quotation_settings from public, anon, authenticated;
grant select on public.quotation_settings to authenticated;
grant all on public.quotation_settings to service_role;
create policy quotation_settings_staff_read on public.quotation_settings for select to authenticated
  using ((select private.has_page_permission('chart')));

create table public.patient_quotations (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  selected_ids uuid[] not null check (cardinality(selected_ids) between 1 and 1000 and array_position(selected_ids,null) is null),
  token text not null unique check (token ~ '^[a-f0-9]{64}$'),
  language text not null default 'en' check (language in ('en','ar')),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revision bigint not null default 1 check (revision > 0),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index patient_quotations_patient_created_idx on public.patient_quotations(patient_id,created_at desc);
alter table public.patient_quotations enable row level security;
revoke all on public.patient_quotations from public, anon, authenticated;
grant select on public.patient_quotations to authenticated;
grant all on public.patient_quotations to service_role;
create policy patient_quotations_staff_read on public.patient_quotations for select to authenticated
  using ((select private.has_page_permission('chart')) and exists (select 1 from public.patients p where p.id = patient_id));

-- One database snapshot for expiry/revocation, the chart, and its catalog. This
-- function returns private source data ONLY to the Edge service role. The Edge
-- Function projects it to an explicit, minimal patient-facing response.
create function public.quotation_source(p_token text) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'id',q.id,'language',q.language,'expires_at',q.expires_at,'updated_at',q.updated_at,
    'patient_name',p.name,'chart_state',p.chart_state,'selected_ids',q.selected_ids,
    'clinic',jsonb_build_object('name',s.clinic_name,'logo',s.logo_data_url,'whatsapp',s.whatsapp_phone),
    'operations',(select coalesce(jsonb_agg(jsonb_build_object('code',o.code,'name',o.name,'price',o.price,'action_scope',o.action_scope,'visual_code',o.visual_code)),'[]'::jsonb) from public.dental_operations o)
  ) from public.patient_quotations q join public.patients p on p.id = q.patient_id
  cross join public.quotation_settings s
  where q.token = p_token and q.revoked_at is null and q.expires_at > now() and s.id = 1;
$$;
revoke all on function public.quotation_source(text) from public, anon, authenticated;
grant execute on function public.quotation_source(text) to service_role;
