create or replace function private.dispatch_baytna_sync()
returns void language plpgsql security definer set search_path='' as $$
declare event public.finance_sync_events; response net._http_response; connection private.baytna_sync_connection;
  token text; request bigint; decoded jsonb; enabled boolean;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('lumin-baytna-dispatch',0)) then return; end if;
  for event in select * from public.finance_sync_events where status='sending' order by id limit 100 for update skip locked loop
    select * into response from net._http_response where id=event.request_id;
    if response.id is not null then
      decoded:=null;
      begin decoded:=response.content::jsonb; exception when others then null; end;
      if response.status_code=200 and decoded->>'ok'='true' and decoded->>'version'=event.id::text then
        update public.finance_sync_events set status='synced',synced_at=now(),reason=null where id=event.id;
        if event.operation='catalog' then
          update public.finance_sync_settings set accounts=decoded->'catalog'->'accounts',categories=decoded->'catalog'->'categories',catalogue_refreshed_at=now() where id;
        end if;
      else
        update public.finance_sync_events set status='failed',reason=case when response.status_code=401 then 'Connection authentication failed.'
          when response.status_code=422 then 'Destination account, category, or event needs review.' else 'Destination unavailable; delivery will retry.' end,
          next_attempt_at=now()+make_interval(secs=>least(3600,30*power(2,least(attempts,7)))::integer) where id=event.id;
      end if;
    elsif event.sent_at<now()-interval '90 seconds' then
      update public.finance_sync_events set status='failed',reason='Delivery timed out; it is safe to retry.',next_attempt_at=now() where id=event.id;
    end if;
  end loop;
  select * into connection from private.baytna_sync_connection where id;
  if connection is null then return; end if;
  select decrypted_secret into token from vault.decrypted_secrets where id=connection.token_secret_id;
  select s.enabled into enabled from public.finance_sync_settings s where id;
  for event in select * from public.finance_sync_events where status in ('pending','failed') and next_attempt_at<=now() and attempts<12
    and (enabled or operation='catalog') order by id limit 25 for update skip locked loop
    request:=net.http_post(url:=connection.receiver_url,headers:=jsonb_build_object('Content-Type','application/json','x-lumin-sync-token',token),
      body:=jsonb_build_object('source_project','pqbayjkypzfxvnksgwwf','version',event.id,'source_key',event.source_key,'operation',event.operation,'payload',event.payload),timeout_milliseconds:=10000);
    update public.finance_sync_events set status='sending',request_id=request,sent_at=now(),attempts=attempts+1 where id=event.id;
  end loop;
end; $$;
