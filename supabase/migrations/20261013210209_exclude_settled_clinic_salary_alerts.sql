-- Keep transfer alerts consistent with the invoice transfer guard. A salary expense
-- linked to any doctor allocation prevents this invoice item from being transferred.
-- This changes only the read-only overview; salary records and payment totals stay intact.
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
      where not line.transferred and line.payment_id is null
        and not exists (select 1 from private.doctor_salary_linked_expenses(line.invoice_item_id))
    ),
    preview as (select invoice_id,invoice_item_id,patient_id,patient_name,doctor_id,doctor_name,operation_name,doctor_amount,
      (completed_at at time zone v_zone)::date as day from pending order by completed_at,invoice_item_id limit 10)
    select jsonb_build_object('untransferred_invoice_count',(select count(distinct invoice_id) from pending),
      'untransferred_doctor_count',(select count(distinct doctor_id) from pending),
      'untransferred_amount',coalesce((select sum(doctor_amount) from pending),0),
      'untransferred_preview',coalesce((select jsonb_agg(to_jsonb(preview)) from preview),'[]'::jsonb)) into v_hr;
  end if;
  return jsonb_build_object('start_date',p_start_date,'end_date',p_end_date,'today',v_today,'finance',v_finance,'hr',v_hr);
end;
$$;
