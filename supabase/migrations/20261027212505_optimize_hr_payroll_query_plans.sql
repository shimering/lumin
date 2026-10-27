-- These interactive projections operate on a small result set. Their expanded
-- JSON/compensation plans trigger LLVM compilation whose startup cost exceeds
-- the query itself. Scope the setting to these two readers, not the database.
alter function private.hr_doctor_payroll_case_lines(date, date, uuid) set jit = off;
alter function private.clinic_doctor_invoice_lines(date, date, uuid) set jit = off;
