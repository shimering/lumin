-- A transferred invoice item has one whole-procedure allocation or one allocation per step.
-- The source invoice amount is counted once across those allocations.
alter table private.hr_doctor_salary_transfers
  alter column doctor_id drop not null,
  add column assignment_mode text not null default 'whole'
    check (assignment_mode in ('whole', 'steps')),
  add column allocations jsonb not null default '[]'::jsonb,
  add column assignment_signature jsonb;

alter table private.hr_doctor_salary_payment_items
  alter column procedure_quantity type numeric(12,4);

create or replace function private.doctor_salary_assignment_signature(p_finding jsonb)
returns jsonb language sql stable set search_path = '' as $$
  select case when p_finding is null then null else jsonb_build_object(
    'status', p_finding->>'status',
    'completed_at', coalesce(p_finding->>'completedAt', p_finding->>'completed_at'),
    'doctor_id', coalesce(p_finding->>'doctorId', p_finding->>'doctor_id'),
    'steps', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', step.value->>'id',
        'payroll_finding_id', coalesce(step.value->>'payrollFindingId', step.value->>'payroll_finding_id'),
        'doctor_id', coalesce(step.value->>'doctorId', step.value->>'doctor_id'),
        'percentage', step.value->>'percentage',
        'status', step.value->>'status'
      ) order by step.value->>'id')
      from jsonb_array_elements(case when jsonb_typeof(p_finding->'steps') = 'array'
        then p_finding->'steps' else '[]'::jsonb end) as step(value)
    ), '[]'::jsonb)
  ) end;
$$;

create or replace function private.doctor_salary_assignment_is_complete(p_finding jsonb)
returns boolean language plpgsql stable set search_path = '' as $$
declare
  v_steps jsonb;
  v_doctor_id text;
  v_step jsonb;
  v_sum numeric := 0;
  v_ids text[] := array[]::text[];
  v_payroll_id text;
begin
  if p_finding is null or p_finding->>'status' <> 'C' then return false; end if;
  v_steps := case when jsonb_typeof(p_finding->'steps') = 'array' then p_finding->'steps' else '[]'::jsonb end;
  v_doctor_id := nullif(btrim(coalesce(p_finding->>'doctorId', p_finding->>'doctor_id', '')), '');

  if v_doctor_id is not null then
    if v_doctor_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or exists (select 1 from jsonb_array_elements(v_steps) as step(value)
        where step.value->>'status' is distinct from 'C'
          or nullif(btrim(coalesce(step.value->>'doctorId', step.value->>'doctor_id', '')), '') is not null)
      then return false;
    end if;
    return exists (select 1 from public.user_profiles as profile
      where profile.user_id = v_doctor_id::uuid and profile.active and profile.is_doctor);
  end if;
  if jsonb_array_length(v_steps) = 0 then return false; end if;

  for v_step in select value from jsonb_array_elements(v_steps) loop
    v_doctor_id := nullif(btrim(coalesce(v_step->>'doctorId', v_step->>'doctor_id', '')), '');
    v_payroll_id := coalesce(v_step->>'payrollFindingId', v_step->>'payroll_finding_id');
    if v_step->>'status' <> 'C'
      or v_doctor_id is null
      or v_doctor_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or v_payroll_id is null
      or v_payroll_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or v_payroll_id = any(v_ids)
      or coalesce(v_step->>'percentage', '') !~ '^[0-9]+([.][0-9]+)?$'
      then return false;
    end if;
    if not exists (select 1 from public.user_profiles as profile
      where profile.user_id = v_doctor_id::uuid and profile.active and profile.is_doctor)
      then return false;
    end if;
    v_ids := array_append(v_ids, v_payroll_id);
    v_sum := v_sum + (v_step->>'percentage')::numeric;
  end loop;
  return v_sum = 100;
end;
$$;

-- Existing transfers, if any were created during deployment, keep their whole-doctor share.
update private.hr_doctor_salary_transfers as transfer
set allocations = jsonb_build_array(jsonb_build_object(
      'finding_id', transfer.finding_id,
      'doctor_id', transfer.doctor_id,
      'percentage', 100,
      'step_name', null)),
    assignment_signature = private.doctor_salary_assignment_signature(
      private.chart_finding_by_id(patient.chart_state, transfer.finding_id))
