-- All messages, permissions and changes to staff profiles are rolled back.
begin;
create temporary table wa_delete_fixture (actor uuid, old_role uuid, restricted_role uuid, chat uuid, other_chat uuid, first_message uuid, quote_message uuid, latest_message uuid);
grant select on wa_delete_fixture to authenticated;
do $$
declare f wa_delete_fixture; v_result jsonb;
begin
  select p.user_id, p.role_id into f.actor, f.old_role from public.user_profiles p
    join public.access_roles r on r.id=p.role_id where p.active and r.is_admin limit 1;
  if f.actor is null then raise exception 'An active administrator is required for this verification'; end if;
  insert into public.access_roles(name,is_admin) values ('WhatsApp deletion verification',false) returning id into f.restricted_role;
  insert into public.whatsapp_conversations(phone,last_message,last_message_at,unread_count)
    values ('delete-test-'||gen_random_uuid(),'Latest','2099-01-01 10:02:00Z',3) returning id into f.chat;
  insert into public.whatsapp_conversations(phone) values ('delete-test-'||gen_random_uuid()) returning id into f.other_chat;
  insert into public.whatsapp_messages(conversation_id,sender,content,created_at)
    values (f.chat,'patient','Original','2099-01-01 10:00:00Z') returning id into f.first_message;
  insert into public.whatsapp_messages(conversation_id,sender,content,created_at,reply_to_id,reply_to_text,reply_to_sender)
    values (f.chat,'staff','Reply','2099-01-01 10:01:00Z',f.first_message,'Original','Patient') returning id into f.quote_message;
  insert into public.whatsapp_messages(conversation_id,sender,content,created_at)
    values (f.chat,'staff','Latest','2099-01-01 10:02:00Z') returning id into f.latest_message;
  insert into wa_delete_fixture select f.*;
  perform set_config('request.jwt.claim.sub',f.actor::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',f.actor,'role','authenticated')::text,true);
end; $$;
set local role authenticated;
do $$
declare f wa_delete_fixture; v_result jsonb;
begin
  select * into f from wa_delete_fixture;
  begin
    perform public.delete_whatsapp_message_from_lumin(f.first_message,f.other_chat);
    raise exception 'Cross-conversation deletion succeeded';
  exception when invalid_parameter_value then null; end;
  v_result := public.delete_whatsapp_message_from_lumin(f.first_message,f.chat);
  if v_result->>'scope'<>'lumin' or v_result->>'message_id'<>f.first_message::text then raise exception 'Unexpected delete result'; end if;
  if exists(select 1 from public.whatsapp_messages where id=f.first_message) then raise exception 'Original message remains'; end if;
  if exists(select 1 from public.whatsapp_messages where id=f.quote_message and (reply_to_id is not null or reply_to_text is not null or reply_to_sender is not null)) then raise exception 'Quoted copy remains'; end if;
  if not exists(select 1 from public.whatsapp_conversations where id=f.chat and last_message='Latest' and unread_count=0) then raise exception 'Older deletion broke preview or unread count'; end if;
  begin
    perform public.delete_whatsapp_message_from_lumin(f.first_message,f.chat);
    raise exception 'Repeated deletion falsely succeeded';
  exception when invalid_parameter_value then null; end;
  perform public.delete_whatsapp_message_from_lumin(f.latest_message,f.chat);
  if not exists(select 1 from public.whatsapp_conversations where id=f.chat and last_message='Reply' and last_sender='staff' and last_message_at='2099-01-01 10:01:00Z') then raise exception 'Latest preview was not repaired'; end if;
  perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  begin
    perform public.delete_whatsapp_message_from_lumin(f.quote_message,f.chat);
    raise exception 'Unknown user deleted a message';
  exception when insufficient_privilege then null; end;
end; $$;
reset role;
-- Verify lack of page access and deactivated accounts, then Appointments fallback.
update public.user_profiles set role_id=f.restricted_role from wa_delete_fixture f where user_id=f.actor;
select set_config('request.jwt.claim.sub',actor::text,true) from wa_delete_fixture;
set local role authenticated;
do $$
declare f wa_delete_fixture;
begin
  select * into f from wa_delete_fixture;
  begin
    perform public.delete_whatsapp_message_from_lumin(f.quote_message,f.chat);
    raise exception 'Staff without WhatsApp access deleted a message';
  exception when insufficient_privilege then null; end;
end; $$;
reset role;
insert into public.role_permissions(role_id,page_key,can_view,can_modify)
  select restricted_role,'appointments',true,false from wa_delete_fixture;
update public.user_profiles set active=false from wa_delete_fixture f where user_id=f.actor;
set local role authenticated;
do $$
declare f wa_delete_fixture;
begin
  select * into f from wa_delete_fixture;
  begin
    perform public.delete_whatsapp_message_from_lumin(f.quote_message,f.chat);
    raise exception 'Inactive staff deleted a message';
  exception when insufficient_privilege then null; end;
end; $$;
reset role;
update public.user_profiles set active=true from wa_delete_fixture f where user_id=f.actor;
set local role authenticated;
do $$
declare f wa_delete_fixture;
begin
  select * into f from wa_delete_fixture;
  perform public.delete_whatsapp_message_from_lumin(f.quote_message,f.chat);
  if not exists(select 1 from public.whatsapp_conversations where id=f.chat and last_message='' and last_message_at is null and unread_count=0) then raise exception 'Empty chat preview was not cleared'; end if;
  if has_function_privilege('anon','public.delete_whatsapp_message_from_lumin(uuid,uuid)','execute') then raise exception 'Anonymous delete is exposed'; end if;
  if not has_function_privilege('authenticated','public.delete_whatsapp_message_from_lumin(uuid,uuid)','execute') then raise exception 'Staff delete is unavailable'; end if;
end; $$;
rollback;
