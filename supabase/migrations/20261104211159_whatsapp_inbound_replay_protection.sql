-- Preserve provider time separately from created_at (the database receipt time).
alter table public.whatsapp_messages
  add column provider_sent_at timestamptz,
  add column ai_eligible boolean not null default false;

-- Keep replay receipts after a message is deleted. Existing duplicate rows are
-- retained; backfilling one receipt per provider ID prevents future replays.
create table private.whatsapp_inbound_receipts (
  whatsapp_message_id text primary key,
  provider_sent_at timestamptz,
  received_at timestamptz not null default clock_timestamp()
);
alter table private.whatsapp_inbound_receipts enable row level security;
revoke all on private.whatsapp_inbound_receipts from public, anon, authenticated;
grant usage on schema private to service_role;
grant select, insert on private.whatsapp_inbound_receipts to service_role;

insert into private.whatsapp_inbound_receipts (whatsapp_message_id, received_at)
select whatsapp_message_id, min(created_at)
from public.whatsapp_messages
where sender = 'patient' and nullif(btrim(whatsapp_message_id), '') is not null
group by whatsapp_message_id;

-- The receipt and message insert share one transaction: failed inserts roll
-- back the receipt, and concurrent deliveries can insert at most one message.
create function private.claim_whatsapp_inbound_message()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into private.whatsapp_inbound_receipts (whatsapp_message_id, provider_sent_at)
  values (new.whatsapp_message_id, new.provider_sent_at)
  on conflict (whatsapp_message_id) do nothing;
  if not found then
    return null;
  end if;
  return new;
end;
$$;
revoke all on function private.claim_whatsapp_inbound_message() from public, anon, authenticated;
grant execute on function private.claim_whatsapp_inbound_message() to service_role;

create trigger claim_whatsapp_inbound_message
before insert on public.whatsapp_messages
for each row
when (new.sender = 'patient' and nullif(btrim(new.whatsapp_message_id), '') is not null)
execute function private.claim_whatsapp_inbound_message();

comment on column public.whatsapp_messages.provider_sent_at is 'Original message timestamp supplied by WhatsApp; null for historical or invalid-timestamp events.';
comment on column public.whatsapp_messages.ai_eligible is 'True only for a fresh incoming message with usable text/caption or successfully downloaded voice audio.';
