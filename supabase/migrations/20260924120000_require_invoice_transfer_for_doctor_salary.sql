-- A doctor case enters payroll only after its completed invoice item is explicitly transferred.
create table private.hr_doctor_salary_transfers (
  finding_id uuid primary key,
  invoice_item_id bigint not null unique references public.patient_invoice_items(id) on delete cascade,
  doctor_id uuid not null references public.user_profiles(user_id),
  transferred_at timestamptz not null default now(),
  transferred_by uuid references auth.users(id) on delete set null
);

alter table private.hr_doctor_salary_transfers enable row level security;
revoke all on private.hr_doctor_salary_transfers from public, anon, authenticated;

create index hr_doctor_salary_transfers_doctor_idx
  on private.hr_doctor_salary_transfers (doctor_id, transferred_at);

create or replace function public.get_patient_doctor_salary_transfers(p_patient_id uuid)
returns table (invoice_item_id bigint, transfer_status text, expense_id uuid, expense_name text, doctor_name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.is_active_user()
    or not (private.is_admin() or private.has_page_permission('patients') or private.has_page_permission('chart')) then
    raise exception 'Patient access is required.' using errcode = '42501';
  end if;

  return query
  select item.id,
    case
      when paid.finding_id is not null then 'paid'
      when finding.value->>'status' = 'C' and item.operation_status = 'C'
        and invoice.status <> 'cancelled' and item.finding_id is not null
        and item.unit_price * item.quantity > 0 and doctor.user_id is not null
        and transfer.doctor_id = doctor.user_id then 'transferred'
      when finding.value->>'status' = 'C' and item.operation_status = 'C'
        and invoice.status <> 'cancelled' and item.finding_id is not null
        and item.unit_price * item.quantity > 0 and doctor.user_id is not null then 'eligible'
      else 'ineligible'
    end,
    payment.expense_id,
    expense.name,
    coalesce(paid.doctor_name, doctor.full_name)
  from public.patient_invoices as invoice
  join public.patient_invoice_items as item on item.invoice_id = invoice.id
  join public.patients as patient on patient.id = invoice.patient_id
  left join lateral (select private.chart_finding_by_id(patient.chart_state, item.finding_id) as value) as finding on true
  left join public.user_profiles as doctor
    on doctor.user_id = case
      when coalesce(finding.value->>'doctorId', finding.value->>'doctor_id', '')
        ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then coalesce(finding.value->>'doctorId', finding.value->>'doctor_id')::uuid
      else null::uuid end
    and doctor.active and doctor.is_doctor
  left join private.hr_doctor_salary_transfers as transfer on transfer.finding_id = item.finding_id
  left join private.hr_doctor_salary_payment_items as paid on paid.finding_id = item.finding_id
  left join public.hr_salary_payments as payment on payment.id = paid.payment_id
  left join public.expenses as expense on expense.id = payment.expense_id
  where invoice.patient_id = p_patient_id;
end;
$$;

create or replace function public.transfer_doctor_salary_invoice_item(p_item_id bigint)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  item public.patient_invoice_items;
  invoice public.patient_invoices;
  finding jsonb;
  doctor_id_text text;
  doctor public.user_profiles;
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
    into finding from public.patients as patient where patient.id = invoice.patient_id;
  if finding is null or finding->>'status' <> 'C' then
    raise exception 'The procedure is no longer completed in the clinical chart.' using errcode = '22023';
  end if;
  doctor_id_text := coalesce(finding->>'doctorId', finding->>'doctor_id', '');
  if doctor_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'Assign an active doctor before transferring this procedure.' using errcode = '22023';
  end if;
  select * into doctor from public.user_profiles
    where user_id = doctor_id_text::uuid and active and is_doctor;
  if doctor is null then
    raise exception 'Assign an active doctor before transferring this procedure.' using errcode = '22023';
  end if;
  if exists (select 1 from private.hr_doctor_salary_payment_items where finding_id = item.finding_id) then
    raise exception 'This procedure is already included in a doctor salary expense.' using errcode = '23503';
  end if;

  insert into private.hr_doctor_salary_transfers (finding_id, invoice_item_id, doctor_id, transferred_by)
  values (item.finding_id, item.id, doctor.user_id, auth.uid())
  on conflict (finding_id) do update
    set invoice_item_id = excluded.invoice_item_id,
        doctor_id = excluded.doctor_id,
        transferred_at = now(),
        transferred_by = excluded.transferred_by;
  return true;
end;
$$;

create or replace function private.guard_doctor_salary_invoice_item()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  linked_expense public.expenses;
begin
  select expense.* into linked_expense
  from private.hr_doctor_salary_payment_items as paid
  join public.hr_salary_payments as payment on payment.id = paid.payment_id
  join public.expenses as expense on expense.id = payment.expense_id
  where paid.finding_id = old.finding_id
  limit 1;

  if tg_op = 'DELETE' then
    if linked_expense is not null then
      raise exception 'Delete doctor salary expense "%" (%) before deleting this invoice procedure.', linked_expense.name, linked_expense.id
        using errcode = '23503';
    end if;
    return old;
  end if;

  if (
    new.invoice_id is distinct from old.invoice_id or
    new.finding_id is distinct from old.finding_id or
    new.operation_status is distinct from old.operation_status or
    new.unit_price is distinct from old.unit_price or
    new.quantity is distinct from old.quantity or
    new.doctor_id is distinct from old.doctor_id) then
    if linked_expense is not null then
      raise exception 'Delete doctor salary expense "%" (%) before changing this invoice procedure.', linked_expense.name, linked_expense.id
        using errcode = '23503';
    end if;
    delete from private.hr_doctor_salary_transfers where finding_id = old.finding_id;
  end if;
  return new;
end;
$$;

create trigger guard_doctor_salary_invoice_item
before update or delete on public.patient_invoice_items
for each row execute function private.guard_doctor_salary_invoice_item();

create or replace function private.guard_doctor_salary_invoice()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  linked_expense public.expenses;
begin
  select expense.* into linked_expense
  from public.patient_invoice_items as item
  join private.hr_doctor_salary_payment_items as paid on paid.finding_id = item.finding_id
  join public.hr_salary_payments as payment on payment.id = paid.payment_id
  join public.expenses as expense on expense.id = payment.expense_id
  where item.invoice_id = old.id
  limit 1;
  if linked_expense is not null then
    raise exception 'Delete doctor salary expense "%" (%) before deleting this invoice.', linked_expense.name, linked_expense.id
      using errcode = '23503';
  end if;
  return old;
end;
$$;

create trigger guard_doctor_salary_invoice
before delete on public.patient_invoices
for each row execute function private.guard_doctor_salary_invoice();

-- Lock the invoice item while a salary snapshot is written so a concurrent delete
-- cannot remove its source between payroll selection and settlement.
create or replace function private.guard_doctor_salary_payment_item_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  invoice_item_id bigint;
begin
  select item.id into invoice_item_id
  from private.hr_doctor_salary_transfers as transfer
  join public.patient_invoice_items as item on item.id = transfer.invoice_item_id
  join public.patient_invoices as invoice on invoice.id = item.invoice_id
  where transfer.finding_id = new.finding_id
    and transfer.doctor_id = new.doctor_id
    and item.operation_status = 'C'
    and invoice.patient_id = new.patient_id
    and invoice.status <> 'cancelled'
  for key share of item;
  if invoice_item_id is null then
    raise exception 'This doctor case is no longer completed, invoiced, and transferred.' using errcode = '23503';
  end if;
  return new;
end;
$$;

create trigger guard_doctor_salary_payment_item_insert
before insert on private.hr_doctor_salary_payment_items
for each row execute function private.guard_doctor_salary_payment_item_insert();

revoke all on function public.get_patient_doctor_salary_transfers(uuid) from public, anon;
revoke all on function public.transfer_doctor_salary_invoice_item(bigint) from public, anon;
grant execute on function public.get_patient_doctor_salary_transfers(uuid) to authenticated;
grant execute on function public.transfer_doctor_salary_invoice_item(bigint) to authenticated;

-- Recalculate live unpaid doctor cases from transferred, completed invoice items.
-- A doctor's universal compensation rule applies only when no procedure-specific rule exists.
-- Paid doctor salary items remain immutable snapshots; this changes live unpaid calculations only.

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
language sql
stable
set search_path = ''
as $$
  with parameters as (
    select
      p_start_date as range_start,
      p_end_date + 1 as range_end,
      coalesce((select nullif(btrim(setting.attendance_timezone), '') from public.clinic_settings as setting where setting.id = 1), 'Africa/Cairo') as time_zone
  ),
  raw_findings as (
    select patient.id as patient_id, coalesce(nullif(btrim(patient.name), ''), 'Patient') as patient_name, mouth_finding.value as finding, 1 as source_rank
    from public.patients as patient
    cross join lateral jsonb_array_elements(case when jsonb_typeof(patient.chart_state->'_meta'->'mouthOperations') = 'array' then patient.chart_state->'_meta'->'mouthOperations' else '[]'::jsonb end) as mouth_finding(value)
    union all
    select patient.id, coalesce(nullif(btrim(patient.name), ''), 'Patient'), whole_finding.value, 2
    from public.patients as patient
    cross join lateral jsonb_each(coalesce(patient.chart_state, '{}'::jsonb)) as tooth(key, value)
    cross join lateral jsonb_array_elements(case when jsonb_typeof(tooth.value->'wholeOperations') = 'array' then tooth.value->'wholeOperations' else '[]'::jsonb end) as whole_finding(value)
    where tooth.key <> '_meta'
    union all
    select patient.id, coalesce(nullif(btrim(patient.name), ''), 'Patient'), surface_entry.value, 3
    from public.patients as patient
    cross join lateral jsonb_each(coalesce(patient.chart_state, '{}'::jsonb)) as tooth(key, value)
    cross join lateral jsonb_each(case when jsonb_typeof(tooth.value->'surfaces') = 'object' then tooth.value->'surfaces' else '{}'::jsonb end) as surface_finding(key, value)
    cross join lateral jsonb_array_elements(case jsonb_typeof(surface_finding.value) when 'array' then surface_finding.value when 'object' then jsonb_build_array(surface_finding.value) else '[]'::jsonb end) as surface_entry(value)
    where tooth.key <> '_meta'
  ),
  identified as (
    select
      raw.patient_id,
      raw.patient_name,
      case
        when coalesce(raw.finding->>'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then (raw.finding->>'id')::uuid
        else null
      end as finding_id,
      raw.finding,
      raw.source_rank
    from raw_findings as raw
  ),
  unique_findings as (
    select distinct on (identified.patient_id, identified.finding_id)
      identified.patient_id, identified.patient_name, identified.finding_id, identified.finding
    from identified
    where identified.finding_id is not null
    order by identified.patient_id, identified.finding_id, identified.source_rank
  ),
  parsed as (
    select
      unique_findings.patient_id,
      unique_findings.patient_name,
      unique_findings.finding_id,
      unique_findings.finding,
      case
        when coalesce(unique_findings.finding->>'doctorId', unique_findings.finding->>'doctor_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then coalesce(unique_findings.finding->>'doctorId', unique_findings.finding->>'doctor_id')::uuid
        else null
      end as doctor_id,
      nullif(btrim(coalesce(unique_findings.finding->>'batchId', unique_findings.finding->>'batch_id')), '') as batch_id,
      unique_findings.finding->>'code' as operation_code,
      private.try_parse_timestamptz(coalesce(unique_findings.finding->>'completedAt', unique_findings.finding->>'completed_at', unique_findings.finding->>'createdAt', unique_findings.finding->>'created_at')) as completed_at
    from unique_findings
  ),
  batch_context as (
    select
      parsed.*,
      case when parsed.batch_id is not null then count(*) over (partition by parsed.patient_id, parsed.batch_id, parsed.operation_code) else 1 end as batch_member_count,
      case when parsed.batch_id is not null then row_number() over (partition by parsed.patient_id, parsed.batch_id, parsed.operation_code order by parsed.finding_id) else 1 end as batch_position
    from parsed
  ),
  matched as (
    select
      context.doctor_id,
      profile.full_name as doctor_name,
      context.finding_id,
      context.patient_id,
      context.patient_name,
      context.completed_at,
      operation.id as operation_id,
      operation.code as operation_code,
      operation.name as operation_name,
      context.batch_id,
      context.batch_member_count,
      context.batch_position,
      round(invoice_item.unit_price * invoice_item.quantity, 2) as invoiced_amount,
      case when nullif(btrim(context.finding->>'price'), '') ~ '^[0-9]+([.][0-9]+)?$' then round((context.finding->>'price')::numeric, 2) else operation.price end as base_price,
      case
        when context.batch_id is not null
          and coalesce(context.finding->>'billingMultiplier', context.finding->>'billing_multiplier', '') ~ '^[0-9]+$'
          and coalesce(context.finding->>'billingMultiplier', context.finding->>'billing_multiplier')::numeric between 1 and 999
          then coalesce(context.finding->>'billingMultiplier', context.finding->>'billing_multiplier')::integer
        when context.batch_id is not null then context.batch_member_count::integer
        else 1
      end as billing_multiplier,
      case when rule.value->>'type' = 'fixed' then 'fixed' else 'percentage' end as compensation_type,
      case when coalesce(rule.value->>'amount', rule.value->>'value', '') ~ '^[0-9]+([.][0-9]+)?$' then round(coalesce(rule.value->>'amount', rule.value->>'value')::numeric, 2) else 0 end as compensation_rate
    from batch_context as context
    cross join parameters
    join public.user_profiles as profile on profile.user_id = context.doctor_id and profile.active and profile.is_doctor
    join public.dental_operations as operation on operation.code = context.operation_code
    join public.hr_staff_settings as staff on staff.user_id = context.doctor_id
    join public.patient_invoice_items as invoice_item on invoice_item.finding_id = context.finding_id and invoice_item.operation_status = 'C'
    join public.patient_invoices as invoice on invoice.id = invoice_item.invoice_id and invoice.patient_id = context.patient_id and invoice.status <> 'cancelled'
    join private.hr_doctor_salary_transfers as transfer on transfer.finding_id = context.finding_id and transfer.invoice_item_id = invoice_item.id and transfer.doctor_id = context.doctor_id
    cross join lateral (
      select candidate.value
      from (
        select specific.value, 0 as priority, specific.position
        from jsonb_array_elements(
          case
            when jsonb_typeof(staff.weekly_schedule #> '{doctorCompensation,rules}') = 'array'
              then staff.weekly_schedule #> '{doctorCompensation,rules}'
            else '[]'::jsonb
          end
        ) with ordinality as specific(value, position)
        where coalesce(specific.value->>'procedureId', specific.value->>'procedure_id') = operation.id::text
        union all
        select universal.value, 1, 1::bigint
        from (
          select case
            when jsonb_typeof(staff.weekly_schedule #> '{doctorCompensation,universal}') = 'object'
              then staff.weekly_schedule #> '{doctorCompensation,universal}'
            when jsonb_typeof(staff.weekly_schedule #> '{doctorCompensation,fallback}') = 'object'
              then staff.weekly_schedule #> '{doctorCompensation,fallback}'
            else '{}'::jsonb
          end as value
        ) as universal
        where universal.value->>'enabled' = 'true'
      ) as candidate
      order by candidate.priority, candidate.position
      limit 1
    ) as rule
    where context.finding->>'status' = 'C'
      and context.completed_at is not null
      and (context.completed_at at time zone parameters.time_zone)::date >= parameters.range_start
      and (context.completed_at at time zone parameters.time_zone)::date < parameters.range_end
      and (p_user_id is null or context.doctor_id = p_user_id)
  ),
  valued as (
    select
      matched.*,
      case when matched.batch_id is not null and matched.batch_member_count > 1 then matched.billing_multiplier::numeric / matched.batch_member_count::numeric else 1::numeric end as procedure_quantity,
      round(matched.invoiced_amount, 2) as gross_amount
    from matched
    where matched.invoiced_amount > 0
      and matched.compensation_rate > 0
      and (matched.compensation_type = 'fixed' or matched.compensation_rate <= 100)
  )
  select
    valued.doctor_id,
    valued.doctor_name,
    valued.finding_id,
    valued.patient_id,
    valued.patient_name,
    valued.completed_at,
    valued.operation_id,
    valued.operation_code,
    valued.operation_name,
    valued.procedure_quantity,
    valued.gross_amount,
    valued.compensation_type,
    valued.compensation_rate,
    round(case when valued.compensation_type = 'fixed' then valued.compensation_rate * valued.procedure_quantity else valued.gross_amount * valued.compensation_rate / 100 end, 2)
  from valued;
$$;
