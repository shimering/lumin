-- Store WhatsApp AI instructions as ordered, editable title/body sections.
-- Keep whatsapp_ai_instructions populated as a compiled legacy fallback.
alter table public.clinic_settings
  add column if not exists whatsapp_ai_instruction_blocks jsonb not null default '[]'::jsonb;

update public.clinic_settings
set whatsapp_ai_instruction_blocks = jsonb_build_array(
  jsonb_build_object(
    'id', 'general',
    'title', 'General',
    'body', btrim(whatsapp_ai_instructions),
    'order', 0
  )
)
where nullif(btrim(whatsapp_ai_instructions), '') is not null
  and whatsapp_ai_instruction_blocks = '[]'::jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'clinic_settings_whatsapp_ai_instruction_blocks_array'
      and conrelid = 'public.clinic_settings'::regclass
  ) then
    alter table public.clinic_settings
      add constraint clinic_settings_whatsapp_ai_instruction_blocks_array
      check (jsonb_typeof(whatsapp_ai_instruction_blocks) = 'array');
  end if;
end
$$;

comment on column public.clinic_settings.whatsapp_ai_instruction_blocks is
  'Ordered WhatsApp AI instruction sections. Each item contains id, title, and body.';
