-- Appointment diagnosis fees can be assigned to an active doctor and transferred
-- to the existing doctor salary workflow after the appointment is completed.
-- The existing Diagnosis catalog operation supplies its compensation rule.

update public.patient_invoice_items as item
set finding_id = item.appointment_id,
    operation_id = operation.id
from public.dental_operations as operation
where item.operation_code = 'diagnosis_fee'
  and item.appointment_id is not null
  and item.finding_id is null
  and operation.code = 'dz_diagnosis_a1';

create or replace function public.list_diagnosis_fee_doctors()
returns table(user_id uuid, full_name text)
language plpgsql
stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.is_active_user()
    or not (private.is_admin() or private.has_page_permission('dashboard')
      or private.has_page_permission('appointments')) then
    raise exception 'Appointment access is required.' using errcode = '42501';
  end if;
  return query
    select profile.user_id, profile.full_name
    from public.user_profiles as profile
    where profile.active and profile.is_doctor
    order by profile.full_name;
end;
$$;

revoke all on function public.list_diagnosis_fee_doctors() from public, anon;
grant execute on function public.list_diagnosis_fee_doctors() to authenticated;

create or replace function public.add_assigned_diagnosis_fee_to_patient_invoice(
  p_appointment_id uuid, p_amount numeric, p_doctor_id uuid
)
returns table(invoice_id bigint, item_id bigint, unit_price numeric, created boolean, doctor_id uuid, doctor_name text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result record;
  v_doctor_name text;
  v_diagnosis_operation_id uuid;
begin
  if auth.uid() is null or not private.is_active_user()
    or not (private.is_admin() or private.has_page_permission('appointments')
      or private.has_page_permission('dashboard')) then
    raise exception 'You are not authorized to add diagnosis fees.' using errcode = '42501';
  end if;
  select profile.full_name into v_doctor_name
    from public.user_profiles as profile
    where profile.user_id = p_doctor_id and profile.active and profile.is_doctor;
  if v_doctor_name is null then
    raise exception 'Choose an active doctor for this diagnosis fee.' using errcode = '22023';
  end if;
  select operation.id into v_diagnosis_operation_id
    from public.dental_operations as operation
    where operation.code = 'dz_diagnosis_a1';
  if v_diagnosis_operation_id is null then
    raise exception 'The Diagnosis operation is unavailable.' using errcode = 'P0002';
  end if;
  select * into v_result
    from public.add_diagnosis_fee_to_patient_invoice(p_appointment_id, p_amount);
  update public.patient_invoice_items as item
     set finding_id = p_appointment_id,
         operation_id = v_diagnosis_operation_id,
         doctor_id = p_doctor_id,
         doctor_name = v_doctor_name
   where item.id = v_result.item_id;
  return query
    select v_result.invoice_id::bigint, v_result.item_id::bigint,
      v_result.unit_price::numeric, v_result.created::boolean,
      p_doctor_id, v_doctor_name;
end;
$$;

revoke all on function public.add_assigned_diagnosis_fee_to_patient_invoice(uuid, numeric, uuid) from public, anon;
grant execute on function public.add_assigned_diagnosis_fee_to_patient_invoice(uuid, numeric, uuid) to authenticated;

create or replace function public.get_diagnosis_fee_salary_state(p_appointment_id uuid)
returns table(invoice_item_id bigint, invoice_id bigint, unit_price numeric,
  doctor_id uuid, doctor_name text, transfer_status text)
language plpgsql
stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.is_active_user()
    or not (private.is_admin() or private.has_page_permission('dashboard')
      or private.has_page_permission('appointments') or private.has_page_permission('patients')) then
    raise exception 'Appointment access is required.' using errcode = '42501';
  end if;
  return query
    select item.id, item.invoice_id, item.unit_price, item.doctor_id,
      coalesce(assigned_doctor.full_name, item.doctor_name),
      case
        when exists (select 1 from private.doctor_salary_linked_expenses(item.id)) then 'paid'
        when eligible.valid and transfer.assignment_signature = jsonb_build_object(
          'doctor_id', item.doctor_id::text, 'appointment_id', item.appointment_id::text) then 'transferred'
        when eligible.valid then 'eligible'
        else 'ineligible'
      end::text
    from public.patient_invoice_items as item
    join public.patient_invoices as invoice on invoice.id = item.invoice_id
    join public.appointments as appointment on appointment.id = item.appointment_id
    left join public.user_profiles as assigned_doctor on assigned_doctor.user_id = item.doctor_id
      and assigned_doctor.active and assigned_doctor.is_doctor
    left join private.hr_doctor_salary_transfers as transfer on transfer.invoice_item_id = item.id
    cross join lateral (select
      appointment.status = 'Completed' and appointment.patient_id = invoice.patient_id
      and invoice.status <> 'cancelled' and item.operation_status = 'C'
      and item.unit_price * item.quantity > 0 and item.finding_id = item.appointment_id
      and assigned_doctor.user_id is not null as valid) as eligible
    where item.appointment_id = p_appointment_id and item.operation_code = 'diagnosis_fee'
    limit 1;
end;
$$;

revoke all on function public.get_diagnosis_fee_salary_state(uuid) from public, anon;
grant execute on function public.get_diagnosis_fee_salary_state(uuid) to authenticated;

create or replace function private.guard_paid_diagnosis_fee_appointment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expense record;
begin
  if old.status = 'Completed' and new.status is distinct from 'Completed' then
    select linked.* into v_expense
    from public.patient_invoice_items as item
    cross join lateral private.doctor_salary_linked_expenses(item.id) as linked
    where item.appointment_id = old.id and item.operation_code = 'diagnosis_fee'
    limit 1;
    if v_expense is not null then
      raise exception 'Delete doctor salary expense "%" (%) before changing this completed appointment.',
        v_expense.expense_name, v_expense.expense_id using errcode = '23503';
    end if;
  end if;
  return new;
end;
$$;

create trigger guard_paid_diagnosis_fee_appointment
before update of status on public.appointments
for each row execute function private.guard_paid_diagnosis_fee_appointment();

CREATE OR REPLACE FUNCTION public.add_diagnosis_fee_to_patient_invoice(p_appointment_id uuid, p_amount numeric)
 RETURNS TABLE(invoice_id bigint, item_id bigint, unit_price numeric, created boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_appointment public.appointments%rowtype;
  v_invoice_id bigint;
  v_item_id bigint;
  v_existing_amount numeric;
  v_doctor_name text;
  v_invoice_date date;
  v_timezone text;
begin
  if auth.uid() is null
    or not private.is_active_user()
    or not (
      private.is_admin()
      or private.has_page_permission('appointments')
      or private.has_page_permission('dashboard')
    ) then
    raise exception 'You are not authorized to add diagnosis fees.'
      using errcode = '42501';
  end if;

  if p_amount is null or p_amount <= 0 or p_amount > 1000000 then
    raise exception 'Diagnosis fee must be greater than zero and no more than EGP 1,000,000.'
      using errcode = '22023';
  end if;

  select *
    into v_appointment
    from public.appointments
    where id = p_appointment_id;

  if not found then
    raise exception 'Appointment not found.' using errcode = 'P0002';
  end if;

  if v_appointment.status = 'Cancelled' then
    raise exception 'A diagnosis fee cannot be added to a cancelled appointment.'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('diagnosis_fee:' || p_appointment_id::text, 0));

  select item.invoice_id, item.id, item.unit_price
    into v_invoice_id, v_item_id, v_existing_amount
    from public.patient_invoice_items item
    where item.appointment_id = p_appointment_id
      and item.operation_code = 'diagnosis_fee'
    limit 1;

  if found then
    return query
    select v_invoice_id, v_item_id, v_existing_amount, false;
    return;
  end if;

  select coalesce(nullif(btrim(attendance_timezone), ''), 'Africa/Cairo')
    into v_timezone
    from public.clinic_settings
    where id = 1;

  v_invoice_date := (
    v_appointment.appointment_at
    at time zone coalesce(v_timezone, 'Africa/Cairo')
  )::date;

  select coalesce(nullif(btrim(full_name), ''), 'Clinic user')
    into v_doctor_name
    from public.user_profiles
    where user_id = auth.uid();

  insert into public.patient_invoices (patient_id, invoice_date, created_by)
  values (v_appointment.patient_id, v_invoice_date, auth.uid())
  on conflict (patient_id, invoice_date)
  do update set
    updated_at = now(),
    status = case
      when patient_invoices.status = 'cancelled' then 'unpaid'
      else patient_invoices.status
    end
  returning id into v_invoice_id;

  insert into public.patient_invoice_items (
    invoice_id,
    appointment_id,
    operation_id,
    operation_code,
    operation_name,
    operation_status,
    tooth_id,
    surfaces,
    unit_price,
    quantity,
    doctor_id,
    doctor_name
  ) values (
    v_invoice_id,
    p_appointment_id,
    null,
    'diagnosis_fee',
    'Diagnosis fee',
    'C',
    null,
    '{}'::text[],
    p_amount,
    1,
    auth.uid(),
    coalesce(v_doctor_name, 'Clinic user')
  )
  returning id into v_item_id;

  return query
  select v_invoice_id, v_item_id, p_amount, true;
end;
$function$;

CREATE OR REPLACE FUNCTION public.transfer_doctor_salary_invoice_item(p_item_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  item public.patient_invoice_items;
  invoice public.patient_invoices;
  finding jsonb;
  steps jsonb;
  allocations jsonb;
  doctor_id uuid;
  mode text;
begin
  if auth.uid() is null or not private.is_active_user() then
    raise exception 'Patient access is required.' using errcode = '42501';
  end if;
  select * into item from public.patient_invoice_items where id = p_item_id for update;
  if item is null then raise exception 'Invoice procedure was not found.' using errcode = 'P0002'; end if;
  if not (private.is_admin() or private.has_page_permission('patients')
    or private.has_page_permission('chart')
    or (item.operation_code = 'diagnosis_fee' and private.has_page_permission('dashboard'))) then
    raise exception 'Patient access is required.' using errcode = '42501';
  end if;
  select * into invoice from public.patient_invoices where id = item.invoice_id;
  if invoice.status = 'cancelled' or item.finding_id is null or item.operation_status <> 'C'
    or item.unit_price * item.quantity <= 0 then
    raise exception 'The procedure must be completed and invoiced before salary transfer.' using errcode = '22023';
  end if;
  if item.operation_code = 'diagnosis_fee' then
    if item.appointment_id is null or item.finding_id is distinct from item.appointment_id
      or not exists (
        select 1 from public.appointments appointment
        where appointment.id = item.appointment_id
          and appointment.patient_id = invoice.patient_id
          and appointment.status = 'Completed'
      ) then
      raise exception 'Complete the appointment before transferring its invoiced diagnosis fee to salary.' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.user_profiles profile
      where profile.user_id = item.doctor_id and profile.active and profile.is_doctor
    ) then
      raise exception 'Assign an active doctor to the diagnosis fee before salary transfer.' using errcode = '22023';
    end if;
    if exists (select 1 from private.doctor_salary_linked_expenses(item.id)) then
      raise exception 'Delete the linked doctor salary expenses before transferring this fee again.' using errcode = '23503';
    end if;
    insert into private.hr_doctor_salary_transfers
      (finding_id, invoice_item_id, doctor_id, assignment_mode, allocations, assignment_signature, transferred_by)
    values (
      item.finding_id, item.id, item.doctor_id, 'whole',
      jsonb_build_array(jsonb_build_object('finding_id', item.finding_id,
        'doctor_id', item.doctor_id, 'percentage', 100, 'step_name', null)),
      jsonb_build_object('doctor_id', item.doctor_id::text,
        'appointment_id', item.appointment_id::text),
      auth.uid()
    )
    on conflict (finding_id) do update set
      invoice_item_id = excluded.invoice_item_id,
      doctor_id = excluded.doctor_id,
      assignment_mode = excluded.assignment_mode,
      allocations = excluded.allocations,
      assignment_signature = excluded.assignment_signature,
      transferred_at = now(),
      transferred_by = excluded.transferred_by;
    return true;
  end if;
  select private.chart_finding_by_id(patient.chart_state, item.finding_id)
    into finding from public.patients as patient where patient.id = invoice.patient_id for share;
  if not private.doctor_salary_assignment_is_complete(finding) then
    raise exception 'Complete the procedure and assign either one whole-procedure doctor or every step doctor before salary transfer.' using errcode = '22023';
  end if;
  if exists (select 1 from private.doctor_salary_linked_expenses(item.id)) then
    raise exception 'Delete the linked doctor salary expenses before transferring this procedure again.' using errcode = '23503';
  end if;

  steps := case when jsonb_typeof(finding->'steps') = 'array' then finding->'steps' else '[]'::jsonb end;
  if nullif(btrim(coalesce(finding->>'doctorId', finding->>'doctor_id', '')), '') is null then
    mode := 'steps';
    doctor_id := null;
    select jsonb_agg(jsonb_build_object(
      'finding_id', coalesce(step.value->>'payrollFindingId', step.value->>'payroll_finding_id'),
      'doctor_id', coalesce(step.value->>'doctorId', step.value->>'doctor_id'),
      'percentage', (step.value->>'percentage')::numeric,
      'step_name', step.value->>'name') order by step.ordinality)
      into allocations
    from jsonb_array_elements(steps) with ordinality as step(value, ordinality);
  else
    mode := 'whole';
    doctor_id := coalesce(finding->>'doctorId', finding->>'doctor_id')::uuid;
    allocations := jsonb_build_array(jsonb_build_object(
      'finding_id', item.finding_id,
      'doctor_id', doctor_id,
      'percentage', 100,
      'step_name', null));
  end if;

  insert into private.hr_doctor_salary_transfers
    (finding_id, invoice_item_id, doctor_id, assignment_mode, allocations, assignment_signature, transferred_by)
  values (item.finding_id, item.id, doctor_id, mode, allocations,
    private.doctor_salary_assignment_signature(finding), auth.uid())
  on conflict (finding_id) do update set
    invoice_item_id = excluded.invoice_item_id,
    doctor_id = excluded.doctor_id,
    assignment_mode = excluded.assignment_mode,
    allocations = excluded.allocations,
    assignment_signature = excluded.assignment_signature,
    transferred_at = now(),
    transferred_by = excluded.transferred_by;
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_patient_doctor_salary_transfers(p_patient_id uuid)
 RETURNS TABLE(invoice_item_id bigint, transfer_status text, expense_id uuid, expense_name text, doctor_name text, expenses jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if auth.uid() is null or not private.is_active_user()
    or not (private.is_admin() or private.has_page_permission('patients') or private.has_page_permission('chart')) then
    raise exception 'Patient access is required.' using errcode = '42501';
  end if;

  return query
  select item.id,
    case
      when jsonb_array_length(paid.expenses) > 0 then 'paid'
      when eligible.valid and transfer.assignment_signature = case
        when item.operation_code = 'diagnosis_fee' then jsonb_build_object(
          'doctor_id', item.doctor_id::text, 'appointment_id', item.appointment_id::text)
        else private.doctor_salary_assignment_signature(finding.value)
      end then 'transferred'
      when eligible.valid then 'eligible'
      else 'ineligible'
    end,
    (paid.expenses->0->>'id')::uuid,
    paid.expenses->0->>'name',
    case when item.operation_code = 'diagnosis_fee' then coalesce(assigned_doctor.full_name, '')
      else coalesce(main_doctor.full_name, step_doctors.names, '') end,
    paid.expenses
  from public.patient_invoices as invoice
  join public.patient_invoice_items as item on item.invoice_id = invoice.id
  join public.patients as patient on patient.id = invoice.patient_id
  left join lateral (select private.chart_finding_by_id(patient.chart_state, item.finding_id) as value) as finding on true
  left join private.hr_doctor_salary_transfers as transfer on transfer.finding_id = item.finding_id
  left join public.user_profiles as assigned_doctor on assigned_doctor.user_id = item.doctor_id
    and assigned_doctor.active and assigned_doctor.is_doctor
  left join public.user_profiles as main_doctor on main_doctor.user_id = case
    when coalesce(finding.value->>'doctorId', finding.value->>'doctor_id', '')
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then coalesce(finding.value->>'doctorId', finding.value->>'doctor_id')::uuid
    else null::uuid end
  left join lateral (
    select string_agg(distinct profile.full_name, ', ' order by profile.full_name) as names
    from jsonb_array_elements(case when jsonb_typeof(finding.value->'steps') = 'array'
      then finding.value->'steps' else '[]'::jsonb end) as step(value)
    join public.user_profiles as profile on profile.user_id = case
      when coalesce(step.value->>'doctorId', step.value->>'doctor_id', '')
        ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then coalesce(step.value->>'doctorId', step.value->>'doctor_id')::uuid
      else null::uuid end
  ) as step_doctors on true
  cross join lateral (select item.operation_status = 'C' and invoice.status <> 'cancelled'
    and item.finding_id is not null and item.unit_price * item.quantity > 0
    and case when item.operation_code = 'diagnosis_fee' then
      item.appointment_id = item.finding_id and assigned_doctor.user_id is not null
      and exists (select 1 from public.appointments appointment
        where appointment.id = item.appointment_id
          and appointment.patient_id = invoice.patient_id
          and appointment.status = 'Completed')
    else private.doctor_salary_assignment_is_complete(finding.value) end as valid) as eligible
  cross join lateral (
    select coalesce(jsonb_agg(jsonb_build_object('id', linked.expense_id, 'name', linked.expense_name)
      order by linked.expense_name, linked.expense_id), '[]'::jsonb) as expenses
    from private.doctor_salary_linked_expenses(item.id) as linked
  ) as paid
  where invoice.patient_id = p_patient_id;
end;
$function$;

CREATE OR REPLACE FUNCTION private.hr_doctor_payroll_case_lines(p_start_date date, p_end_date date, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(doctor_id uuid, doctor_name text, finding_id uuid, patient_id uuid, patient_name text, completed_at timestamp with time zone, operation_id uuid, operation_code text, operation_name text, procedure_quantity numeric, gross_amount numeric, compensation_type text, compensation_rate numeric, salary_amount numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
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
