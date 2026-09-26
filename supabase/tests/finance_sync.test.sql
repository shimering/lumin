-- Safe against the configured database: every fixture and queued HTTP request is rolled back.
begin;
do $$
declare
  expense uuid; cash uuid; bank uuid; card uuid; actor uuid; settings public.finance_sync_settings;
  entry uuid; count_before bigint; v_amount numeric; last_event public.finance_sync_events;
  admin_data jsonb; v_invoice bigint; v_patient uuid; v_payment bigint; historical bigint;
begin
  select p.user_id into actor from public.user_profiles p join public.access_roles r on r.id=p.role_id where p.active and r.is_admin limit 1;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
  select id into cash from public.payment_methods where lower(name)='cash';
  select id into bank from public.payment_methods where lower(name)='instapay';
  select id into card from public.payment_methods where lower(name)='card';
  select * into settings from public.finance_sync_settings where id;
  admin_data:=public.get_finance_sync_admin();
  if admin_data->>'connected'<>'true' or jsonb_array_length(admin_data->'settings'->'accounts')<2 then raise exception 'Admin connection summary is incomplete'; end if;
  perform public.save_finance_sync_settings(false,true,true,settings.payment_routes,settings.income_category,settings.expense_categories);
  if settings.payment_routes->>cash::text is null or settings.payment_routes->>bank::text is null or settings.payment_routes->>card::text is not null then
    raise exception 'Cash/InstaPay/Card routing defaults are incorrect';
  end if;
  perform private.queue_finance_sync_at('income:900000101','income',cash,1,'2026-09-26','Time verification',settings.income_category,false,'2026-09-26T16:09:35.483948Z');
  select e.* into last_event from public.finance_sync_events e order by id desc limit 1;
  if (last_event.payload->>'occurred_at')::timestamptz<>'2026-09-26T16:09:35.483948Z'::timestamptz then
    raise exception 'A current payment lost its actual entry time';
  end if;
  perform private.queue_finance_sync_at('income:900000102','income',cash,1,'2026-01-10','Backdated time verification',settings.income_category,false,'2026-09-26T16:09:35.483948Z');
  select e.* into last_event from public.finance_sync_events e order by id desc limit 1;
  if (last_event.payload->>'occurred_at')::timestamptz<>'2026-01-10T17:09:35.483948Z'::timestamptz then
    raise exception 'A backdated payment lost its Cairo date/time across daylight saving';
  end if;
  select count(*) into count_before from public.finance_sync_events;
  select p.id into historical from public.invoice_payments p where not exists(select 1 from public.finance_sync_events e where e.source_key='income:'||p.id) limit 1;
  if historical is not null then
    update public.invoice_payments set payment_method_name=payment_method_name where id=historical;
    if (select count(*) from public.finance_sync_events)<>count_before then raise exception 'Historical payment was imported unexpectedly'; end if;
  end if;
  select invoice.id,invoice.patient_id into v_invoice,v_patient from public.patient_invoices invoice
    join public.patient_invoice_items item on item.invoice_id=invoice.id
    group by invoice.id having sum(item.unit_price*item.quantity)-invoice.paid_amount-coalesce(invoice.manual_discount_amount,0)-coalesce(invoice.loyalty_discount_amount,0)>100 limit 1;
  if v_invoice is not null then
    insert into public.invoice_payments(invoice_id,patient_id,payment_method_id,payment_method_name,amount,payment_date)
    values(v_invoice,v_patient,cash,'Cash',1,current_date) returning id into v_payment;
    select e.* into last_event from public.finance_sync_events e order by id desc limit 1;
    if last_event.source_key<>'income:'||v_payment or last_event.payload->>'account_id'<>settings.payment_routes->>cash::text then raise exception 'New income capture failed'; end if;
    if (last_event.payload->>'occurred_at')::timestamptz<>(select (p.payment_date+(p.created_at at time zone 'Africa/Cairo')::time) at time zone 'Africa/Cairo' from public.invoice_payments p where p.id=v_payment) then
      raise exception 'Income capture did not preserve the original receipt time';
    end if;
    update public.finance_sync_settings set sync_income=false where id;
    update public.invoice_payments set amount=2 where id=v_payment;
    select e.* into last_event from public.finance_sync_events e order by id desc limit 1;
    if last_event.operation<>'upsert' or (last_event.payload->>'amount_minor')::bigint<>200 then raise exception 'Disabling new income imports lost an existing correction'; end if;
    delete from public.invoice_payments where id=v_payment;
    select e.* into last_event from public.finance_sync_events e order by id desc limit 1;
    if last_event.operation<>'delete' then raise exception 'Income deletion was not captured'; end if;
    update public.finance_sync_settings set sync_income=true where id;
  end if;
  select count(*) into count_before from public.finance_sync_events;
  insert into public.expenses(name,expense_type_id,total,paid_amount,quantity,expense_date,description,confirmed,sync_payment_method_id)
  values('Sync verification fixture',(select id from public.expense_types where active limit 1),1000,0,1,current_date,'',true,cash) returning id into expense;
  if (select count(*) from public.finance_sync_events)<>count_before then raise exception 'Unpaid expense should not sync'; end if;
  perform public.record_expense_payment(expense,100,cash,current_date);
  perform public.record_expense_payment(expense,250,bank,current_date);
  if (select count(*) from public.expense_payment_entries where expense_id=expense)<>2 then raise exception 'Installments must remain distinct'; end if;
  select e.* into last_event from public.finance_sync_events e order by id desc limit 1;
  if last_event.payload->>'account_id'<>settings.payment_routes->>bank::text or (last_event.payload->>'amount_minor')::bigint<>25000 then raise exception 'InstaPay amount/account incorrect'; end if;
  if (last_event.payload->>'occurred_at')::timestamptz<>(select (p.payment_date+(p.created_at at time zone 'Africa/Cairo')::time) at time zone 'Africa/Cairo' from public.expense_payment_entries p where p.expense_id=expense and p.payment_method_id=bank) then
    raise exception 'Expense capture did not preserve the original installment time';
  end if;
  perform public.record_expense_payment(expense,50,card,current_date);
  select e.* into last_event from public.finance_sync_events e order by id desc limit 1;
  if last_event.status<>'skipped' then raise exception 'Card must remain excluded'; end if;
  update public.expenses set paid_amount=200 where id=expense;
  if (select sum(amount) from public.expense_payment_entries where expense_id=expense)<>200 then raise exception 'Paid amount corrections must reconcile installments'; end if;
  if (select amount from public.expense_payment_entries where expense_id=expense and payment_method_id=cash)<>100 then raise exception 'Earlier cash payment should retain its amount'; end if;
  select amount into v_amount from public.expense_payment_entries where expense_id=expense and payment_method_id=bank;
  if v_amount<>100 then raise exception 'Most recent included installment should be reduced'; end if;
  begin
    perform public.record_expense_payment(expense,10000,cash,current_date);
    raise exception 'Overpayment unexpectedly accepted';
  exception when raise_exception then
    if sqlerrm='Overpayment unexpectedly accepted' then raise; end if;
  end;
  update public.expenses set paid_amount=250,sync_payment_method_id=null where id=expense;
  select id into entry from public.expense_payment_entries where expense_id=expense and payment_method_id is null limit 1;
  select e.* into last_event from public.finance_sync_events e order by id desc limit 1;
  if last_event.status<>'needs_method' then raise exception 'Unspecified salary payment method must need review'; end if;
  perform public.assign_expense_sync_method(entry,cash);
  -- A later payment without a method must stop needing review when corrected to zero.
  update public.expenses set paid_amount=300,sync_payment_method_id=null where id=expense;
  update public.expenses set paid_amount=250 where id=expense;
  if exists(select 1 from public.finance_sync_events e join public.expense_payment_entries p
    on e.source_key='expense:'||p.id where p.expense_id=expense and p.amount=0 and e.status='needs_method') then
    raise exception 'A zeroed payment still needs a method';
  end if;
  -- Deleting an unresolved payment must also clear its review item.
  update public.expenses set paid_amount=300,sync_payment_method_id=null where id=expense;
  delete from public.expenses where id=expense;
  if exists(select 1 from public.expense_payment_entries where expense_id=expense) then raise exception 'Deleted expense left payment records'; end if;
  if not exists(select 1 from public.finance_sync_events where source_key='expense:'||entry and operation='delete') then raise exception 'Deletion must remove synced expense'; end if;
  if exists(select 1 from public.finance_sync_events where payload->>'note' like '%Sync verification fixture%' and status='needs_method') then
    raise exception 'A deleted payment still needs a method';
  end if;
  if has_function_privilege('authenticated','public.configure_baytna_sync(text,jsonb,jsonb)','execute') or
     has_function_privilege('authenticated','private.dispatch_baytna_sync()','execute') or
     has_function_privilege('authenticated','private.queue_finance_sync_at(text,text,uuid,numeric,date,text,text,boolean,timestamptz)','execute') then raise exception 'Privileged integration functions are exposed'; end if;
  -- Refresh categories automatically while financial delivery is paused, without duplicate fetches.
  update public.finance_sync_events set status='synced' where operation='catalog' and status in ('pending','sending','failed');
  update public.finance_sync_settings set catalogue_refreshed_at=now()-interval '2 minutes' where id;
  select count(*) into count_before from public.finance_sync_events where operation='catalog';
  perform private.dispatch_baytna_sync();
  if (select count(*) from public.finance_sync_events where operation='catalog')<>count_before+1 then raise exception 'A stale category catalogue did not refresh automatically'; end if;
  perform private.dispatch_baytna_sync();
  if (select count(*) from public.finance_sync_events where operation='catalog')<>count_before+1 then raise exception 'Concurrent refreshes created duplicate catalogue requests'; end if;
  if exists(select 1 from net.http_request_queue where headers ? 'x-lumin-sync-token') then raise exception 'Reusable credential entered the HTTP queue'; end if;
  if not exists(select 1 from net.http_request_queue where headers ? 'x-lumin-sync-signature') then raise exception 'Outgoing event is not signed'; end if;
  if has_table_privilege('anon','vault.decrypted_secrets','select') or has_table_privilege('authenticated','vault.decrypted_secrets','select') then raise exception 'Signing key is exposed'; end if;
  perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
  perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}',true);
  begin
    perform public.get_finance_sync_admin();
    raise exception 'Non-admin unexpectedly accessed controls';
  exception when insufficient_privilege then null; end;
end; $$;
rollback;
select 'Source finance-sync checks passed; fixtures rolled back.' as result;
