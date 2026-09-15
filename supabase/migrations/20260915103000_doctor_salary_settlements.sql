-- Doctor procedure compensation can be settled independently by month, day, or selected cases.
-- Each settlement snapshots its findings so deleting the linked expense safely releases only those cases.

alter table public.hr_salary_payments
  add column if not exists payment_kind text not null default 'staff_monthly',
  add column if not exists scope_start date,
  add column if not exists scope_end date,
  add column if not exists case_count integer not null default 0;

update public.hr_salary_payments as payment
set payment_kind = case when profile.is_doctor then 'doctor_month' else 'staff_monthly' end,
    scope_start = payment.pay_month,
    scope_end = (payment.pay_month + interval '1 month - 1 day')::date,
    case_count = case when profile.is_doctor then payment.attended_shifts else 0 end
from public.user_profiles as profile
where profile.user_id = payment.user_id
  and (payment.scope_start is null or payment.scope_end is null or payment.payment_kind = 'staff_monthly');

alter table public.hr_salary_payments
  alter column scope_start set not null,
  alter column scope_end set not null,
  drop constraint if exists hr_salary_payments_user_id_pay_month_key,
  drop constraint if exists hr_salary_payments_payment_kind_check,
  drop constraint if exists hr_salary_payments_scope_check,
  drop constraint if exists hr_salary_payments_case_count_check;

alter table public.hr_salary_payments
  add constraint hr_salary_payments_payment_kind_check
    check (payment_kind in ('staff_monthly', 'doctor_month', 'doctor_day', 'doctor_cases')),
  add constraint hr_salary_payments_scope_check
    check (
      scope_end >= scope_start
      and scope_end <= scope_start + 365
      and (payment_kind <> 'staff_monthly' or (scope_start = pay_month and scope_end = (pay_month + interval '1 month - 1 day')::date))
      and (payment_kind <> 'doctor_month' or (scope_start = pay_month and scope_end = (pay_month + interval '1 month - 1 day')::date))
      and (payment_kind <> 'doctor_day' or scope_start = scope_end)
    ),
  add constraint hr_salary_payments_case_count_check check (case_count >= 0);

create unique index if not exists hr_salary_payments_staff_month_unique
  on public.hr_salary_payments (user_id, pay_month)
  where payment_kind = 'staff_monthly';

create index if not exists hr_salary_payments_doctor_scope_idx
  on public.hr_salary_payments (user_id, scope_start, scope_end)
  where payment_kind in ('doctor_month', 'doctor_day', 'doctor_cases');

create table if not exists private.hr_doctor_salary_payment_items (
  payment_id uuid not null references public.hr_salary_payments(id) on delete cascade,
  finding_id uuid not null,
  doctor_id uuid not null references public.user_profiles(user_id) on delete restrict,
  doctor_name text not null,
  patient_id uuid not null references public.patients(id) on delete restrict,
  patient_name text not null,
  completed_at timestamptz not null,
  operation_id uuid not null references public.dental_operations(id) on delete restrict,
  operation_code text not null,
  operation_name text not null,
  procedure_quantity numeric(12,2) not null check (procedure_quantity > 0),
  gross_amount numeric(12,2) not null check (gross_amount > 0),
  compensation_type text not null check (compensation_type in ('percentage', 'fixed')),
  compensation_rate numeric(12,2) not null check (compensation_rate > 0),
  salary_amount numeric(12,2) not null check (salary_amount > 0),
  created_at timestamptz not null default now(),
  primary key (payment_id, finding_id),
  unique (finding_id)
);

