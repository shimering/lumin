-- Delete expenses through one authorized operation, retaining HR settlement invariants.
create function public.delete_finance_expense(p_expense_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_expense public.expenses;
  v_payment public.hr_salary_payments;
  v_release record;
begin
  if auth.uid() is null or not private.has_finances_access() then
    raise exception 'Finances access is required.' using errcode = '42501';
  end if;
  select * into v_expense from public.expenses where id = p_expense_id for update;
  if v_expense is null then raise exception 'Expense was not found.' using errcode = '22023'; end if;
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
  -- Payment entries cascade; their existing triggers queue reversals in Baytna.
  delete from public.expenses where id = v_expense.id;
  return jsonb_build_object('expense_id', v_expense.id, 'salary_kind', v_payment.payment_kind, 'released_case_count', 0);
end; $$;
revoke all on function public.delete_finance_expense(uuid) from public, anon;
grant execute on function public.delete_finance_expense(uuid) to authenticated;
