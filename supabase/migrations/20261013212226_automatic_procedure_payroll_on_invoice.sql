-- Completed invoiced procedures enter the existing salary ledger automatically.
-- Settlement remains an explicit HR payment; paid allocations are never rewritten.
create or replace function private.sync_procedure_salary_transfer(p_item_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare
  item public.patient_invoice_items;
  invoice public.patient_invoices;
  finding jsonb;
  allocations jsonb;
  doctor_id uuid;
  mode text;
begin
  -- Serialize with the existing salary-payment guard before checking expenses.
  select * into item from public.patient_invoice_items where id=p_item_id for update;
  if item is null or item.operation_code='diagnosis_fee' or item.finding_id is null
    or item.operation_status<>'C' or item.unit_price*item.quantity<=0 then return; end if;
  select * into invoice from public.patient_invoices where id=item.invoice_id;
  if invoice is null or invoice.status='cancelled' then return; end if;
  if exists(select 1 from private.doctor_salary_linked_expenses(item.id)) then return; end if;
  select private.chart_finding_by_id(patient.chart_state,item.finding_id) into finding
    from public.patients patient where patient.id=invoice.patient_id;
  if not private.doctor_salary_assignment_is_complete(finding) then return; end if;
  doctor_id:=nullif(btrim(coalesce(finding->>'doctorId',finding->>'doctor_id','')),'')::uuid;
  if doctor_id is not null then
    mode:='whole';
    allocations:=jsonb_build_array(jsonb_build_object('finding_id',item.finding_id,
      'doctor_id',doctor_id,'percentage',100,'step_name',null));
  else
    mode:='steps';
    select jsonb_agg(jsonb_build_object(
      'finding_id',coalesce(step.value->>'payrollFindingId',step.value->>'payroll_finding_id'),
      'doctor_id',coalesce(step.value->>'doctorId',step.value->>'doctor_id'),
      'percentage',(step.value->>'percentage')::numeric,'step_name',step.value->>'name') order by step.ordinality)
      into allocations from jsonb_array_elements(finding->'steps') with ordinality as step(value,ordinality);
  end if;
  insert into private.hr_doctor_salary_transfers as transfer
    (finding_id,invoice_item_id,doctor_id,assignment_mode,allocations,assignment_signature,transferred_by)
  values(item.finding_id,item.id,doctor_id,mode,allocations,
    private.doctor_salary_assignment_signature(finding),coalesce(auth.uid(),invoice.created_by))
  on conflict(finding_id) do update set invoice_item_id=excluded.invoice_item_id,
    doctor_id=excluded.doctor_id,assignment_mode=excluded.assignment_mode,
    allocations=excluded.allocations,assignment_signature=excluded.assignment_signature,
    transferred_at=now(),transferred_by=excluded.transferred_by
  where transfer.invoice_item_id is distinct from excluded.invoice_item_id
    or transfer.doctor_id is distinct from excluded.doctor_id
    or transfer.assignment_mode is distinct from excluded.assignment_mode
    or transfer.allocations is distinct from excluded.allocations
    or transfer.assignment_signature is distinct from excluded.assignment_signature;
end;
$$;

create or replace function private.auto_transfer_procedure_salary()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_item_id bigint; v_item_ids bigint[];
begin
  if tg_table_name='patient_invoice_items' then
    perform private.sync_procedure_salary_transfer(new.id); return new;
  elsif tg_table_name='patients' then
    select array_agg(item.id order by item.id) into v_item_ids
    from public.patient_invoice_items item join public.patient_invoices invoice on invoice.id=item.invoice_id
    where invoice.patient_id=new.id and item.operation_code<>'diagnosis_fee';
  elsif tg_table_name='patient_invoices' then
    select array_agg(item.id order by item.id) into v_item_ids from public.patient_invoice_items item
    where item.invoice_id=new.id and item.operation_code<>'diagnosis_fee';
  elsif tg_table_name='user_profiles' then
    select array_agg(item.id order by item.id) into v_item_ids
    from public.patient_invoice_items item join public.patient_invoices invoice on invoice.id=item.invoice_id
    join public.patients patient on patient.id=invoice.patient_id
    cross join lateral(select private.chart_finding_by_id(patient.chart_state,item.finding_id) value) finding
    where item.operation_code<>'diagnosis_fee' and (coalesce(finding.value->>'doctorId',finding.value->>'doctor_id')=new.user_id::text
      or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(finding.value->'steps')='array'
        then finding.value->'steps' else '[]'::jsonb end) step(value)
        where coalesce(step.value->>'doctorId',step.value->>'doctor_id')=new.user_id::text));
  end if;
  foreach v_item_id in array coalesce(v_item_ids,'{}'::bigint[]) loop
    perform private.sync_procedure_salary_transfer(v_item_id);
  end loop;
  return new;
