-- Link staff salary advances to expenses and payment methods with Baytna Finance sync

-- 1. Add payment_method_id and expense_id to hr_salary_advances
ALTER TABLE public.hr_salary_advances
  ADD COLUMN IF NOT EXISTS payment_method_id uuid REFERENCES public.payment_methods(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS expense_id uuid REFERENCES public.expenses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_hr_salary_advances_payment_method ON public.hr_salary_advances(payment_method_id);
CREATE INDEX IF NOT EXISTS idx_hr_salary_advances_expense ON public.hr_salary_advances(expense_id);

-- Drop previous 5-arg overload if exists
DROP FUNCTION IF EXISTS public.save_hr_salary_advance(uuid, uuid, date, numeric, text);

-- 2. Enhanced save_hr_salary_advance with payment method and linked expense creation
CREATE OR REPLACE FUNCTION public.save_hr_salary_advance(
  p_id uuid DEFAULT NULL::uuid,
  p_user_id uuid DEFAULT NULL::uuid,
  p_advance_date date DEFAULT NULL::date,
  p_amount numeric DEFAULT 0,
  p_note text DEFAULT ''::text,
  p_payment_method_id uuid DEFAULT NULL::uuid
)
RETURNS public.hr_salary_advances
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  result public.hr_salary_advances;
  existing_advance public.hr_salary_advances;
  profile public.user_profiles;
  salary_type_id uuid;
  target_expense_id uuid;
  method_record public.payment_methods;
  expense_description text;
begin
  if not (select private.can_manage_hr()) then
    raise exception 'HR modify access is required.' using errcode = '42501';
  end if;
  if auth.uid() is null then
    raise exception 'Sign in to record salary advances.' using errcode = '42501';
  end if;
  if p_user_id is null or p_advance_date is null then
    raise exception 'User and advance date are required.' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Advance amount must be greater than zero.' using errcode = '22023';
  end if;
  if p_payment_method_id is null then
    raise exception 'Choose an active payment method.' using errcode = '22023';
  end if;

  select * into method_record from public.payment_methods where id = p_payment_method_id and active for share;
  if method_record.id is null then
    raise exception 'Choose an active payment method.' using errcode = '22023';
  end if;

  select * into profile from public.user_profiles where user_id = p_user_id and active;
  if profile is null then
    raise exception 'Active staff member was not found.' using errcode = '22023';
  end if;
  if profile.is_doctor then
    raise exception 'Doctor compensation is managed separately.' using errcode = '22023';
  end if;

  perform private.ensure_payroll_month_editable(p_advance_date);

  select id into salary_type_id
  from public.expense_types
  where lower(btrim(name)) = 'salary'
  order by active desc, created_at
  limit 1;

  if salary_type_id is null then
    raise exception 'Create the Salary expense type before recording an advance.' using errcode = '22023';
  end if;

  expense_description := case
    when coalesce(btrim(p_note), '') <> '' then 'Salary advance for ' || profile.full_name || ' · ' || btrim(p_note)
    else 'Salary advance for ' || profile.full_name || ' on ' || to_char(p_advance_date, 'YYYY-MM-DD')
  end;

  if p_id is null then
    -- 1. Create linked expense
    insert into public.expenses (
      expense_type_id,
      name,
      total,
      paid_amount,
      quantity,
      expense_date,
      description,
      confirmed,
      paid,
      created_by,
      sync_payment_method_id
    ) values (
      salary_type_id,
      'Salary Advance — ' || profile.full_name,
      round(p_amount, 2),
      round(p_amount, 2),
      1,
      p_advance_date,
      expense_description,
      true,
      true,
      auth.uid(),
      p_payment_method_id
    ) returning id into target_expense_id;

    -- 2. Insert advance
    insert into public.hr_salary_advances (
      user_id,
      advance_date,
      amount,
      note,
      payment_method_id,
      expense_id,
      created_by
    ) values (
      p_user_id,
      p_advance_date,
      round(p_amount, 2),
      btrim(coalesce(p_note, '')),
      p_payment_method_id,
      target_expense_id,
      auth.uid()
    ) returning * into result;
  else
    select * into existing_advance from public.hr_salary_advances where id = p_id and user_id = p_user_id for update;
    if existing_advance.id is null then
      raise exception 'Salary advance was not found.' using errcode = '22023';
    end if;

    target_expense_id := existing_advance.expense_id;
    if target_expense_id is not null then
      update public.expenses
      set name = 'Salary Advance — ' || profile.full_name,
          total = round(p_amount, 2),
          paid_amount = round(p_amount, 2),
          expense_date = p_advance_date,
          description = expense_description,
          sync_payment_method_id = p_payment_method_id,
          updated_at = now()
      where id = target_expense_id;
    else
      insert into public.expenses (
        expense_type_id, name, total, paid_amount, quantity, expense_date, description, confirmed, paid, created_by, sync_payment_method_id
      ) values (
        salary_type_id, 'Salary Advance — ' || profile.full_name, round(p_amount, 2), round(p_amount, 2), 1, p_advance_date, expense_description, true, true, auth.uid(), p_payment_method_id
      ) returning id into target_expense_id;
    end if;

    update public.hr_salary_advances
    set advance_date = p_advance_date,
        amount = round(p_amount, 2),
        note = btrim(coalesce(p_note, '')),
        payment_method_id = p_payment_method_id,
        expense_id = target_expense_id,
        updated_at = now()
    where id = p_id and user_id = p_user_id
    returning * into result;
  end if;

  return result;
end;
$function$;

-- 3. Enhanced delete_hr_salary_advance to also remove linked expense
CREATE OR REPLACE FUNCTION public.delete_hr_salary_advance(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  v_advance public.hr_salary_advances;
begin
  if not (select private.can_manage_hr()) then
    raise exception 'HR modify access is required.' using errcode = '42501';
  end if;
  select * into v_advance from public.hr_salary_advances where id = p_id for update;
  if v_advance.id is null then
    raise exception 'Salary advance was not found.' using errcode = '22023';
  end if;
  perform private.ensure_payroll_month_editable(v_advance.advance_date);
  delete from public.hr_salary_advances where id = p_id;
  if v_advance.expense_id is not null then
    delete from public.expenses where id = v_advance.expense_id;
  end if;
end;
$function$;

-- 4. Update delete_finance_expense to also clean up linked salary advances
CREATE OR REPLACE FUNCTION public.delete_finance_expense(p_expense_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_expense public.expenses;
  v_payment public.hr_salary_payments;
  v_advance public.hr_salary_advances;
  v_release record;
begin
  if auth.uid() is null or not private.has_finances_access() then
    raise exception 'Finances access is required.' using errcode = '42501';
  end if;
  select * into v_expense from public.expenses where id = p_expense_id for update;
  if v_expense is null then raise exception 'Expense was not found.' using errcode = '22023'; end if;

  -- If linked to regular or doctor monthly/daily/cases salary payment
  select * into v_payment from public.hr_salary_payments where expense_id = v_expense.id for update;
  if v_payment.id is not null then
    if not private.can_manage_hr() then
      raise exception 'HR modify access is required to delete a salary-linked expense.' using errcode = '42501';
    end if;
    if v_payment.payment_kind in ('doctor_month', 'doctor_day', 'doctor_cases') then
      select * into v_release from public.delete_doctor_salary_expense(v_expense.id);
      return jsonb_build_object('expense_id', v_expense.id, 'salary_kind', v_payment.payment_kind, 'released_case_count', v_release.released_case_count);
    end if;
    -- Reopen this staff payment without disturbing the other salaries already paid.
    perform 1 from public.hr_payroll_periods where pay_month = v_payment.pay_month for update;
    delete from public.hr_salary_payments where id = v_payment.id;
    update public.hr_payroll_periods set status = 'locked', paid_at = null, paid_by = null
      where pay_month = v_payment.pay_month and status = 'paid';
  end if;

  -- If linked to an HR salary advance
  select * into v_advance from public.hr_salary_advances where expense_id = v_expense.id for update;
  if v_advance.id is not null then
    if not private.can_manage_hr() then
      raise exception 'HR modify access is required to delete a salary-linked expense.' using errcode = '42501';
    end if;
    perform private.ensure_payroll_month_editable(v_advance.advance_date);
    delete from public.hr_salary_advances where id = v_advance.id;
  end if;

  -- Payment entries cascade; their existing triggers queue reversals in Baytna.
  delete from public.expenses where id = v_expense.id;
  return jsonb_build_object('expense_id', v_expense.id, 'salary_kind', coalesce(v_payment.payment_kind, 'salary_advance'), 'released_case_count', 0);
end; $$;

REVOKE ALL ON FUNCTION public.save_hr_salary_advance(uuid, uuid, date, numeric, text, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.save_hr_salary_advance(uuid, uuid, date, numeric, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.delete_hr_salary_advance(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.delete_hr_salary_advance(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.delete_finance_expense(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.delete_finance_expense(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
