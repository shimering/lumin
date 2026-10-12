-- Google credentials, media grants and sync history are backend-only.
create table public.google_drive_connection (
  id integer primary key check (id = 1),
  node_id uuid not null default gen_random_uuid(),
  google_email text not null,
  root_id text not null,
  root_name text not null,
  change_token text not null,
  refresh_token_encrypted text not null,
  connected_by uuid not null references auth.users(id),
  connected_at timestamptz not null default now()
);
create table public.google_drive_oauth_states (
  state_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null
);
create table public.google_drive_media_grants (
  token_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null
);
create table public.google_drive_peers (
  node_id uuid primary key,
  secret_hash text not null,
  authorized_by uuid not null references auth.users(id) on delete cascade,
  paired_at timestamptz not null default now()
);
create table public.google_drive_folders (
  path_key text primary key,
  relative_path text not null,
  drive_id text not null unique,
  patient_id uuid references public.patients(id) on delete restrict
);
create table public.google_drive_files (
  path_key text primary key,
  record jsonb not null,
  drive_id text,
  mime_type text not null default 'application/octet-stream',
  revision uuid not null default gen_random_uuid(),
  modified_at timestamptz not null default now(),
  check (jsonb_typeof(record) = 'object'),
  check ((record->>'deleted')::boolean or drive_id is not null)
);
create table public.google_drive_metadata (
  id integer primary key check (id = 1),
  snapshot jsonb,
  digest text not null default '53b41ab0dae62befcb8708620b6d14794a24fedad6c24c03dd01e51fa698ff0b',
  revision uuid not null default gen_random_uuid()
);
insert into public.google_drive_metadata(id) values (1);
create table public.google_drive_history (
  id uuid primary key default gen_random_uuid(),
  relative_path text,
  drive_id text,
  record jsonb,
  snapshot jsonb,
  reason text not null,
  created_at timestamptz not null default now()
);
create table public.google_drive_lock (
  id integer primary key check (id = 1),
  owner uuid,
  expires_at timestamptz not null default now()
);
insert into public.google_drive_lock(id) values (1);

-- Serialize Google mutations as well as their database commits. A crashed
-- function relinquishes its lease automatically; expected revisions guard retries.
create function public.google_drive_claim_lock(p_owner uuid)
returns boolean language sql security invoker set search_path = '' as $$
  with claimed as (
    update public.google_drive_lock set owner = p_owner, expires_at = now() + interval '120 seconds'
    where id = 1 and expires_at <= now() returning id
  ) select exists(select 1 from claimed);
$$;
create function public.google_drive_release_lock(p_owner uuid)
returns void language sql security invoker set search_path = '' as $$
  update public.google_drive_lock set owner = null, expires_at = now() where id = 1 and owner = p_owner;
$$;
create function public.google_drive_renew_lock(p_owner uuid)
returns boolean language sql security invoker set search_path = '' as $$
  with renewed as (
    update public.google_drive_lock set expires_at = now() + interval '120 seconds'
    where id = 1 and owner = p_owner and expires_at > now() returning id
  ) select exists(select 1 from renewed);
$$;
-- Patient folder renames must change path indexes and annotations together.
create function public.google_drive_rename_paths(p_owner uuid, p_revision uuid,
  p_folders jsonb, p_records jsonb, p_snapshot jsonb, p_digest text)
returns void language plpgsql security invoker set search_path = '' as $$
declare f jsonb;
begin
  if not exists(select 1 from public.google_drive_lock where id = 1 and owner = p_owner and expires_at > now())
    or not exists(select 1 from public.google_drive_metadata where id = 1 and revision = p_revision) then
    raise exception 'Drive changed during rename';
  end if;
  insert into public.google_drive_history(snapshot, reason)
    select snapshot, 'patient-rename' from public.google_drive_metadata where id = 1;
  for f in select * from jsonb_array_elements(p_folders) loop
    update public.google_drive_folders set path_key = f->>'path_key', relative_path = f->>'relative_path'
      where path_key = f->>'old_key' and drive_id = f->>'drive_id';
    if not found then raise exception 'Drive folder changed during rename'; end if;
  end loop;
  insert into public.google_drive_files(path_key, record, drive_id, mime_type, revision, modified_at)
    select r.path_key, r.record, r.drive_id, r.mime_type, gen_random_uuid(), now()
    from jsonb_to_recordset(p_records) as r(path_key text, record jsonb, drive_id text, mime_type text)
    on conflict (path_key) do update set record = excluded.record, drive_id = excluded.drive_id,
      mime_type = excluded.mime_type, revision = excluded.revision, modified_at = excluded.modified_at;
  update public.google_drive_metadata set snapshot = p_snapshot, digest = p_digest, revision = gen_random_uuid() where id = 1;
end;
$$;

alter table public.google_drive_connection enable row level security;
alter table public.google_drive_oauth_states enable row level security;
alter table public.google_drive_media_grants enable row level security;
alter table public.google_drive_peers enable row level security;
alter table public.google_drive_folders enable row level security;
alter table public.google_drive_files enable row level security;
alter table public.google_drive_metadata enable row level security;
alter table public.google_drive_history enable row level security;
alter table public.google_drive_lock enable row level security;
revoke all on public.google_drive_connection, public.google_drive_oauth_states,
  public.google_drive_media_grants, public.google_drive_peers, public.google_drive_folders,
  public.google_drive_files, public.google_drive_metadata, public.google_drive_history,
  public.google_drive_lock from public, anon, authenticated;
grant all on public.google_drive_connection, public.google_drive_oauth_states,
  public.google_drive_media_grants, public.google_drive_peers, public.google_drive_folders,
  public.google_drive_files, public.google_drive_metadata, public.google_drive_history,
  public.google_drive_lock to service_role;
revoke all on function public.google_drive_claim_lock(uuid), public.google_drive_release_lock(uuid), public.google_drive_renew_lock(uuid) from public, anon, authenticated;
grant execute on function public.google_drive_claim_lock(uuid), public.google_drive_release_lock(uuid), public.google_drive_renew_lock(uuid) to service_role;
revoke all on function public.google_drive_rename_paths(uuid, uuid, jsonb, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.google_drive_rename_paths(uuid, uuid, jsonb, jsonb, jsonb, text) to service_role;

create index google_drive_grants_expiry on public.google_drive_media_grants(expires_at);
create index google_drive_states_expiry on public.google_drive_oauth_states(expires_at);
create index google_drive_folders_patient on public.google_drive_folders(patient_id);