end;
$$;
revoke all on function private.sync_procedure_salary_transfer(bigint) from public,anon,authenticated;
revoke all on function private.auto_transfer_procedure_salary() from public,anon,authenticated;

create trigger auto_transfer_procedure_salary_item
after insert or update of invoice_id,finding_id,operation_code,operation_status,unit_price,quantity,doctor_id
on public.patient_invoice_items for each row when(new.operation_code<>'diagnosis_fee')
execute function private.auto_transfer_procedure_salary();

-- Run after the existing chart-to-invoice status synchronization trigger.
create trigger zz_auto_transfer_procedure_salary_chart
after update of chart_state on public.patients for each row when(old.chart_state is distinct from new.chart_state)
execute function private.auto_transfer_procedure_salary();

create trigger auto_transfer_procedure_salary_invoice
after update of status,patient_id on public.patient_invoices for each row
when(new.status<>'cancelled' and (old.status is distinct from new.status or old.patient_id is distinct from new.patient_id))
execute function private.auto_transfer_procedure_salary();

create trigger auto_transfer_procedure_salary_doctor
after update of active,is_doctor on public.user_profiles for each row
when(new.active and new.is_doctor and (old.active is distinct from new.active or old.is_doctor is distinct from new.is_doctor))
execute function private.auto_transfer_procedure_salary();

-- Future invoice and chart events drive inclusion. Historical records are not backfilled.

-- Retain the existing RPC argument for cached clients; its filter now means awaiting payment.
create or replace function private.build_clinic_doctor_day_payroll(p_day date,p_user_id uuid,p_page integer,p_page_size integer,p_untransferred_only boolean)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_doctor uuid; result jsonb;
begin
  if auth.uid() is null or not private.has_hr_access() then raise exception 'HR access is required.' using errcode='42501'; end if;
  if p_day is null then raise exception 'Choose a completion date.' using errcode='22023'; end if;
  select user_id into v_doctor from public.user_profiles where active and is_doctor and (p_user_id is null or user_id=p_user_id)
    order by full_name,user_id limit 1;
  if p_user_id is not null and v_doctor is null then raise exception 'Active doctor not found.' using errcode='22023'; end if;
  with lines as materialized (select * from private.clinic_doctor_invoice_lines(p_day,p_day,v_doctor) where v_doctor is not null),
  filtered as (select * from lines where not p_untransferred_only or (transferred and payment_id is null)),
  page as (select * from filtered order by completed_at desc,invoice_id,invoice_item_id,finding_id
    limit least(greatest(coalesce(p_page_size,20),1),50) offset (greatest(coalesce(p_page,1),1)-1)*least(greatest(coalesce(p_page_size,20),1),50))
  select jsonb_build_object('doctor_id',v_doctor,'day',p_day,
    'doctors',coalesce((select jsonb_agg(jsonb_build_object('id',user_id,'name',full_name) order by full_name,user_id) from public.user_profiles where active and is_doctor),'[]'::jsonb),
    'rows',coalesce((select jsonb_agg(to_jsonb(page) order by completed_at desc,invoice_id,invoice_item_id,finding_id) from page),'[]'::jsonb),
    'total_count',(select count(*) from filtered),'invoice_count',(select count(distinct invoice_id) from lines),
    'ready_amount',coalesce((select sum(doctor_amount) from lines where transferred and payment_id is null),0),
    'ready_count',(select count(*) from lines where transferred and payment_id is null),
    'untransferred_amount',coalesce((select sum(doctor_amount) from lines where not transferred and payment_id is null),0)) into result;
  return result;
end;
$$;

