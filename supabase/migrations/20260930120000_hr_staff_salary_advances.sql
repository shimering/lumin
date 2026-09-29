-- Add staff salary advances table, RPCs, and deductions from staff salary calculation

CREATE TABLE IF NOT EXISTS public.hr_salary_advances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  advance_date date NOT NULL,
  amount numeric(12, 2) NOT NULL CHECK (amount > 0),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_salary_advances_user_date ON public.hr_salary_advances(user_id, advance_date);

ALTER TABLE public.hr_salary_advances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hr_salary_advances_read ON public.hr_salary_advances;
CREATE POLICY hr_salary_advances_read ON public.hr_salary_advances
FOR SELECT TO authenticated
USING (user_id = (SELECT auth.uid()) OR (SELECT private.has_hr_access()));

ALTER TABLE public.hr_salary_payments
ADD COLUMN IF NOT EXISTS advance_amount numeric(12, 2) NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.save_hr_salary_advance(
  p_id uuid DEFAULT NULL::uuid,
  p_user_id uuid DEFAULT NULL::uuid,
  p_advance_date date DEFAULT NULL::date,
  p_amount numeric DEFAULT 0,
  p_note text DEFAULT ''::text
)
RETURNS public.hr_salary_advances
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  result public.hr_salary_advances;
begin
  if not (select private.can_manage_hr()) then
    raise exception 'HR modify access is required.' using errcode = '42501';
  end if;
  if p_user_id is null or p_advance_date is null then
    raise exception 'User and advance date are required.' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Advance amount must be greater than zero.' using errcode = '22023';
  end if;
  if exists (select 1 from public.user_profiles where user_id = p_user_id and is_doctor) then
    raise exception 'Doctor compensation is managed separately.' using errcode = '22023';
  end if;
  perform private.ensure_payroll_month_editable(p_advance_date);

  if p_id is null then
    insert into public.hr_salary_advances (user_id, advance_date, amount, note, created_by)
    values (p_user_id, p_advance_date, round(p_amount, 2), btrim(coalesce(p_note, '')), (select auth.uid()))
    returning * into result;
  else
    update public.hr_salary_advances
    set advance_date = p_advance_date,
        amount = round(p_amount, 2),
        note = btrim(coalesce(p_note, '')),
        updated_at = now()
    where id = p_id and user_id = p_user_id
    returning * into result;
    if result is null then
      raise exception 'Salary advance was not found.' using errcode = '22023';
    end if;
  end if;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.delete_hr_salary_advance(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  record_date date;
begin
  if not (select private.can_manage_hr()) then
    raise exception 'HR modify access is required.' using errcode = '42501';
  end if;
  select advance_date into record_date from public.hr_salary_advances where id = p_id;
  if record_date is null then
    raise exception 'Salary advance was not found.' using errcode = '22023';
  end if;
  perform private.ensure_payroll_month_editable(record_date);
  delete from public.hr_salary_advances where id = p_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.hr_pay_salary_with_method(
  p_user_id uuid,
  p_pay_month date,
  p_payment_method_id uuid,
  p_expected_amount numeric
)
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
  advance_total numeric(12, 2);
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
  select round(coalesce(sum(amount), 0), 2) into advance_total
  from public.hr_salary_advances where user_id = p_user_id and advance_date >= month_start and advance_date < month_end;

  salary_total := round(regular_total + extra_total + performance_total - advance_total, 2);
  if salary_total <= 0 then raise exception 'The calculated salary is zero or negative.' using errcode = '22023'; end if;

  if p_expected_amount is null or p_expected_amount <> salary_total then
    raise exception 'The calculated salary changed. Close this dialog and refresh HR before paying.' using errcode = '22023';
  end if;
  select id into salary_type_id from public.expense_types where lower(btrim(name)) = 'salary' order by active desc, created_at limit 1;
  if salary_type_id is null then raise exception 'Create the Salary expense type before paying payroll.' using errcode = '22023'; end if;

  insert into public.expenses (expense_type_id, name, total, paid_amount, quantity, expense_date, description, confirmed, paid, created_by, sync_payment_method_id)
  values (salary_type_id, 'Salary — ' || profile.full_name || ' — ' || to_char(month_start, 'Mon YYYY'), salary_total, salary_total, 1, current_date,
    'Linked HR payroll for ' || to_char(month_start, 'Month YYYY'), true, true, (select auth.uid()), p_payment_method_id)
  returning id into new_expense_id;

  insert into public.hr_salary_payments (user_id, pay_month, attended_shifts, regular_shift_rate, regular_amount, extra_amount, performance_amount, advance_amount, total_amount, expense_id, paid_by)
  values (p_user_id, month_start, attended_count, staff.regular_shift_rate, regular_total, extra_total, performance_total, advance_total, salary_total, new_expense_id, (select auth.uid()))
  returning * into result;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.hr_finalize_payroll_period(p_pay_month date)
RETURNS public.hr_payroll_periods
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
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
                      and adjustment.adjustment_date < month_end), 0)
        - coalesce((select sum(adv.amount)
                    from public.hr_salary_advances as adv
                    where adv.user_id = profile.user_id
                      and adv.advance_date >= month_start
                      and adv.advance_date < month_end), 0),
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
$function$;

REVOKE ALL ON FUNCTION public.save_hr_salary_advance(uuid, uuid, date, numeric, text) FROM public, anon;
REVOKE ALL ON FUNCTION public.delete_hr_salary_advance(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.save_hr_salary_advance(uuid, uuid, date, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_hr_salary_advance(uuid) TO authenticated;
GRANT SELECT ON public.hr_salary_advances TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'hr_salary_advances'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.hr_salary_advances;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