from public.patient_invoice_items as item
join public.patient_invoices as invoice on invoice.id = item.invoice_id
join public.patients as patient on patient.id = invoice.patient_id
where item.id = transfer.invoice_item_id and transfer.allocations = '[]'::jsonb;

create or replace function private.doctor_salary_linked_expenses(p_invoice_item_id bigint)
returns table (expense_id uuid, expense_name text)
language sql stable security definer set search_path = '' as $$
  select distinct expense.id, expense.name
  from public.patient_invoice_items as item
  join public.patient_invoices as invoice on invoice.id = item.invoice_id
  join public.patients as patient on patient.id = invoice.patient_id
  join private.hr_doctor_salary_payment_items as paid on paid.patient_id = patient.id
  join public.hr_salary_payments as payment on payment.id = paid.payment_id
  join public.expenses as expense on expense.id = payment.expense_id
  left join private.hr_doctor_salary_transfers as transfer on transfer.finding_id = item.finding_id
  where item.id = p_invoice_item_id
    and (paid.finding_id = item.finding_id
      or exists (select 1 from jsonb_array_elements(coalesce(transfer.allocations, '[]'::jsonb)) as allocation(value)
        where allocation.value->>'finding_id' = paid.finding_id::text)
      or private.chart_finding_by_id(patient.chart_state, paid.finding_id)->>'parentFindingId' = item.finding_id::text);
$$;

drop function public.get_patient_doctor_salary_transfers(uuid);
create function public.get_patient_doctor_salary_transfers(p_patient_id uuid)
returns table (invoice_item_id bigint, transfer_status text, expense_id uuid, expense_name text, doctor_name text, expenses jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.is_active_user()
    or not (private.is_admin() or private.has_page_permission('patients') or private.has_page_permission('chart')) then
    raise exception 'Patient access is required.' using errcode = '42501';
  end if;

  return query
  select item.id,
    case
      when jsonb_array_length(paid.expenses) > 0 then 'paid'
      when eligible.valid and transfer.assignment_signature = private.doctor_salary_assignment_signature(finding.value) then 'transferred'
      when eligible.valid then 'eligible'
      else 'ineligible'
    end,
    (paid.expenses->0->>'id')::uuid,
    paid.expenses->0->>'name',
    coalesce(main_doctor.full_name, step_doctors.names, ''),
    paid.expenses
  from public.patient_invoices as invoice
  join public.patient_invoice_items as item on item.invoice_id = invoice.id
  join public.patients as patient on patient.id = invoice.patient_id
  left join lateral (select private.chart_finding_by_id(patient.chart_state, item.finding_id) as value) as finding on true
  left join private.hr_doctor_salary_transfers as transfer on transfer.finding_id = item.finding_id
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
    and private.doctor_salary_assignment_is_complete(finding.value) as valid) as eligible
  cross join lateral (
    select coalesce(jsonb_agg(jsonb_build_object('id', linked.expense_id, 'name', linked.expense_name)
      order by linked.expense_name, linked.expense_id), '[]'::jsonb) as expenses
    from private.doctor_salary_linked_expenses(item.id) as linked
  ) as paid
  where invoice.patient_id = p_patient_id;
end;
$$;

create or replace function public.transfer_doctor_salary_invoice_item(p_item_id bigint)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  item public.patient_invoice_items;
  invoice public.patient_invoices;
  finding jsonb;
  steps jsonb;
  allocations jsonb;
  doctor_id uuid;
  mode text;
begin
  if auth.uid() is null or not private.is_active_user()
    or not (private.is_admin() or private.has_page_permission('patients') or private.has_page_permission('chart')) then
    raise exception 'Patient access is required.' using errcode = '42501';
  end if;
  select * into item from public.patient_invoice_items where id = p_item_id for update;
  if item is null then raise exception 'Invoice procedure was not found.' using errcode = 'P0002'; end if;
  select * into invoice from public.patient_invoices where id = item.invoice_id;
  if invoice.status = 'cancelled' or item.finding_id is null or item.operation_status <> 'C'
    or item.unit_price * item.quantity <= 0 then
    raise exception 'The procedure must be completed and invoiced before salary transfer.' using errcode = '22023';
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
$$;

