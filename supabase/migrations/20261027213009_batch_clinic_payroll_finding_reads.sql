-- Evaluate the chart lookup once per completed invoice item, then filter the
-- completion range before split rounding and compensation. All allocations of
-- an item keep the same date, preserving rounding and settlement semantics.

-- This private projection also includes completed, invoiced cases awaiting transfer.
-- Allocation rounding and compensation rules mirror the existing payroll projection;
-- settlement still runs exclusively through hr_pay_doctor_procedures_with_method.
create or replace function private.clinic_doctor_invoice_lines(p_start_date date, p_end_date date, p_user_id uuid default null)
returns table(invoice_id bigint, invoice_item_id bigint, patient_id uuid, patient_name text,
  doctor_id uuid, doctor_name text, finding_id uuid, operation_name text, tooth text,
  invoice_amount numeric, doctor_amount numeric, transferred boolean, payment_id uuid, completed_at timestamptz)
language sql stable set search_path = '' set jit = off as $$
  with parameters as (
    select p_start_date range_start, p_end_date + 1 range_end,
      coalesce((select nullif(btrim(attendance_timezone),'') from public.clinic_settings where id=1),'Africa/Cairo') time_zone
  ), chart_findings as materialized (
    select item.id invoice_item_id,
      private.chart_finding_by_id(patient.chart_state,item.finding_id) value
    from public.patient_invoice_items item
    join public.patient_invoices invoice on invoice.id=item.invoice_id and invoice.status<>'cancelled'
    join public.patients patient on patient.id=invoice.patient_id
    where item.operation_status='C' and item.operation_code<>'diagnosis_fee' and item.unit_price*item.quantity>0
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
    join chart_findings finding on finding.invoice_item_id=item.id
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
  period_allocations as (
    select source_allocations.* from source_allocations cross join parameters
    where completed_at is not null
      and (completed_at at time zone parameters.time_zone)::date >= parameters.range_start
      and (completed_at at time zone parameters.time_zone)::date < parameters.range_end
  ),
  rounded_shares as (
    select period_allocations.*,
      row_number() over (partition by invoice_item_id order by finding_id) as allocation_number,
      count(*) over (partition by invoice_item_id) as allocation_count,
      round(invoice_amount * percentage / 100, 2) as rounded_amount
    from period_allocations
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
