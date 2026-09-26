begin;
create function pg_temp.test_lumin_import(p_event jsonb) returns jsonb language sql as $$
  select public.receive_lumin_finance(encode(extensions.hmac(p_event::text,(select token_hash from private.lumin_import_config where id),'sha256'),'hex'),p_event);
$$;
do $$
declare
  config private.lumin_import_config; token text:='integration-test-only-token-never-used-for-production';
  account uuid; other_account uuid; response jsonb; event jsonb; entry uuid; manual_entry uuid;
  category_root uuid; category_child uuid; legacy_parent uuid; legacy_child uuid; legacy_parent_key text;
begin
  select * into config from private.lumin_import_config where id;
  if config is null then raise exception 'Configure the receiver before verification'; end if;
  update private.lumin_import_config set token_hash=encode(extensions.digest(token,'sha256'),'hex') where id;
  perform set_config('request.jwt.claim.sub',config.owner_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',config.owner_id,'role','authenticated')::text,true);
  insert into public.finance_categories(space_id,kind,name,name_ar,created_by)
    values(config.space_id,'income','Sync catalogue root fixture','تصنيف اختبار رئيسي',config.owner_id) returning id into category_root;
  insert into public.finance_categories(space_id,kind,parent_id,name,name_ar,created_by)
    values(config.space_id,'income',category_root,'Sync catalogue child fixture','تصنيف اختبار فرعي',config.owner_id) returning id into category_child;
  event:=jsonb_build_object('source_project',config.source_project,'version',900000020,'operation','catalog','payload','{}'::jsonb);
  response:=pg_temp.test_lumin_import(event);
  if not exists(select 1 from jsonb_array_elements(response->'catalog'->'categories') c where c->>'key'=category_child::text and c->>'parent_key'=category_root::text and c->>'name_ar'='تصنيف اختبار فرعي') then
    raise exception 'New subcategory hierarchy or Arabic label is absent from the catalogue';
  end if;
  select id,legacy_key into legacy_parent,legacy_parent_key from public.finance_categories where space_id=config.space_id and kind='income' and legacy_key is not null and archived_at is null and parent_id is null limit 1;
  if legacy_parent is not null then
    insert into public.finance_categories(space_id,kind,parent_id,name,name_ar,created_by)
      values(config.space_id,'income',legacy_parent_key,'Sync legacy-parent child fixture','اختبار التصنيف الأساسي',config.owner_id) returning id into legacy_child;
    response:=pg_temp.test_lumin_import(event);
    if not exists(select 1 from jsonb_array_elements(response->'catalog'->'categories') c where c->>'key'=legacy_child::text and c->>'parent_key'=legacy_parent_key) then
      raise exception 'A subcategory failed to resolve its legacy parent key';
    end if;
  end if;
  update public.finance_categories set name='Renamed catalogue child fixture' where id=category_child;
  response:=pg_temp.test_lumin_import(event);
  if not exists(select 1 from jsonb_array_elements(response->'catalog'->'categories') c where c->>'key'=category_child::text and c->>'name'='Renamed catalogue child fixture') then raise exception 'Category rename was not reflected'; end if;
  insert into public.finance_categories(space_id,kind,parent_id,name,name_ar,created_by,archived_at)
    values(config.space_id,'income',category_root,'Archived catalogue fixture','تصنيف مؤرشف للاختبار',config.owner_id,now()) returning id into category_child;
  response:=pg_temp.test_lumin_import(event);
  if exists(select 1 from jsonb_array_elements(response->'catalog'->'categories') c where c->>'key'=category_child::text) then raise exception 'Archived category remained available'; end if;
  if has_function_privilege('authenticated','private.lumin_finance_catalog(uuid)','execute') then raise exception 'Private catalogue is exposed'; end if;
  select id into account from public.accounts where space_id=config.space_id and name='Cash wallet';
  select id into other_account from public.accounts where space_id<>config.space_id limit 1;
  event:=jsonb_build_object('source_project',config.source_project,'version',900000001,'source_key','income:900000001','operation','upsert',
    'payload',jsonb_build_object('kind','income','amount_minor',12345,'account_id',account,'occurred_at',now(),'note','Rollback verification fixture'));
  response:=pg_temp.test_lumin_import(event);
  select id into entry from public.ledger_entries where external_source='lumin' and external_source_key='income:900000001';
  if entry is null or (select amount_minor from public.ledger_entries where id=entry)<>12345 then raise exception 'Receiver did not insert exact amount'; end if;
  perform set_config('request.jwt.claim.sub',config.owner_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',config.owner_id,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  begin
    update public.ledger_entries set amount_minor=99999 where id=entry;
    raise exception 'Imported entry was edited outside Lumin';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.ledger_entries where id=entry;
    raise exception 'Imported entry was deleted outside Lumin';
  exception when insufficient_privilege then null; end;
  insert into public.ledger_entries(space_id,account_id,kind,amount_minor,note,occurred_at)
  values(config.space_id,account,'income',100,'Manual rollback fixture',now()) returning id into manual_entry;
  execute 'reset role';
  execute 'set local role service_role';
  begin
    update public.ledger_entries set external_source='lumin',external_source_key='income:900000009' where id=manual_entry;
    raise exception 'Manual entry acquired a forged Lumin source tag';
  exception when insufficient_privilege then null; end;
  execute 'reset role';
  response:=pg_temp.test_lumin_import(event);
  if response->>'duplicate'<>'true' or (select count(*) from public.ledger_entries where external_source_key='income:900000001')<>1 then raise exception 'Repeated delivery created a duplicate'; end if;
  event:=jsonb_set(jsonb_set(event,'{version}','900000002'),'{payload,amount_minor}','25000');
  perform pg_temp.test_lumin_import(event);
  if (select amount_minor from public.ledger_entries where id=entry)<>25000 then raise exception 'Correction failed'; end if;
  event:=jsonb_set(event,'{version}','900000001');
  perform pg_temp.test_lumin_import(event);
  if (select amount_minor from public.ledger_entries where id=entry)<>25000 then raise exception 'Stale delivery overwrote a newer correction'; end if;
  begin
    perform public.receive_lumin_finance('not-a-valid-integration-token-123456789',event);
    raise exception 'Invalid authentication unexpectedly accepted';
  exception when invalid_authorization_specification then null; end;
  if other_account is not null then
    begin
      perform pg_temp.test_lumin_import(jsonb_set(jsonb_set(event,'{version}','900000003'),'{payload,account_id}',to_jsonb(other_account)));
      raise exception 'Cross-space account unexpectedly accepted';
    exception when raise_exception then
      if sqlerrm='Cross-space account unexpectedly accepted' then raise; end if;
    end;
  end if;
  event:=jsonb_set(jsonb_set(event,'{version}','900000004'),'{operation}','"delete"');
  perform pg_temp.test_lumin_import(event);
  if exists(select 1 from public.ledger_entries where id=entry) then raise exception 'Deletion did not reverse the ledger entry'; end if;
  event:=jsonb_set(jsonb_set(event,'{version}','900000003'),'{operation}','"upsert"');
  perform pg_temp.test_lumin_import(event);
  if exists(select 1 from public.ledger_entries where external_source_key='income:900000001') then raise exception 'Stale event resurrected a deleted entry'; end if;
  event:=jsonb_build_object('source_project',config.source_project,'version',900000010,
    'source_key','expense:00000000-0000-4000-8000-000000000001','operation','upsert',
    'payload',jsonb_build_object('kind','expense','amount_minor',6789,'account_id',account,'occurred_at',now(),'note','Rollback expense fixture'));
  perform pg_temp.test_lumin_import(event);
  if not exists(select 1 from public.ledger_entries where external_source_key=event->>'source_key' and kind='expense' and amount_minor=-6789) then
    raise exception 'Expense payment did not reduce the destination account by the exact amount';
  end if;
  if has_function_privilege('authenticated','public.receive_lumin_finance(text,jsonb)','execute') or has_function_privilege('anon','public.receive_lumin_finance(text,jsonb)','execute') then raise exception 'Import function is publicly callable'; end if;
end; $$;
rollback;
select 'Receiver checks passed; fixtures rolled back.' as result;