-- The action center now reviews automatically included payroll awaiting HR payment.
create or replace function private.build_clinic_management_overview(p_start_date date,p_end_date date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_finance jsonb; v_hr jsonb; v_debts jsonb; v_zone text; v_today date;
begin
  if auth.uid() is null or not (private.has_finances_access() or private.has_analytics_access() or private.has_hr_access()) then
    raise exception 'Clinic management access is required.' using errcode='42501';
  end if;
  if p_start_date is null or p_end_date is null or p_end_date<p_start_date or p_end_date>p_start_date+365 then
    raise exception 'Choose a valid date range of up to 366 days.' using errcode='22023';
  end if;
  select coalesce(nullif(btrim(attendance_timezone),''),'Africa/Cairo') into v_zone from public.clinic_settings where id=1;
  v_zone:=coalesce(v_zone,'Africa/Cairo'); v_today:=(now() at time zone v_zone)::date;
  if private.has_finances_access() or private.has_analytics_access() then
    with dates as (select value::date as day from generate_series(p_start_date::timestamp,p_end_date::timestamp,interval '1 day') as dates(value)),
    income as (select payment_date as day,sum(amount) amount from public.invoice_payments where payment_date between p_start_date and p_end_date group by 1),
    expense_parts as materialized (
      select entry.payment_date as day,entry.amount,expense.expense_type_id,false legacy
      from public.expense_payment_entries entry join public.expenses expense on expense.id=entry.expense_id
      where entry.payment_date between p_start_date and p_end_date and entry.amount>0
      union all
      select expense.expense_date,greatest(expense.paid_amount-coalesce((select sum(amount) from public.expense_payment_entries where expense_id=expense.id),0),0),expense.expense_type_id,true
      from public.expenses expense where expense.expense_date between p_start_date and p_end_date and expense.paid_amount>0
    ), paid as (select day,sum(amount) amount from expense_parts group by 1),
    series as (select dates.day,coalesce(income.amount,0) income,coalesce(paid.amount,0) expense from dates left join income using(day) left join paid using(day)),
    categories as (select coalesce(type.name,'Uncategorized') name,sum(part.amount) amount from expense_parts part
      left join public.expense_types type on type.id=part.expense_type_id where part.amount>0 group by 1)
    select jsonb_build_object('income_total',coalesce(sum(income),0),'expense_total',coalesce(sum(expense),0),'net_total',coalesce(sum(income-expense),0),
      'legacy_expense_total',coalesce((select sum(amount) from expense_parts where legacy),0),
      'days',coalesce(jsonb_agg(to_jsonb(series) order by day),'[]'::jsonb),
      'expense_types',coalesce((select jsonb_agg(to_jsonb(categories) order by amount desc,name) from categories),'[]'::jsonb),
      'unpaid_expense_count',case when private.has_finances_access() then (select count(*) from public.expenses where total>coalesce(paid_amount,case when paid then total else 0 end,0)) else null end,
      'unpaid_expense_total',case when private.has_finances_access() then (select coalesce(sum(greatest(total-coalesce(paid_amount,case when paid then total else 0 end,0),0)),0) from public.expenses) else null end
    ) into v_finance from series;
    if private.has_finances_access() and (private.is_admin() or private.has_page_permission('finance_depts')) then
      v_debts:=public.get_finance_debt_page(p_page=>1,p_page_size=>10);
      v_finance:=v_finance||jsonb_build_object('debt_total',v_debts->'remaining_total','debt_patient_count',v_debts->'total_count');
    end if;
  end if;
  if private.has_hr_access() then
    with pending as materialized (
      select line.* from private.clinic_doctor_invoice_lines('1900-01-01',v_today,null) line
      where line.transferred and line.payment_id is null
    ),
    preview as (select invoice_id,invoice_item_id,patient_id,patient_name,doctor_id,doctor_name,operation_name,doctor_amount,
      (completed_at at time zone v_zone)::date as day from pending order by completed_at,invoice_item_id limit 10)
    select jsonb_build_object('payroll_invoice_count',(select count(distinct invoice_id) from pending),
      'payroll_doctor_count',(select count(distinct doctor_id) from pending),
      'payroll_amount',coalesce((select sum(doctor_amount) from pending),0),
      'payroll_preview',coalesce((select jsonb_agg(to_jsonb(preview)) from preview),'[]'::jsonb)) into v_hr;
  end if;
  return jsonb_build_object('start_date',p_start_date,'end_date',p_end_date,'today',v_today,'finance',v_finance,'hr',v_hr);
end;
$$;
