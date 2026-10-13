create schema private; create schema auth; create role anon; create role authenticated;
create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
create function private.has_hr_access() returns boolean language sql as $$select current_setting('test.access',true) in ('hr','admin')$$;
create function private.has_finances_access() returns boolean language sql as $$select current_setting('test.access',true) in ('finance','admin')$$;
create function private.has_analytics_access() returns boolean language sql as $$select current_setting('test.access',true) in ('analytics','admin')$$;
create function private.is_admin() returns boolean language sql as $$select current_setting('test.access',true)='admin'$$;
create function private.has_page_permission(text) returns boolean language sql as $$select current_setting('test.access',true)='admin'$$;
create table public.clinic_settings(id integer,attendance_timezone text);
create table public.user_profiles(user_id uuid primary key,full_name text,active boolean,is_doctor boolean);
create table public.patients(id uuid primary key,name text,chart_state jsonb);
create table public.patient_invoices(id bigint primary key,patient_id uuid,status text);
create table public.patient_invoice_items(id bigint primary key,invoice_id bigint,finding_id uuid,operation_id uuid,operation_code text,operation_status text,unit_price numeric,quantity numeric,doctor_id uuid,appointment_id uuid);
create table public.appointments(id uuid,patient_id uuid,status text,appointment_at timestamptz);
create table public.dental_operations(id uuid,code text,name text);
create table public.hr_staff_settings(user_id uuid,weekly_schedule jsonb);
create table private.hr_doctor_salary_transfers(finding_id uuid,invoice_item_id bigint,doctor_id uuid,assignment_mode text,allocations jsonb,assignment_signature jsonb);
create table private.hr_doctor_salary_payment_items(finding_id uuid,doctor_id uuid,salary_amount numeric,payment_id uuid);
create table public.invoice_payments(payment_date date,amount numeric);
create table public.expense_types(id uuid,name text);
create table public.expenses(id uuid,expense_date date,paid_amount numeric,total numeric,paid boolean,expense_type_id uuid);
create table public.expense_payment_entries(expense_id uuid,payment_date date,amount numeric);
create function public.get_finance_debt_page(p_page integer default 1,p_page_size integer default 10) returns jsonb language sql as $$select '{"remaining_total":126000,"total_count":34}'::jsonb$$;
create function private.chart_finding_by_id(state jsonb,id uuid) returns jsonb language sql as $$select state->id::text$$;
create function private.try_parse_timestamptz(text) returns timestamptz language sql as $$select $1::timestamptz$$;
create function private.doctor_salary_assignment_is_complete(jsonb) returns boolean language sql as $$select $1->>'status'='C' and ($1->>'doctorId' is not null or jsonb_array_length($1->'steps')>0)$$;
create function private.doctor_salary_assignment_signature(jsonb) returns jsonb language sql as $$select $1$$;
insert into clinic_settings values(1,'Africa/Cairo');
insert into user_profiles values('00000000-0000-4000-8000-000000000001','Dr A',true,true),('00000000-0000-4000-8000-000000000002','Dr B',true,true);
insert into dental_operations values('00000000-0000-4000-8000-000000000003','composite','Composite'),('00000000-0000-4000-8000-000000000004','dz_diagnosis_a1','Diagnosis');
insert into hr_staff_settings values('00000000-0000-4000-8000-000000000001','{"doctorCompensation":{"universal":{"enabled":true,"type":"percentage","amount":30}}}'),('00000000-0000-4000-8000-000000000002','{"doctorCompensation":{"universal":{"enabled":true,"type":"fixed","amount":100}}}');
insert into patients values('00000000-0000-4000-8000-000000000010','Patient A','{
  "00000000-0000-4000-8000-000000000011":{"status":"C","doctorId":"00000000-0000-4000-8000-000000000001","completedAt":"2026-10-13T10:00:00Z","tooth":"36"},
  "00000000-0000-4000-8000-000000000012":{"status":"C","doctorId":"00000000-0000-4000-8000-000000000001","completedAt":"2026-10-13T10:00:00Z","tooth":"14"},
  "00000000-0000-4000-8000-000000000013":{"status":"C","completedAt":"2026-10-13T10:00:00Z","steps":[{"payrollFindingId":"00000000-0000-4000-8000-000000000014","doctorId":"00000000-0000-4000-8000-000000000001","percentage":33.33,"name":"Preparation"},{"payrollFindingId":"00000000-0000-4000-8000-000000000015","doctorId":"00000000-0000-4000-8000-000000000002","percentage":66.67,"name":"Final"}]},
  "00000000-0000-4000-8000-000000000016":{"status":"C","doctorId":"00000000-0000-4000-8000-000000000001","completedAt":"2026-10-12T21:30:00Z"}
}');
insert into patient_invoices values(1,'00000000-0000-4000-8000-000000000010','unpaid'),(2,'00000000-0000-4000-8000-000000000010','unpaid'),(3,'00000000-0000-4000-8000-000000000010','unpaid'),(4,'00000000-0000-4000-8000-000000000010','cancelled'),(5,'00000000-0000-4000-8000-000000000010','unpaid');
insert into patient_invoice_items values
  (11,1,'00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000003','composite','C',3000,1,null,null),
  (12,2,'00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000003','composite','C',1200,1,null,null),
  (13,3,'00000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-000000000003','composite','C',1000,2,null,null),
  (14,4,'00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000003','composite','C',9000,1,null,null),
  (16,5,'00000000-0000-4000-8000-000000000016','00000000-0000-4000-8000-000000000003','composite','C',600,1,null,null);
insert into private.hr_doctor_salary_transfers select '00000000-0000-4000-8000-000000000011',11,'00000000-0000-4000-8000-000000000001','whole','[{"finding_id":"00000000-0000-4000-8000-000000000011","doctor_id":"00000000-0000-4000-8000-000000000001","percentage":100}]',chart_state->'00000000-0000-4000-8000-000000000011' from patients;
insert into invoice_payments values('2026-10-01',150),('2026-10-02',75);
insert into expense_types values('00000000-0000-4000-8000-000000000020','Materials');
insert into expenses values('00000000-0000-4000-8000-000000000021','2026-09-01',70,100,false,'00000000-0000-4000-8000-000000000020'),('00000000-0000-4000-8000-000000000022','2026-10-02',25,25,true,'00000000-0000-4000-8000-000000000020');
insert into expense_payment_entries values('00000000-0000-4000-8000-000000000021','2026-09-01',50),('00000000-0000-4000-8000-000000000021','2026-10-02',20);
select set_config('test.actor','00000000-0000-4000-8000-000000000001',false),set_config('test.access','admin',false);
