-- Cover settlement snapshot foreign keys and keep modified payroll RPCs off the anonymous API role.

create index if not exists hr_doctor_salary_payment_items_patient_idx
  on private.hr_doctor_salary_payment_items (patient_id);

create index if not exists hr_doctor_salary_payment_items_operation_idx
  on private.hr_doctor_salary_payment_items (operation_id);

revoke all on function public.hr_set_payroll_period_status(date, text) from public, anon;
revoke all on function public.hr_finalize_payroll_period(date) from public, anon;

grant execute on function public.hr_set_payroll_period_status(date, text) to authenticated;
grant execute on function public.hr_finalize_payroll_period(date) to authenticated;

