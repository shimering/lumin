-- Keep the existing staff payroll RPC compatible with the new settlement scope columns.

create or replace function private.set_hr_salary_payment_scope()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.payment_kind = 'staff_monthly' then
    new.scope_start := coalesce(new.scope_start, new.pay_month);
    new.scope_end := coalesce(new.scope_end, (new.pay_month + interval '1 month - 1 day')::date);
    new.case_count := coalesce(new.case_count, 0);
  end if;
  return new;
end;
$$;

drop trigger if exists set_hr_salary_payment_scope on public.hr_salary_payments;
create trigger set_hr_salary_payment_scope
before insert or update of payment_kind, pay_month, scope_start, scope_end
on public.hr_salary_payments
for each row execute function private.set_hr_salary_payment_scope();

