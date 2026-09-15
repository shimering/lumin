create index if not exists idx_whatsapp_messages_conversation_created_id
  on public.whatsapp_messages (conversation_id, created_at desc, id desc);
