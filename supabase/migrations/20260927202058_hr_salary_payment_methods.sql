-- Record the chosen method on the salary expense before its sync trigger runs.
-- Existing payroll RPCs remain compatible with older clients.

CREATE OR REPLACE FUNCTION public.hr_pay_salary_with_method(p_user_id uuid, p_pay_month date, p_payment_method_id uuid, p_expected_amount numeric)
 RETURNS public.hr_salary_payments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  month_start date := date_trunc('month', p_pay_month)::date;
  month_end date := (date_trunc('month', p_pay_month) + interval '1 month')::date;
  staff public.hr_staff_settings;
  profile public.user_profiles;
  period public.hr_payroll_periods;
  attended_count integer;
  regular_total numeric(12, 2);
  extra_total numeric(12, 2);
  performance_total numeric(12, 2);
  salary_total numeric(12, 2);
  salary_type_id uuid;
  new_expense_id uuid;
  result public.hr_salary_payments;
begin
  if not (select private.can_manage_hr()) then raise exception 'HR modify access is required.' using errcode = '42501'; end if;

  if auth.uid() is null then
    raise exception 'Sign in to pay salaries.' using errcode = '42501';
  end if;
  perform 1 from public.payment_methods where id = p_payment_method_id and active for share;
  if not found then
    raise exception 'Choose an active payment method.' using errcode = '22023';
  end if;
  select * into period from public.hr_payroll_periods where pay_month = month_start for update;
  if period is null or period.status <> 'locked' then raise exception 'Lock the payroll month before paying salaries.' using errcode = '22023'; end if;
  if exists (select 1 from public.hr_salary_payments where user_id = p_user_id and pay_month = month_start) then
    raise exception 'This salary has already been paid.' using errcode = '23505';
  end if;
  select * into profile from public.user_profiles where user_id = p_user_id and active;
  if profile is null then raise exception 'Active staff member was not found.' using errcode = '22023'; end if;
  if profile.is_doctor then raise exception 'Doctor compensation is managed separately.' using errcode = '22023'; end if;
  select * into staff from public.hr_staff_settings where user_id = p_user_id;
  if staff is null then raise exception 'Staff payroll settings were not found.' using errcode = '22023'; end if;

  select count(distinct work_date)::integer into attended_count
  from public.hr_attendance_sessions
  where user_id = p_user_id and work_date >= month_start and work_date < month_end and check_out_at is not null;
  regular_total := round(attended_count * staff.regular_shift_rate, 2);
  select round(coalesce(sum(shift_count * rate), 0), 2) into extra_total
  from public.hr_extra_shifts where user_id = p_user_id and shift_date >= month_start and shift_date < month_end and approved;
  select round(coalesce(sum(case when kind = 'bonus' then amount else -amount end), 0), 2) into performance_total
  from public.hr_performance_adjustments where user_id = p_user_id and adjustment_date >= month_start and adjustment_date < month_end;
  salary_total := round(greatest(regular_total + extra_total + performance_total, 0), 2);
  if salary_total <= 0 then raise exception 'The calculated salary is zero.' using errcode = '22023'; end if;

  if p_expected_amount is null or p_expected_amount <> salary_total then
    raise exception 'The calculated salary changed. Close this dialog and refresh HR before paying.' using errcode = '22023';
  end if;
  select id into salary_type_id from public.expense_types where lower(btrim(name)) = 'salary' order by active desc, created_at limit 1;
  if salary_type_id is null then raise exception 'Create the Salary expense type before paying payroll.' using errcode = '22023'; end if;

  insert into public.expenses (expense_type_id, name, total, paid_amount, quantity, expense_date, description, confirmed, paid, created_by, sync_payment_method_id)
  values (salary_type_id, 'Salary — ' || profile.full_name || ' — ' || to_char(month_start, 'Mon YYYY'), salary_total, salary_total, 1, current_date,
    'Linked HR payroll for ' || to_char(month_start, 'Month YYYY'), true, true, (select auth.uid()), p_payment_method_id)
  returning id into new_expense_id;

  insert into public.hr_salary_payments (user_id, pay_month, attended_shifts, regular_shift_rate, regular_amount, extra_amount, performance_amount, total_amount, expense_id, paid_by)
  values (p_user_id, month_start, attended_count, staff.regular_shift_rate, regular_total, extra_total, performance_total, salary_total, new_expense_id, (select auth.uid()))
  returning * into result;
  return result;
end;
$function$
;

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

  pay_month_value := date_trunc('month', p_start_date)::date;
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
$function$
;

-- HR receives only active methods and their destination labels, never integration credentials.
create function public.get_hr_salary_payment_methods()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare settings public.finance_sync_settings;
begin
  if auth.uid() is null or not private.can_manage_hr() then
    raise exception 'HR modify access is required.' using errcode = '42501';
  end if;
  select * into settings from public.finance_sync_settings where id;
  return jsonb_build_object(
    'enabled', coalesce(settings.enabled, false),
    'sync_expenses', coalesce(settings.sync_expenses, false),
    'methods', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', method.id, 'name', method.name,
        'account_id', settings.payment_routes->>method.id::text,
        'account_name', account.value->>'name',
        'account_name_ar', account.value->>'name_ar'
      ) order by method.sort_order, method.name)
      from public.payment_methods method
      left join lateral (
        select value from jsonb_array_elements(settings.accounts)
        where value->>'id' = settings.payment_routes->>method.id::text
        limit 1
      ) account on true
      where method.active
    ), '[]'::jsonb)
  );
end; $$;

revoke all on function public.hr_pay_salary_with_method(uuid,date,uuid,numeric) from public, anon;
revoke all on function public.hr_pay_doctor_procedures_with_method(uuid,text,date,date,uuid[],uuid,numeric) from public, anon;
revoke all on function public.get_hr_salary_payment_methods() from public, anon;
grant execute on function public.hr_pay_salary_with_method(uuid,date,uuid,numeric) to authenticated;
grant execute on function public.hr_pay_doctor_procedures_with_method(uuid,text,date,date,uuid[],uuid,numeric) to authenticated;
grant execute on function public.get_hr_salary_payment_methods() to authenticated;

-- One confirmation pays the reviewed staff list atomically; any changed salary rolls back the batch.
create function public.hr_pay_staff_batch_with_method(p_pay_month date, p_payment_method_id uuid, p_salaries jsonb)
returns integer language plpgsql security invoker set search_path = '' as $$
declare salary jsonb; paid_count integer := 0;
begin
  if jsonb_typeof(p_salaries) is distinct from 'array' or jsonb_array_length(p_salaries) = 0 then
    raise exception 'Choose at least one staff salary.' using errcode = '22023';
  end if;
  if (select count(distinct value->>'user_id') from jsonb_array_elements(p_salaries)) <> jsonb_array_length(p_salaries) then
    raise exception 'The staff salary list contains missing or duplicate staff members.' using errcode = '22023';
  end if;
  for salary in select value from jsonb_array_elements(p_salaries) loop
    perform public.hr_pay_salary_with_method((salary->>'user_id')::uuid, p_pay_month, p_payment_method_id, (salary->>'expected_amount')::numeric);
    paid_count := paid_count + 1;
  end loop;
  perform public.hr_finalize_payroll_period(p_pay_month);
  return paid_count;
end; $$;
revoke all on function public.hr_pay_staff_batch_with_method(date,uuid,jsonb) from public, anon;
grant execute on function public.hr_pay_staff_batch_with_method(date,uuid,jsonb) to authenticated;

notify pgrst, 'reload schema';