create index if not exists hr_doctor_salary_payment_items_doctor_completed_idx
  on private.hr_doctor_salary_payment_items (doctor_id, completed_at desc);

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
    cross join lateral jsonb_array_elements(case when jsonb_typeof(staff.weekly_schedule #> '{doctorCompensation,rules}') = 'array' then staff.weekly_schedule #> '{doctorCompensation,rules}' else '[]'::jsonb end) as rule(value)
    where context.finding->>'status' = 'C'
      and context.completed_at is not null
      and (context.completed_at at time zone parameters.time_zone)::date >= parameters.range_start
      and (context.completed_at at time zone parameters.time_zone)::date < parameters.range_end
      and (p_user_id is null or context.doctor_id = p_user_id)
      and coalesce(rule.value->>'procedureId', rule.value->>'procedure_id') = operation.id::text
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

-- Preserve the exact cases represented by historical doctor payments.
with ranked_candidates as (
  select
    payment.id as payment_id,
    line.*,
    row_number() over (partition by payment.id order by line.completed_at, line.finding_id) as finding_rank
  from public.hr_salary_payments as payment
  join public.user_profiles as profile on profile.user_id = payment.user_id and profile.is_doctor
  cross join lateral private.hr_doctor_payroll_case_lines(payment.scope_start, payment.scope_end, payment.user_id) as line
  where payment.payment_kind = 'doctor_month'
    and line.completed_at <= payment.paid_at
),
selected_candidates as (
  select candidate.*
  from ranked_candidates as candidate
  join public.hr_salary_payments as payment on payment.id = candidate.payment_id
  where candidate.finding_rank <= payment.attended_shifts
),
valid_payments as (
  select candidate.payment_id
  from selected_candidates as candidate
  join public.hr_salary_payments as payment on payment.id = candidate.payment_id
  group by candidate.payment_id, payment.attended_shifts, payment.total_amount
  having count(*) = payment.attended_shifts
     and abs(round(sum(candidate.salary_amount), 2) - payment.total_amount) <= 0.01
)
insert into private.hr_doctor_salary_payment_items (
  payment_id, finding_id, doctor_id, doctor_name, patient_id, patient_name, completed_at,
  operation_id, operation_code, operation_name, procedure_quantity, gross_amount,
  compensation_type, compensation_rate, salary_amount
)
select
  candidate.payment_id, candidate.finding_id, candidate.doctor_id, candidate.doctor_name,
  candidate.patient_id, candidate.patient_name, candidate.completed_at, candidate.operation_id,
  candidate.operation_code, candidate.operation_name, candidate.procedure_quantity,
  candidate.gross_amount, candidate.compensation_type, candidate.compensation_rate,
  candidate.salary_amount
from selected_candidates as candidate
join valid_payments as valid on valid.payment_id = candidate.payment_id
on conflict (finding_id) do nothing;

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
  paid_at timestamptz
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
  if p_start_date is null or p_end_date is null or p_end_date < p_start_date or p_end_date > p_start_date + 365 then
    raise exception 'Choose a valid date range of no more than 366 days.' using errcode = '22023';
  end if;

  return query
  with live_unpaid as (
    select line.*
    from private.hr_doctor_payroll_case_lines(p_start_date, p_end_date, p_user_id) as line
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
    unpaid.compensation_rate, unpaid.salary_amount, null::uuid, null::uuid, null::text, null::timestamptz
  from live_unpaid as unpaid
  union all
  select
    paid.doctor_id, paid.doctor_name, paid.finding_id, paid.patient_id, paid.patient_name,
    paid.completed_at, paid.operation_id, paid.operation_code, paid.operation_name,
    paid.procedure_quantity, paid.gross_amount, paid.compensation_type,
    paid.compensation_rate, paid.salary_amount, paid.payment_id, paid.expense_id,
    paid.payment_kind, paid.paid_at
  from paid_snapshots as paid
  order by 6 desc, 3;
end;
$$;

create or replace function public.hr_pay_doctor_procedures(
  p_user_id uuid,
  p_scope text,
  p_start_date date,
  p_end_date date,
  p_finding_ids uuid[] default null
)
returns public.hr_salary_payments
language plpgsql
security definer
set search_path = ''
as $$
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
begin
  if not private.can_manage_hr() then
    raise exception 'HR modify access is required.' using errcode = '42501';
  end if;
  if p_start_date is null or p_end_date is null or p_end_date < p_start_date or p_end_date > p_start_date + 365 then
    raise exception 'Choose a valid date range of no more than 366 days.' using errcode = '22023';
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

  select id into salary_type_id
  from public.expense_types
  where lower(btrim(name)) = 'salary'
  order by active desc, created_at
  limit 1;
  if salary_type_id is null then
    raise exception 'Create the Salary expense type before paying a doctor.' using errcode = '22023';
  end if;

  pay_month_value := date_trunc('month', p_start_date)::date;
  insert into public.hr_payroll_periods (pay_month) values (pay_month_value) on conflict do nothing;

  scope_label := case normalized_scope
    when 'month' then to_char(p_start_date, 'Mon YYYY')
    when 'day' then to_char(p_start_date, 'DD Mon YYYY')
    else selected_count || ' case' || case when selected_count = 1 then '' else 's' end
  end;

  insert into public.expenses (
    expense_type_id, name, total, paid_amount, quantity, expense_date,
    description, confirmed, paid, created_by
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
    auth.uid()
  ) returning id into new_expense_id;

  insert into public.hr_salary_payments (
    user_id, pay_month, attended_shifts, regular_shift_rate, regular_amount,
    extra_amount, performance_amount, total_amount, expense_id, paid_by,
    payment_kind, scope_start, scope_end, case_count
  ) values (
    p_user_id, pay_month_value, selected_count, 0, salary_total,
    0, 0, salary_total, new_expense_id, auth.uid(),
    payment_kind_value, p_start_date, p_end_date, selected_count
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
$$;

create or replace function public.hr_pay_doctor_salary(p_user_id uuid, p_pay_month date)
returns public.hr_salary_payments
language plpgsql
security definer
set search_path = ''
as $$
begin
  return public.hr_pay_doctor_procedures(
    p_user_id,
    'month',
    date_trunc('month', p_pay_month)::date,
    (date_trunc('month', p_pay_month) + interval '1 month - 1 day')::date,
    null
  );
end;
$$;

create or replace function public.delete_doctor_salary_expense(p_expense_id uuid)
returns table (payment_id uuid, released_case_count integer, released_amount numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  payment public.hr_salary_payments;
  item_count integer;
begin
  if not private.can_manage_hr() or not private.has_finances_access() then
    raise exception 'HR modify and Finances access are required.' using errcode = '42501';
  end if;

  select * into payment
  from public.hr_salary_payments
  where expense_id = p_expense_id
    and payment_kind in ('doctor_month', 'doctor_day', 'doctor_cases')
  for update;
  if payment is null then
    raise exception 'Linked doctor salary expense was not found.' using errcode = '22023';
  end if;

  select count(*)::integer into item_count
  from private.hr_doctor_salary_payment_items as item
  where item.payment_id = payment.id;

  delete from public.hr_salary_payments where id = payment.id;
  delete from public.expenses where id = p_expense_id;

  payment_id := payment.id;
  released_case_count := item_count;
  released_amount := payment.total_amount;
  return next;
end;
$$;

create or replace function public.hr_set_payroll_period_status(p_pay_month date, p_status text)
returns public.hr_payroll_periods
language plpgsql
security definer
set search_path = ''
as $$
declare
  month_start date := date_trunc('month', p_pay_month)::date;
  previous_status text;
  result public.hr_payroll_periods;
begin
  if not private.can_manage_hr() then raise exception 'HR modify access is required.' using errcode = '42501'; end if;
  insert into public.hr_payroll_periods (pay_month) values (month_start) on conflict do nothing;
  select status into previous_status from public.hr_payroll_periods where pay_month = month_start for update;
  if p_status not in ('draft', 'reviewed', 'locked') then raise exception 'Unsupported payroll status.' using errcode = '22023'; end if;
  if previous_status = 'paid' then raise exception 'A paid payroll month cannot be reopened.' using errcode = '22023'; end if;
  if previous_status = 'draft' and p_status not in ('draft', 'reviewed') then raise exception 'Review the payroll before locking it.' using errcode = '22023'; end if;
  if previous_status = 'reviewed' and p_status not in ('draft', 'reviewed', 'locked') then raise exception 'Invalid payroll transition.' using errcode = '22023'; end if;
  if previous_status = 'locked' and p_status not in ('reviewed', 'locked') then raise exception 'Unlock to review before returning to draft.' using errcode = '22023'; end if;
  if previous_status = 'locked' and p_status = 'reviewed' and exists (
    select 1 from public.hr_salary_payments
    where pay_month = month_start and payment_kind = 'staff_monthly'
  ) then
    raise exception 'This month already has staff salary payments and cannot be unlocked.' using errcode = '22023';
  end if;
  update public.hr_payroll_periods
  set status = p_status,
      reviewed_at = case when p_status = 'reviewed' then now() else reviewed_at end,
      reviewed_by = case when p_status = 'reviewed' then auth.uid() else reviewed_by end,
      locked_at = case when p_status = 'locked' then now() else null end,
      locked_by = case when p_status = 'locked' then auth.uid() else null end,
      updated_at = now()
  where pay_month = month_start returning * into result;
  return result;
end;
$$;

create or replace function public.hr_finalize_payroll_period(p_pay_month date)
returns public.hr_payroll_periods
language plpgsql
security definer
set search_path = ''
as $$
declare
  month_start date := date_trunc('month', p_pay_month)::date;
  month_end date := (date_trunc('month', p_pay_month) + interval '1 month')::date;
  result public.hr_payroll_periods;
begin
  if not private.can_manage_hr() then
    raise exception 'HR modify access is required.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.hr_payroll_periods where pay_month = month_start and status = 'locked') then
    raise exception 'The payroll month is not locked.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.user_profiles as profile
    join public.hr_staff_settings as staff on staff.user_id = profile.user_id
    where profile.active
      and not profile.is_doctor
      and staff.attendance_enabled
      and greatest(
        (select count(distinct attendance.work_date) * staff.regular_shift_rate
         from public.hr_attendance_sessions as attendance
         where attendance.user_id = profile.user_id
           and attendance.work_date >= month_start
           and attendance.work_date < month_end
           and attendance.check_out_at is not null)
        + coalesce((select sum(extra.shift_count * extra.rate)
                    from public.hr_extra_shifts as extra
                    where extra.user_id = profile.user_id
                      and extra.shift_date >= month_start
                      and extra.shift_date < month_end
                      and extra.approved), 0)
        + coalesce((select sum(case when adjustment.kind = 'bonus' then adjustment.amount else -adjustment.amount end)
                    from public.hr_performance_adjustments as adjustment
                    where adjustment.user_id = profile.user_id
                      and adjustment.adjustment_date >= month_start
                      and adjustment.adjustment_date < month_end), 0),
        0
      ) > 0
      and not exists (
        select 1 from public.hr_salary_payments as payment
        where payment.user_id = profile.user_id
          and payment.pay_month = month_start
          and payment.payment_kind = 'staff_monthly'
      )
  ) then
    raise exception 'Pay every enabled staff salary before closing the month.' using errcode = '22023';
  end if;

  update public.hr_payroll_periods
  set status = 'paid', paid_at = now(), paid_by = auth.uid(), updated_at = now()
  where pay_month = month_start
  returning * into result;
  return result;
end;
$$;

revoke all on function public.get_hr_doctor_payroll_cases(date, date, uuid) from public, anon;
revoke all on function public.hr_pay_doctor_procedures(uuid, text, date, date, uuid[]) from public, anon;
revoke all on function public.hr_pay_doctor_salary(uuid, date) from public, anon;
revoke all on function public.delete_doctor_salary_expense(uuid) from public, anon;

grant execute on function public.get_hr_doctor_payroll_cases(date, date, uuid) to authenticated;
grant execute on function public.hr_pay_doctor_procedures(uuid, text, date, date, uuid[]) to authenticated;
grant execute on function public.hr_pay_doctor_salary(uuid, date) to authenticated;
grant execute on function public.delete_doctor_salary_expense(uuid) to authenticated;
