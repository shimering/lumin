-- Unpaid procedure compensation can be released without creating an expense.
-- A release belongs to one doctor/allocation; reassignment and other split shares
-- retain their own payment eligibility. Restoring makes the share payable again.
create table private.hr_doctor_salary_releases (
  finding_id uuid not null,
  doctor_id uuid not null references public.user_profiles(user_id) on delete cascade,
  released_at timestamptz not null default now(),
  released_by uuid references public.user_profiles(user_id) on delete set null,
  primary key (finding_id, doctor_id)
);
alter table private.hr_doctor_salary_releases enable row level security;
revoke all on private.hr_doctor_salary_releases from public, anon, authenticated;
create index hr_doctor_salary_releases_actor_idx on private.hr_doctor_salary_releases(released_by);
create index hr_doctor_salary_releases_doctor_idx on private.hr_doctor_salary_releases(doctor_id);

-- Keep the complete review projection separate from the payable projection.
CREATE OR REPLACE FUNCTION private.hr_doctor_payroll_review_lines(p_start_date date, p_end_date date, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(doctor_id uuid, doctor_name text, finding_id uuid, patient_id uuid, patient_name text, completed_at timestamp with time zone, operation_id uuid, operation_code text, operation_name text, procedure_quantity numeric, gross_amount numeric, compensation_type text, compensation_rate numeric, salary_amount numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
 SET jit TO 'off'
AS $function$
  with parameters as (
    select
      p_start_date as range_start,
      p_end_date + 1 as range_end,
      coalesce((select nullif(btrim(setting.attendance_timezone), '')
        from public.clinic_settings as setting where setting.id = 1), 'Africa/Cairo') as time_zone
  ),
  source_allocations as (
    select
      transfer.finding_id as parent_finding_id,
      transfer.invoice_item_id,
      allocation.finding_id,
      allocation.doctor_id,
      allocation.percentage,
      allocation.step_name,
      patient.id as patient_id,
      coalesce(nullif(btrim(patient.name), ''), 'Patient') as patient_name,
      private.try_parse_timestamptz(coalesce(
        finding.value->>'completedAt', finding.value->>'completed_at',
        finding.value->>'createdAt', finding.value->>'created_at')) as completed_at,
      item.operation_id,
      item.operation_code,
      round(item.unit_price * item.quantity, 2) as invoice_amount,
      item.quantity as invoice_quantity
    from private.hr_doctor_salary_transfers as transfer
    join public.patient_invoice_items as item on item.id = transfer.invoice_item_id
      and item.finding_id = transfer.finding_id and item.operation_status = 'C'
    join public.patient_invoices as invoice on invoice.id = item.invoice_id
      and invoice.status <> 'cancelled'
    join public.patients as patient on patient.id = invoice.patient_id
    cross join lateral jsonb_to_recordset(transfer.allocations)
      as allocation(finding_id uuid, doctor_id uuid, percentage numeric, step_name text)
    cross join lateral (select private.chart_finding_by_id(patient.chart_state, transfer.finding_id) as value) as finding
    where item.unit_price * item.quantity > 0
      and private.doctor_salary_assignment_is_complete(finding.value)
      and transfer.assignment_signature = private.doctor_salary_assignment_signature(finding.value)
      and allocation.percentage > 0 and allocation.percentage <= 100
    union all
    select
      transfer.finding_id as parent_finding_id,
      transfer.invoice_item_id,
      transfer.finding_id,
      transfer.doctor_id,
      100::numeric as percentage,
      null::text as step_name,
      patient.id as patient_id,
      coalesce(nullif(btrim(patient.name), ''), 'Patient') as patient_name,
      appointment.appointment_at as completed_at,
      coalesce(item.operation_id, diagnosis_operation.id) as operation_id,
      item.operation_code,
      round(item.unit_price * item.quantity, 2) as invoice_amount,
      item.quantity as invoice_quantity
    from private.hr_doctor_salary_transfers as transfer
    join public.patient_invoice_items as item on item.id = transfer.invoice_item_id
      and item.finding_id = transfer.finding_id
      and item.operation_code = 'diagnosis_fee' and item.operation_status = 'C'
    join public.patient_invoices as invoice on invoice.id = item.invoice_id
      and invoice.status <> 'cancelled'
    join public.patients as patient on patient.id = invoice.patient_id
    join public.appointments as appointment on appointment.id = item.appointment_id
      and appointment.patient_id = patient.id and appointment.status = 'Completed'
    join public.dental_operations as diagnosis_operation on diagnosis_operation.code = 'dz_diagnosis_a1'
    where item.unit_price * item.quantity > 0
      and transfer.assignment_mode = 'whole'
      and transfer.doctor_id = item.doctor_id
      and transfer.assignment_signature = jsonb_build_object(
        'doctor_id', item.doctor_id::text, 'appointment_id', item.appointment_id::text)
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
  select
    compensated.doctor_id,
    compensated.doctor_name,
    compensated.finding_id,
    compensated.patient_id,
    compensated.patient_name,
    compensated.completed_at,
    compensated.operation_id,
    compensated.operation_code,
    case when nullif(btrim(compensated.step_name), '') is null
      then compensated.catalog_operation_name
      else compensated.catalog_operation_name || ' · ' || compensated.step_name end,
    compensated.allocated_quantity,
    compensated.allocated_amount,
    compensated.compensation_type,
    compensated.compensation_rate,
    round(case when compensated.compensation_type = 'fixed'
      then compensated.compensation_rate * compensated.allocated_quantity
      else compensated.allocated_amount * compensated.compensation_rate / 100 end, 2)
  from compensated
  cross join parameters
  where compensated.completed_at is not null
    and (compensated.completed_at at time zone parameters.time_zone)::date >= parameters.range_start
    and (compensated.completed_at at time zone parameters.time_zone)::date < parameters.range_end
    and compensated.compensation_rate > 0
    and (compensated.compensation_type = 'fixed' or compensated.compensation_rate <= 100)
    and round(case when compensated.compensation_type = 'fixed'
      then compensated.compensation_rate * compensated.allocated_quantity
      else compensated.allocated_amount * compensated.compensation_rate / 100 end, 2) > 0;
$function$;

create or replace function private.hr_doctor_payroll_case_lines(p_start_date date, p_end_date date, p_user_id uuid default null)
 RETURNS TABLE(doctor_id uuid, doctor_name text, finding_id uuid, patient_id uuid, patient_name text, completed_at timestamp with time zone, operation_id uuid, operation_code text, operation_name text, procedure_quantity numeric, gross_amount numeric, compensation_type text, compensation_rate numeric, salary_amount numeric)
language sql stable set search_path = '' set jit = off as $$
  select line.* from private.hr_doctor_payroll_review_lines(p_start_date, p_end_date, p_user_id) line
  where not exists (
    select 1 from private.hr_doctor_salary_releases released
    where released.finding_id = line.finding_id and released.doctor_id = line.doctor_id
  );
$$;
revoke all on function private.hr_doctor_payroll_review_lines(date,date,uuid) from public,anon,authenticated;
revoke all on function private.hr_doctor_payroll_case_lines(date,date,uuid) from public,anon,authenticated;

-- Add release metadata while preserving paid snapshots and existing clients.
drop function public.get_hr_doctor_payroll_cases(date,date,uuid);
create or replace function public.get_hr_doctor_payroll_cases(
  p_start_date date,
  p_end_date date,
  p_user_id uuid default null
)
returns table (
  doctor_id uuid,
  doctor_name text,
  finding_id uuid,
  patient_id uuid,
  patient_name text,
  completed_at timestamptz,
  operation_id uuid,
  operation_code text,
  operation_name text,
  procedure_quantity numeric,
  gross_amount numeric,
  compensation_type text,
  compensation_rate numeric,
  salary_amount numeric,
  payment_id uuid,
  expense_id uuid,
  payment_kind text,
  paid_at timestamptz,
  released_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.has_hr_access() then
    raise exception 'HR access is required.' using errcode = '42501';
  end if;
  if p_start_date is null or p_end_date is null or p_end_date < p_start_date or p_start_date < date '0001-01-01' or p_end_date > date '9999-12-31' then
    raise exception 'Choose a valid completion date range.' using errcode = '22023';
  end if;

  return query
  with live_unpaid as (
    select line.*
    from private.hr_doctor_payroll_review_lines(p_start_date, p_end_date, p_user_id) as line
    where not exists (
      select 1 from private.hr_doctor_salary_payment_items as item
      where item.finding_id = line.finding_id
    )
  ),
  paid_snapshots as (
    select item.*, payment.expense_id, payment.payment_kind, payment.paid_at
    from private.hr_doctor_salary_payment_items as item
    join public.hr_salary_payments as payment on payment.id = item.payment_id
    cross join lateral (
      select coalesce((select nullif(btrim(setting.attendance_timezone), '') from public.clinic_settings as setting where setting.id = 1), 'Africa/Cairo') as time_zone
    ) as settings
    where (item.completed_at at time zone settings.time_zone)::date between p_start_date and p_end_date
      and (p_user_id is null or item.doctor_id = p_user_id)
  )
  select
    unpaid.doctor_id, unpaid.doctor_name, unpaid.finding_id, unpaid.patient_id, unpaid.patient_name,
    unpaid.completed_at, unpaid.operation_id, unpaid.operation_code, unpaid.operation_name,
    unpaid.procedure_quantity, unpaid.gross_amount, unpaid.compensation_type,
    unpaid.compensation_rate, unpaid.salary_amount, null::uuid, null::uuid, null::text, null::timestamptz, released.released_at
  from live_unpaid as unpaid
  left join private.hr_doctor_salary_releases released
    on released.finding_id = unpaid.finding_id and released.doctor_id = unpaid.doctor_id
  union all
  select
    paid.doctor_id, paid.doctor_name, paid.finding_id, paid.patient_id, paid.patient_name,
    paid.completed_at, paid.operation_id, paid.operation_code, paid.operation_name,
    paid.procedure_quantity, paid.gross_amount, paid.compensation_type,
    paid.compensation_rate, paid.salary_amount, paid.payment_id, paid.expense_id,
    paid.payment_kind, paid.paid_at, null::timestamptz
  from paid_snapshots as paid
  order by 6 desc, 3;
end;
$$;
revoke all on function public.get_hr_doctor_payroll_cases(date,date,uuid) from public,anon;
grant execute on function public.get_hr_doctor_payroll_cases(date,date,uuid) to authenticated;

-- Keep clinic payroll totals and pending alerts aligned with released shares.
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
  where not exists (
      select 1 from private.hr_doctor_salary_releases released
      where released.finding_id=c.finding_id and released.doctor_id=c.doctor_id
    ) and c.completed_at is not null and (c.completed_at at time zone parameters.time_zone)::date >= parameters.range_start
    and (c.completed_at at time zone parameters.time_zone)::date < parameters.range_end
    and c.compensation_rate>0 and (c.compensation_type='fixed' or c.compensation_rate<=100)
    and round(case when c.compensation_type='fixed' then c.compensation_rate*c.allocated_quantity else c.allocated_amount*c.compensation_rate/100 end,2)>0;
$$;
revoke all on function private.clinic_doctor_invoice_lines(date,date,uuid) from public,anon,authenticated;

-- Lock the same doctor row for releases and payment-item inserts. A payment
-- already being reviewed must roll back atomically if a share was released.
create function private.guard_hr_doctor_salary_release()
returns trigger language plpgsql set search_path = '' as $$
begin
  perform 1 from public.user_profiles where user_id = new.doctor_id for update;
  if exists (select 1 from private.hr_doctor_salary_releases released
    where released.finding_id = new.finding_id and released.doctor_id = new.doctor_id) then
    raise exception 'This procedure payment was released. Refresh and review the cases again.' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_hr_doctor_salary_release() from public,anon,authenticated;
create trigger guard_hr_doctor_salary_release before insert or update on private.hr_doctor_salary_payment_items
  for each row execute function private.guard_hr_doctor_salary_release();

create function public.set_hr_doctor_procedure_release(
  p_user_id uuid, p_finding_id uuid, p_released boolean, p_start_date date, p_end_date date
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.can_manage_hr() then
    raise exception 'HR modify access is required.' using errcode = '42501';
  end if;
  if p_released is null or p_finding_id is null or p_start_date is null or p_end_date is null
    or p_end_date < p_start_date or p_start_date < date '0001-01-01' or p_end_date > date '9999-12-31' then
    raise exception 'Choose a valid procedure and completion date range.' using errcode = '22023';
  end if;
  perform 1 from public.user_profiles where user_id = p_user_id and active and is_doctor for update;
  if not found then
    raise exception 'Active doctor was not found.' using errcode = '22023';
  end if;
  if exists (select 1 from private.hr_doctor_salary_payment_items paid where paid.finding_id = p_finding_id) then
    raise exception 'Paid procedures cannot be released. Undo the linked Salary expense first.' using errcode = '22023';
  end if;
  if p_released then
    if not exists (select 1 from private.hr_doctor_payroll_review_lines(p_start_date,p_end_date,p_user_id) line
      where line.finding_id = p_finding_id) then
      raise exception 'This procedure is no longer available for salary review. Refresh and try again.' using errcode = '22023';
    end if;
    insert into private.hr_doctor_salary_releases(finding_id,doctor_id,released_by)
      values(p_finding_id,p_user_id,auth.uid()) on conflict(finding_id,doctor_id) do nothing;
  else
    delete from private.hr_doctor_salary_releases released
      where released.finding_id = p_finding_id and released.doctor_id = p_user_id;
  end if;
end;
$$;
revoke all on function public.set_hr_doctor_procedure_release(uuid,uuid,boolean,date,date) from public,anon;
grant execute on function public.set_hr_doctor_procedure_release(uuid,uuid,boolean,date,date) to authenticated;

-- Individual selections may span years; monthly and daily settlements keep
-- their original bounds. Use the actual selected completion dates in history.
alter table public.hr_salary_payments drop constraint hr_salary_payments_scope_check;
alter table public.hr_salary_payments add constraint hr_salary_payments_scope_check check (
  scope_end >= scope_start
  and (payment_kind = 'doctor_cases' or scope_end <= scope_start + 365)
  and (payment_kind <> 'staff_monthly' or (scope_start = pay_month and scope_end = (pay_month + interval '1 month - 1 day')::date))
  and (payment_kind <> 'doctor_month' or (scope_start = pay_month and scope_end = (pay_month + interval '1 month - 1 day')::date))
  and (payment_kind <> 'doctor_day' or scope_start = scope_end)
);

CREATE OR REPLACE FUNCTION public.hr_pay_doctor_procedures_with_method(p_user_id uuid, p_scope text, p_start_date date, p_end_date date, p_finding_ids uuid[], p_payment_method_id uuid, p_expected_amount numeric)
 RETURNS public.hr_salary_payments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  normalized_scope text := lower(btrim(coalesce(p_scope, '')));
  payment_kind_value text;
  pay_month_value date;
  profile public.user_profiles;
  selected_lines jsonb;
  selected_count integer;
  requested_count integer;
  salary_total numeric(12,2);
  salary_type_id uuid;
  new_expense_id uuid;
  result public.hr_salary_payments;
  scope_label text;
  selected_start date;
  selected_end date;
  time_zone text;
begin
  if not private.can_manage_hr() then
    raise exception 'HR modify access is required.' using errcode = '42501';
  end if;

  if auth.uid() is null then
    raise exception 'Sign in to pay salaries.' using errcode = '42501';
  end if;
  perform 1 from public.payment_methods where id = p_payment_method_id and active for share;
  if not found then
    raise exception 'Choose an active payment method.' using errcode = '22023';
  end if;
  if p_start_date is null or p_end_date is null or p_end_date < p_start_date or p_start_date < date '0001-01-01' or p_end_date > date '9999-12-31'
    or (normalized_scope <> 'cases' and p_end_date > p_start_date + 365) then
    raise exception 'Choose a valid completion date range.' using errcode = '22023';
  end if;

  if normalized_scope = 'month' then
    payment_kind_value := 'doctor_month';
    if p_start_date <> date_trunc('month', p_start_date)::date
      or p_end_date <> (date_trunc('month', p_start_date) + interval '1 month - 1 day')::date then
      raise exception 'A monthly settlement must cover one complete calendar month.' using errcode = '22023';
    end if;
  elsif normalized_scope = 'day' then
    payment_kind_value := 'doctor_day';
    if p_start_date <> p_end_date then
      raise exception 'A daily settlement must cover one calendar day.' using errcode = '22023';
    end if;
  elsif normalized_scope = 'cases' then
    payment_kind_value := 'doctor_cases';
    if p_finding_ids is null or cardinality(p_finding_ids) = 0 then
      raise exception 'Select at least one unpaid case.' using errcode = '22023';
    end if;
    select count(distinct finding_id)::integer into requested_count from unnest(p_finding_ids) as finding(finding_id);
    if requested_count <> cardinality(p_finding_ids) then
      raise exception 'The selected case list contains duplicates.' using errcode = '22023';
    end if;
  else
    raise exception 'Choose month, day, or cases as the doctor payment scope.' using errcode = '22023';
  end if;

  select * into profile
  from public.user_profiles
  where user_id = p_user_id and active and is_doctor;
  if profile is null then
    raise exception 'Active doctor was not found.' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(to_jsonb(candidate) order by candidate.completed_at, candidate.finding_id), '[]'::jsonb)
  into selected_lines
  from (
    select line.*
    from private.hr_doctor_payroll_case_lines(p_start_date, p_end_date, p_user_id) as line
    where not exists (
      select 1 from private.hr_doctor_salary_payment_items as paid_item
      where paid_item.finding_id = line.finding_id
    )
      and (normalized_scope <> 'cases' or line.finding_id = any(p_finding_ids))
  ) as candidate;

  selected_count := jsonb_array_length(selected_lines);
  if normalized_scope = 'cases' and selected_count <> requested_count then
    raise exception 'One or more selected cases are no longer payable or were already paid.' using errcode = '22023';
  end if;
  if selected_count = 0 then
    raise exception 'There are no unpaid doctor cases in this selection.' using errcode = '22023';
  end if;

  select round(sum((line->>'salary_amount')::numeric), 2)
  into salary_total
  from jsonb_array_elements(selected_lines) as line;
  if salary_total is null or salary_total <= 0 then
    raise exception 'The calculated doctor salary is zero.' using errcode = '22023';
  end if;


  if p_expected_amount is null or p_expected_amount <> salary_total then
    raise exception 'The calculated salary changed. Close this dialog and refresh HR before paying.' using errcode = '22023';
  end if;
  select id into salary_type_id
  from public.expense_types
  where lower(btrim(name)) = 'salary'
  order by active desc, created_at
  limit 1;
  if salary_type_id is null then
    raise exception 'Create the Salary expense type before paying a doctor.' using errcode = '22023';
  end if;

  select coalesce(nullif(btrim(attendance_timezone), ''), 'Africa/Cairo') into time_zone
    from public.clinic_settings where id = 1;
  time_zone := coalesce(time_zone, 'Africa/Cairo');
  select min((line.completed_at at time zone time_zone)::date), max((line.completed_at at time zone time_zone)::date)
    into selected_start, selected_end
    from jsonb_to_recordset(selected_lines) as line(completed_at timestamptz);
  pay_month_value := case when normalized_scope = 'cases'
    and date_trunc('month', selected_start) <> date_trunc('month', selected_end)
    then date_trunc('month', (now() at time zone time_zone)::date)::date
    else date_trunc('month', case when normalized_scope = 'cases' then selected_start else p_start_date end)::date end;
  insert into public.hr_payroll_periods (pay_month) values (pay_month_value) on conflict do nothing;

  scope_label := case normalized_scope
    when 'month' then to_char(p_start_date, 'Mon YYYY')
    when 'day' then to_char(p_start_date, 'DD Mon YYYY')
    else selected_count || ' case' || case when selected_count = 1 then '' else 's' end
  end;

  insert into public.expenses (
    expense_type_id, name, total, paid_amount, quantity, expense_date,
    description, confirmed, paid, created_by, sync_payment_method_id
  ) values (
    salary_type_id,
    'Salary — ' || profile.full_name || ' — ' || scope_label,
    salary_total,
    salary_total,
    1,
    current_date,
    'Linked doctor procedure settlement (' || normalized_scope || ') for ' || selected_count || ' completed case' || case when selected_count = 1 then '' else 's' end || '. Delete this expense to reopen the cases for review.',
    true,
    true,
    auth.uid(),
    p_payment_method_id
  ) returning id into new_expense_id;

  insert into public.hr_salary_payments (
    user_id, pay_month, attended_shifts, regular_shift_rate, regular_amount,
    extra_amount, performance_amount, total_amount, expense_id, paid_by,
    payment_kind, scope_start, scope_end, case_count
  ) values (
    p_user_id, pay_month_value, selected_count, 0, salary_total,
    0, 0, salary_total, new_expense_id, auth.uid(),
    payment_kind_value, case when normalized_scope = 'cases' then selected_start else p_start_date end,
    case when normalized_scope = 'cases' then selected_end else p_end_date end, selected_count
  ) returning * into result;

  insert into private.hr_doctor_salary_payment_items (
    payment_id, finding_id, doctor_id, doctor_name, patient_id, patient_name,
    completed_at, operation_id, operation_code, operation_name, procedure_quantity,
    gross_amount, compensation_type, compensation_rate, salary_amount
  )
  select
    result.id, line.finding_id, line.doctor_id, line.doctor_name, line.patient_id,
    line.patient_name, line.completed_at, line.operation_id, line.operation_code,
    line.operation_name, line.procedure_quantity, line.gross_amount,
    line.compensation_type, line.compensation_rate, line.salary_amount
  from jsonb_to_recordset(selected_lines) as line(
    doctor_id uuid, doctor_name text, finding_id uuid, patient_id uuid,
    patient_name text, completed_at timestamptz, operation_id uuid,
    operation_code text, operation_name text, procedure_quantity numeric,
    gross_amount numeric, compensation_type text, compensation_rate numeric,
    salary_amount numeric
  );

  return result;
exception
  when unique_violation then
    raise exception 'One or more selected cases were paid by another settlement. Refresh and review the cases again.' using errcode = '23505';
end;
$function$
;

revoke all on function public.hr_pay_doctor_procedures_with_method(uuid,text,date,date,uuid[],uuid,numeric) from public,anon;
grant execute on function public.hr_pay_doctor_procedures_with_method(uuid,text,date,date,uuid[],uuid,numeric) to authenticated;
notify pgrst, 'reload schema';
