
-- This private projection also includes completed, invoiced cases awaiting transfer.
-- Allocation rounding and compensation rules mirror the existing payroll projection;
-- settlement still runs exclusively through hr_pay_doctor_procedures_with_method.
create or replace function private.clinic_doctor_invoice_lines(p_start_date date, p_end_date date, p_user_id uuid default null)
returns table(invoice_id bigint, invoice_item_id bigint, patient_id uuid, patient_name text,
  doctor_id uuid, doctor_name text, finding_id uuid, operation_name text, tooth text,
  invoice_amount numeric, doctor_amount numeric, transferred boolean, payment_id uuid, completed_at timestamptz)
language sql stable set search_path = '' as $$
  with parameters as (
    select p_start_date range_start, p_end_date + 1 range_end,
      coalesce((select nullif(btrim(attendance_timezone),'') from public.clinic_settings where id=1),'Africa/Cairo') time_zone
  ), source_allocations as (
    select item.invoice_id, item.id invoice_item_id, item.finding_id parent_finding_id,
      allocation.finding_id, allocation.doctor_id, allocation.percentage, allocation.step_name,
      patient.id patient_id, patient.name::text patient_name,
      private.try_parse_timestamptz(coalesce(finding.value->>'completedAt',finding.value->>'completed_at',finding.value->>'createdAt',finding.value->>'created_at')) completed_at,
      item.operation_id, item.operation_code, round(item.unit_price*item.quantity,2) invoice_amount,
      item.quantity invoice_quantity,
      coalesce(finding.value->>'tooth',finding.value->>'toothId',finding.value->>'tooth_id','') tooth,
      coalesce(transfer.invoice_item_id=item.id and transfer.assignment_signature=private.doctor_salary_assignment_signature(finding.value)
        and exists(select 1 from jsonb_to_recordset(transfer.allocations) as a(finding_id uuid,doctor_id uuid,percentage numeric)
          where a.finding_id=allocation.finding_id and a.doctor_id=allocation.doctor_id and a.percentage=allocation.percentage),false) transferred
    from public.patient_invoice_items item
    join public.patient_invoices invoice on invoice.id=item.invoice_id and invoice.status<>'cancelled'
    join public.patients patient on patient.id=invoice.patient_id
    cross join lateral (select private.chart_finding_by_id(patient.chart_state,item.finding_id) value) finding
    cross join lateral jsonb_to_recordset(case when private.doctor_salary_assignment_is_complete(finding.value) then
      case when nullif(coalesce(finding.value->>'doctorId',finding.value->>'doctor_id'),'') is not null then
        jsonb_build_array(jsonb_build_object('finding_id',item.finding_id,'doctor_id',coalesce(finding.value->>'doctorId',finding.value->>'doctor_id'),'percentage',100))
      else coalesce((select jsonb_agg(jsonb_build_object('finding_id',coalesce(s.value->>'payrollFindingId',s.value->>'payroll_finding_id'),
        'doctor_id',coalesce(s.value->>'doctorId',s.value->>'doctor_id'),'percentage',(s.value->>'percentage')::numeric,'step_name',s.value->>'name'))
        from jsonb_array_elements(finding.value->'steps') s(value)),'[]'::jsonb) end else '[]'::jsonb end)
      as allocation(finding_id uuid,doctor_id uuid,percentage numeric,step_name text)
    left join private.hr_doctor_salary_transfers transfer on transfer.finding_id=item.finding_id
    where item.operation_status='C' and item.operation_code<>'diagnosis_fee' and item.unit_price*item.quantity>0
    union all
    select item.invoice_id,item.id,item.finding_id,item.finding_id,item.doctor_id,100::numeric,null::text,
      patient.id,patient.name::text,appointment.appointment_at,coalesce(item.operation_id,operation.id),item.operation_code,
      round(item.unit_price*item.quantity,2),item.quantity,''::text,
      coalesce(transfer.invoice_item_id=item.id and transfer.doctor_id=item.doctor_id and transfer.assignment_mode='whole'
        and transfer.assignment_signature=jsonb_build_object('doctor_id',item.doctor_id::text,'appointment_id',item.appointment_id::text),false)
    from public.patient_invoice_items item
    join public.patient_invoices invoice on invoice.id=item.invoice_id and invoice.status<>'cancelled'
    join public.patients patient on patient.id=invoice.patient_id
    join public.appointments appointment on appointment.id=item.appointment_id and appointment.patient_id=patient.id and appointment.status='Completed'
    join public.dental_operations operation on operation.code='dz_diagnosis_a1'
    left join private.hr_doctor_salary_transfers transfer on transfer.finding_id=item.finding_id
    where item.operation_code='diagnosis_fee' and item.operation_status='C' and item.appointment_id=item.finding_id and item.unit_price*item.quantity>0
  ),
  rounded_shares as (
    select source_allocations.*,
      row_number() over (partition by invoice_item_id order by finding_id) as allocation_number,
      count(*) over (partition by invoice_item_id) as allocation_count,
      round(invoice_amount * percentage / 100, 2) as rounded_amount
    from source_allocations
  ),
  valued as (
    select rounded_shares.*,
      case when allocation_number = allocation_count then
        invoice_amount - coalesce(sum(rounded_amount) over (
          partition by invoice_item_id order by finding_id
          rows between unbounded preceding and 1 preceding), 0)
      else rounded_amount end as allocated_amount,
      round(invoice_quantity * percentage / 100, 4) as allocated_quantity
    from rounded_shares
  ),
  compensated as (
    select valued.*,
      profile.full_name as doctor_name,
      case when valued.operation_code = 'diagnosis_fee' then 'Diagnosis fee'
        else operation.name end as catalog_operation_name,
      case when rule.value->>'type' = 'fixed' then 'fixed' else 'percentage' end as compensation_type,
      case when coalesce(rule.value->>'amount', rule.value->>'value', '') ~ '^[0-9]+([.][0-9]+)?$'
        then round(coalesce(rule.value->>'amount', rule.value->>'value')::numeric, 2)
        else 0 end as compensation_rate
    from valued
    join public.user_profiles as profile on profile.user_id = valued.doctor_id
      and profile.active and profile.is_doctor
    join public.dental_operations as operation on operation.id = valued.operation_id
    join public.hr_staff_settings as staff on staff.user_id = valued.doctor_id
    cross join lateral (
      select candidate.value
      from (
        select specific.value, 0 as priority, specific.position
        from jsonb_array_elements(case
          when jsonb_typeof(staff.weekly_schedule #> '{doctorCompensation,rules}') = 'array'
            then staff.weekly_schedule #> '{doctorCompensation,rules}'
          else '[]'::jsonb end) with ordinality as specific(value, position)
        where coalesce(specific.value->>'procedureId', specific.value->>'procedure_id') = operation.id::text
        union all
        select universal.value, 1, 1::bigint
        from (select case
          when jsonb_typeof(staff.weekly_schedule #> '{doctorCompensation,universal}') = 'object'
            then staff.weekly_schedule #> '{doctorCompensation,universal}'
          when jsonb_typeof(staff.weekly_schedule #> '{doctorCompensation,fallback}') = 'object'
            then staff.weekly_schedule #> '{doctorCompensation,fallback}'
          else '{}'::jsonb end as value) as universal
        where universal.value->>'enabled' = 'true'
      ) as candidate
      order by candidate.priority, candidate.position
      limit 1
    ) as rule
    where (p_user_id is null or valued.doctor_id = p_user_id)
      and valued.allocated_amount > 0
      and valued.allocated_quantity > 0
  )

  select c.invoice_id,c.invoice_item_id,c.patient_id,c.patient_name,c.doctor_id,c.doctor_name,c.finding_id,
    case when nullif(btrim(c.step_name),'') is null then c.catalog_operation_name else c.catalog_operation_name || ' · ' || c.step_name end,
    c.tooth,c.invoice_amount,
    coalesce(paid.salary_amount,round(case when c.compensation_type='fixed' then c.compensation_rate*c.allocated_quantity else c.allocated_amount*c.compensation_rate/100 end,2)),
    c.transferred,paid.payment_id,c.completed_at
  from compensated c cross join parameters
  left join private.hr_doctor_salary_payment_items paid on paid.finding_id=c.finding_id and paid.doctor_id=c.doctor_id
  where c.completed_at is not null and (c.completed_at at time zone parameters.time_zone)::date >= parameters.range_start
    and (c.completed_at at time zone parameters.time_zone)::date < parameters.range_end
    and c.compensation_rate>0 and (c.compensation_type='fixed' or c.compensation_rate<=100)
    and round(case when c.compensation_type='fixed' then c.compensation_rate*c.allocated_quantity else c.allocated_amount*c.compensation_rate/100 end,2)>0;
$$;
revoke all on function private.clinic_doctor_invoice_lines(date,date,uuid) from public,anon,authenticated;

-- Private storage/payment snapshots require a guarded private definer, as in HR.
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
  filtered as (select * from lines where not p_untransferred_only or (not transferred and payment_id is null)),
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
create or replace function public.get_clinic_doctor_day_payroll(p_day date,p_user_id uuid default null,p_page integer default 1,p_page_size integer default 20,p_untransferred_only boolean default false)
returns jsonb language sql stable security invoker set search_path='' as $$
  select private.build_clinic_doctor_day_payroll(p_day,p_user_id,p_page,p_page_size,p_untransferred_only);
$$;
revoke all on function private.build_clinic_doctor_day_payroll(date,uuid,integer,integer,boolean) from public,anon,authenticated;
revoke all on function public.get_clinic_doctor_day_payroll(date,uuid,integer,integer,boolean) from public,anon,authenticated;
grant execute on function private.build_clinic_doctor_day_payroll(date,uuid,integer,integer,boolean) to authenticated;
grant execute on function public.get_clinic_doctor_day_payroll(date,uuid,integer,integer,boolean) to authenticated;

-- Only compact aggregates leave private storage; each section retains its access gate.
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
    with pending as materialized (select * from private.clinic_doctor_invoice_lines('1900-01-01',v_today,null) where not transferred and payment_id is null),
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
create or replace function public.get_clinic_management_overview(p_start_date date,p_end_date date)
returns jsonb language sql stable security invoker set search_path='' as $$ select private.build_clinic_management_overview(p_start_date,p_end_date); $$;
revoke all on function private.build_clinic_management_overview(date,date) from public,anon,authenticated;
revoke all on function public.get_clinic_management_overview(date,date) from public,anon,authenticated;
grant execute on function private.build_clinic_management_overview(date,date) to authenticated;
grant execute on function public.get_clinic_management_overview(date,date) to authenticated;
