-- Isolated smoke test against the deployed schema. Every test record and event rolls back.
begin;
select set_config('request.jwt.claim.sub',(select u.user_id::text from public.user_profiles u join public.access_roles r on r.id=u.role_id where u.active and r.is_admin limit 1),true);
set local role authenticated;
do $$
declare v_category uuid;v_item uuid;v_revision bigint;v_request uuid:=gen_random_uuid();v_min_request uuid:=gen_random_uuid();v_report jsonb;v_payload jsonb;v_result jsonb;v_history jsonb;
begin
  if auth.uid() is null then raise exception 'An active administrator is required to run this rolled-back test';end if;
  v_report:=public.get_inventory();
  select (value->>'id')::uuid into v_category from jsonb_array_elements(v_report->'categories') where value->>'key'='anaesthesia';
  v_result:=public.inventory_write('item_save',jsonb_build_object('name','Inventory smoke '||gen_random_uuid(),'category_id',v_category,'quantity',2,'minimum',3,'unit','Box'),gen_random_uuid());
  v_item:=(v_result->>'id')::uuid;
  v_report:=public.get_inventory(jsonb_build_object('id',v_item));
  v_revision:=(v_report#>>'{items,0,revision}')::bigint;
  v_payload:=jsonb_build_object('id',v_item,'revision',v_revision,'quantity',2);
  perform public.inventory_write('receive',v_payload,v_request);
  perform public.inventory_write('receive',v_payload,v_request);
  if (public.get_inventory(jsonb_build_object('id',v_item))#>>'{items,0,quantity}')::numeric<>4 then raise exception 'Receipt retry duplicated stock';end if;
  begin perform public.inventory_write('use',v_payload,gen_random_uuid());raise exception 'Stale revision was accepted';exception when serialization_failure then null;end;
  v_history:=public.get_inventory_movements(jsonb_build_object('item_id',v_item));
  if (v_history->>'total')::integer<>2 then raise exception 'Unexpected movement history';end if;
  v_report:=public.get_inventory(jsonb_build_object('id',v_item));
  v_payload:=(v_report#>'{items,0}')||jsonb_build_object('minimum',4);
  perform public.inventory_write('item_save',v_payload,v_min_request);
  perform public.inventory_write('item_save',v_payload,v_min_request);
  v_report:=public.get_inventory(jsonb_build_object('id',v_item));
  if (v_report#>>'{items,0,minimum}')::numeric<>4 or (v_report#>>'{items,0,quantity}')::numeric<>4 then raise exception 'Minimum retry changed stock or repeated the threshold';end if;
  if (public.get_inventory_movements(jsonb_build_object('item_id',v_item))->>'total')::integer<>2 then raise exception 'Minimum created a stock movement';end if;
  if exists(select 1 from information_schema.columns where table_schema='public' and table_name='inventory_items'
    and column_name in ('sku','location','supplier','notes','review_note','source_data','active')) then raise exception 'Retired item columns remain';end if;
  if has_table_privilege('authenticated','public.inventory_items','UPDATE') or has_table_privilege('authenticated','public.inventory_movements','DELETE')
    or has_function_privilege('anon','public.inventory_write(text,jsonb,uuid)','EXECUTE') then raise exception 'Direct ledger access exposed';end if;
  perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  begin perform public.get_inventory();raise exception 'Unknown staff accepted';exception when insufficient_privilege then null;end;
end $$;
rollback;
