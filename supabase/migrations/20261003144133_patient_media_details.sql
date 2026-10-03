-- Keep clinical image details shared across devices without changing the local files.
create table public.patient_media_details (
  patient_id uuid not null references public.patients(id) on delete cascade,
  relative_path text not null check (char_length(relative_path) between 1 and 512),
  display_name text not null default '' check (char_length(display_name) <= 160),
  note text not null default '' check (char_length(note) <= 4000),
  tooth_id text check (tooth_id is null or tooth_id ~ '^([1-9]|[12][0-9]|3[0-2]|[A-T])$'),
  primary key (patient_id, relative_path)
);

alter table public.patient_media_details enable row level security;
revoke all on public.patient_media_details from public, anon;
grant select, insert, update, delete on public.patient_media_details to authenticated;

create policy patient_media_details_read on public.patient_media_details
  for select to authenticated
  using ((select private.is_active_user()) and exists (
    select 1 from public.patients where patients.id = patient_media_details.patient_id
  ));

create policy patient_media_details_insert on public.patient_media_details
  for insert to authenticated
  with check ((select private.has_page_permission('patients')) and exists (
    select 1 from public.patients where patients.id = patient_media_details.patient_id
  ));

create policy patient_media_details_update on public.patient_media_details
  for update to authenticated
  using ((select private.has_page_permission('patients')) and exists (
    select 1 from public.patients where patients.id = patient_media_details.patient_id
  ))
  with check ((select private.has_page_permission('patients')) and exists (
    select 1 from public.patients where patients.id = patient_media_details.patient_id
  ));

create policy patient_media_details_delete on public.patient_media_details
  for delete to authenticated
  using ((select private.has_page_permission('patients')) and exists (
    select 1 from public.patients where patients.id = patient_media_details.patient_id
  ));
