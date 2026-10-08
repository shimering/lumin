-- Local clinic-chat deletion. Meta Cloud API does not support recipient recall.
-- Invoker security retains the tables' RLS; access is checked against the same
-- active staff / WhatsApp-or-Appointments permissions as the application.
create function public.delete_whatsapp_message_from_lumin(p_message_id uuid, p_conversation_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_message public.whatsapp_messages;
  v_latest public.whatsapp_messages;
  v_conversation public.whatsapp_conversations;
begin
  if auth.uid() is null or not exists (
    select 1 from public.user_profiles profile
    join public.access_roles role on role.id = profile.role_id
    where profile.user_id = auth.uid() and profile.active
      and (role.is_admin or exists (
        select 1 from public.role_permissions permission
        where permission.role_id = role.id and permission.can_view
          and permission.page_key in ('whatsapp', 'appointments')
      ))
  ) then
    raise exception 'WhatsApp access is required.' using errcode = '42501';
  end if;

  -- Serialize deletion and preview changes for this conversation.
  select * into v_conversation from public.whatsapp_conversations
    where id = p_conversation_id for update;
  if not found then
    raise exception 'Conversation was not found.' using errcode = '22023';
  end if;
  select * into v_message from public.whatsapp_messages
    where id = p_message_id and conversation_id = p_conversation_id for update;
  if not found then
    raise exception 'Message was not found in this conversation.' using errcode = '22023';
  end if;

  -- Remove saved quote copies as well as the bubble itself. Original attachments
  -- remain in storage: a different message may reference the same media object.
  update public.whatsapp_messages
    set reply_to_id = null, reply_to_text = null, reply_to_sender = null
    where reply_to_id = p_message_id and conversation_id = p_conversation_id;
  delete from public.whatsapp_messages where id = p_message_id and conversation_id = p_conversation_id;

  select * into v_latest from public.whatsapp_messages
    where conversation_id = p_conversation_id order by created_at desc, id desc limit 1;
  update public.whatsapp_conversations set
    last_message = coalesce(v_latest.content, case v_latest.message_type
      when 'audio' then '🎤 Voice Message' when 'image' then '📷 Photo'
      when 'document' then 'Attachment' else '' end),
    last_message_at = v_latest.created_at,
    last_sender = v_latest.sender,
    unread_count = least(unread_count, (select count(*) from public.whatsapp_messages
      where conversation_id = p_conversation_id and sender = 'patient')),
    updated_at = now()
    where id = p_conversation_id;

  return jsonb_build_object('message_id', p_message_id, 'conversation_id', p_conversation_id, 'scope', 'lumin');
end;
$$;
revoke all on function public.delete_whatsapp_message_from_lumin(uuid, uuid) from public, anon;
grant execute on function public.delete_whatsapp_message_from_lumin(uuid, uuid) to authenticated;
