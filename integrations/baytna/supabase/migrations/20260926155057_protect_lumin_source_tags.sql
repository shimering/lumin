-- Imported records and source tags are managed only by the privileged receiver.
create or replace function private.protect_lumin_entry()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user not in ('postgres', 'supabase_admin') and
    ((tg_op = 'INSERT' and new.external_source is not null) or
     (tg_op = 'UPDATE' and (old.external_source is not null or new.external_source is not null)) or
     (tg_op = 'DELETE' and old.external_source is not null)) then
    raise exception 'Manage Lumin entries in Lumin.' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end; $$;