create or replace function private.guard_doctor_salary_invoice_item()
returns trigger language plpgsql security definer set search_path = '' as $$
declare linked_expense record;
begin
  select * into linked_expense from private.doctor_salary_linked_expenses(old.id) limit 1;
  if tg_op = 'DELETE' then
    if linked_expense is not null then
      raise exception 'Delete doctor salary expense "%" (%) before deleting this invoice procedure.', linked_expense.expense_name, linked_expense.expense_id using errcode = '23503';
    end if;
    return old;
  end if;
  if new.invoice_id is distinct from old.invoice_id or new.finding_id is distinct from old.finding_id
    or new.operation_status is distinct from old.operation_status or new.unit_price is distinct from old.unit_price
    or new.quantity is distinct from old.quantity or new.doctor_id is distinct from old.doctor_id then
    if linked_expense is not null then
      raise exception 'Delete doctor salary expense "%" (%) before changing this invoice procedure.', linked_expense.expense_name, linked_expense.expense_id using errcode = '23503';
    end if;
    delete from private.hr_doctor_salary_transfers where finding_id = old.finding_id;
  end if;
  return new;
end;
$$;

create or replace function private.guard_doctor_salary_invoice()
returns trigger language plpgsql security definer set search_path = '' as $$
declare linked_expense record;
begin
  select linked.* into linked_expense
  from public.patient_invoice_items as item
  cross join lateral private.doctor_salary_linked_expenses(item.id) as linked
  where item.invoice_id = old.id limit 1;
  if linked_expense is not null then
    raise exception 'Delete doctor salary expense "%" (%) before deleting this invoice.', linked_expense.expense_name, linked_expense.expense_id using errcode = '23503';
  end if;
  return old;
end;
$$;

create or replace function private.guard_doctor_salary_payment_item_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  parent_finding_id uuid;
  chart_state jsonb;
  signature jsonb;
begin
  select transfer.finding_id, patient.chart_state, transfer.assignment_signature
    into parent_finding_id, chart_state, signature
  from private.hr_doctor_salary_transfers as transfer
  join public.patient_invoice_items as item on item.id = transfer.invoice_item_id
  join public.patient_invoices as invoice on invoice.id = item.invoice_id
  join public.patients as patient on patient.id = invoice.patient_id
  where item.operation_status = 'C' and invoice.patient_id = new.patient_id
    and invoice.status <> 'cancelled'
    and exists (select 1 from jsonb_to_recordset(transfer.allocations)
      as allocation(finding_id uuid, doctor_id uuid, percentage numeric, step_name text)
      where allocation.finding_id = new.finding_id and allocation.doctor_id = new.doctor_id)
  for key share of item;
  if parent_finding_id is null
    or not private.doctor_salary_assignment_is_complete(private.chart_finding_by_id(chart_state, parent_finding_id))
    or signature is distinct from private.doctor_salary_assignment_signature(private.chart_finding_by_id(chart_state, parent_finding_id)) then
    raise exception 'This doctor case is no longer completed, invoiced, and transferred.' using errcode = '23503';
  end if;
  return new;
end;
$$;

revoke all on function public.get_patient_doctor_salary_transfers(uuid) from public, anon;
grant execute on function public.get_patient_doctor_salary_transfers(uuid) to authenticated;
revoke all on function private.doctor_salary_assignment_signature(jsonb) from public, anon, authenticated;
revoke all on function private.doctor_salary_assignment_is_complete(jsonb) from public, anon, authenticated;
revoke all on function private.doctor_salary_linked_expenses(bigint) from public, anon, authenticated;

create or replace function private.hr_doctor_payroll_case_lines(
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
  salary_amount numeric
)
language sql stable set search_path = '' as $$
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
      operation.name as catalog_operation_name,
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
$$;
