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
      case
        when matched.batch_id is not null and matched.batch_member_count > 1 then
          case
            when matched.batch_position = matched.batch_member_count
              then round(matched.base_price * matched.billing_multiplier, 2)
                - round(round(matched.base_price * matched.billing_multiplier, 2) / matched.batch_member_count, 2) * (matched.batch_member_count - 1)
            else round(round(matched.base_price * matched.billing_multiplier, 2) / matched.batch_member_count, 2)
          end
        else round(matched.base_price, 2)
      end as gross_amount
    from matched
    where matched.base_price > 0
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

-- Keep the legacy month summary aligned with the case-level payroll source of truth.
create or replace function private.hr_doctor_payroll_lines(
  p_pay_month date,
  p_user_id uuid default null
)
returns table (
  doctor_id uuid,
  doctor_name text,
  finding_id uuid,
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
  select
    line.doctor_id,
    line.doctor_name,
    line.finding_id,
    line.operation_id,
    line.operation_code,
    line.operation_name,
    line.procedure_quantity,
    line.gross_amount,
    line.compensation_type,
    line.compensation_rate,
    line.salary_amount
  from private.hr_doctor_payroll_case_lines(
    date_trunc('month', p_pay_month)::date,
    (date_trunc('month', p_pay_month) + interval '1 month - 1 day')::date,
    p_user_id
  ) as line;
$$;
