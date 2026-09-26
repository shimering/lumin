create or replace function public.configure_baytna_sync(p_token text,p_accounts jsonb,p_categories jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare secret_id uuid; cash_id text; bank_id text; v_income_category text; default_expense text;
begin
  if length(p_token)<32 then raise exception 'A dedicated integration token is required.'; end if;
  select vault.create_secret(p_token,'lumin_baytna_sync_token') into secret_id;
  insert into private.baytna_sync_connection(id,token_secret_id,receiver_url)
  values(true,secret_id,'https://wljaulrqgzputgayxyoi.supabase.co/functions/v1/lumin-finance-sync');
  select value->>'id' into cash_id from jsonb_array_elements(p_accounts) where value->>'name'='Cash wallet';
  select value->>'id' into bank_id from jsonb_array_elements(p_accounts) where value->>'name'='Main bank';
  select value->>'key' into v_income_category from jsonb_array_elements(p_categories) where value->>'kind'='income' and value->>'name'='Clinic salary';
  select value->>'key' into default_expense from jsonb_array_elements(p_categories) where value->>'kind'='expense' and value->>'name'='Clinic';
  update public.finance_sync_settings set accounts=p_accounts,categories=p_categories,income_category=v_income_category,
    expense_categories=jsonb_build_object('default',default_expense)||coalesce((select jsonb_object_agg(t.id::text,c.value->>'key') from public.expense_types t
      join jsonb_array_elements(p_categories) c on lower(c.value->>'name')=lower(t.name) and c.value->>'kind'='expense'),'{}'),
    payment_routes=coalesce((select jsonb_object_agg(id::text,case when lower(name)='cash' then cash_id when lower(replace(name,' ',''))='instapay' then bank_id else null end) from public.payment_methods),'{}') where id;
  insert into public.finance_sync_events(source_key,operation,status) values('catalog','catalog','pending');
  perform private.dispatch_baytna_sync();
end; $$;
