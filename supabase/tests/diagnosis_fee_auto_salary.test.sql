-- Every fixture and salary settlement rolls back inside this block, including
-- finance delivery events. This can also run atomically after the migration.
do $test$
declare
  actor uuid; doctor_a uuid; doctor_b uuid; patient uuid := gen_random_uuid();
  completed_appointment uuid := gen_random_uuid(); scheduled_appointment uuid := gen_random_uuid();
  unassigned_appointment uuid := gen_random_uuid(); finding uuid := gen_random_uuid();
  diagnosis_operation public.dental_operations; fee record; deferred_fee record; regular_item bigint;
  payment public.hr_salary_payments; method uuid; line record; transfer_time timestamptz;
begin
  begin
    select profile.user_id into actor from public.user_profiles profile
    join public.access_roles role on role.id = profile.role_id where profile.active and role.is_admin limit 1;
    select user_id into doctor_a from public.user_profiles where active and is_doctor order by user_id limit 1;
    select user_id into doctor_b from public.user_profiles where active and is_doctor and user_id <> doctor_a order by user_id limit 1;
    select * into diagnosis_operation from public.dental_operations where code = 'dz_diagnosis_a1';
    select id into method from public.payment_methods where active order by id limit 1;
    if actor is null or doctor_a is null or doctor_b is null or diagnosis_operation.id is null or method is null then
      raise exception 'Admin, two active doctors, Diagnosis operation and active payment method are required';
    end if;
    perform set_config('request.jwt.claim.sub', actor::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', actor, 'role', 'authenticated')::text, true);
    update public.finance_sync_settings set enabled = false where id;
    insert into public.hr_staff_settings(user_id) values (doctor_a), (doctor_b) on conflict do nothing;
    update public.hr_staff_settings set weekly_schedule = jsonb_set(coalesce(weekly_schedule, '{}'::jsonb),
      '{doctorCompensation}', jsonb_build_object('rules', jsonb_build_array(jsonb_build_object(
        'procedureId', diagnosis_operation.id, 'type', 'percentage', 'amount', 25)))) where user_id = doctor_a;
    update public.hr_staff_settings set weekly_schedule = jsonb_set(coalesce(weekly_schedule, '{}'::jsonb),
      '{doctorCompensation}', jsonb_build_object('rules', jsonb_build_array(jsonb_build_object(
        'procedureId', diagnosis_operation.id, 'type', 'fixed', 'amount', 75)))) where user_id = doctor_b;

    insert into public.patients(id, name, phone, chart_state) values (patient, 'Rollback diagnosis salary test',
      patient::text, jsonb_build_object('_meta', jsonb_build_object('mouthOperations', jsonb_build_array(
        jsonb_build_object('id', finding, 'code', diagnosis_operation.code, 'status', 'C',
          'price', 1000, 'doctorId', doctor_a, 'completedAt', '2099-01-15T12:00:00Z')))));
    insert into public.appointments(id, patient_id, appointment_at, status) values
      (completed_appointment, patient, '2099-01-15T12:00:00Z', 'Completed'),
      (scheduled_appointment, patient, '2099-01-15T13:00:00Z', 'Scheduled'),
      (unassigned_appointment, patient, '2099-01-15T14:00:00Z', 'Completed');
    select * into fee from public.add_assigned_diagnosis_fee_to_patient_invoice(completed_appointment, 400, doctor_a);
    if (select transfer_status from public.get_diagnosis_fee_salary_state(completed_appointment)) is distinct from 'transferred'
      or (select transfer_status from public.get_patient_doctor_salary_transfers(patient) where invoice_item_id = fee.item_id) is distinct from 'transferred' then
      raise exception 'Completed diagnosis fee was not automatically transferred';
    end if;
    select * into line from private.hr_doctor_payroll_case_lines('2099-01-01', '2099-01-31', doctor_a) where finding_id = completed_appointment;
    if line.salary_amount is distinct from 100::numeric or line.gross_amount is distinct from 400::numeric then
      raise exception 'Diagnosis percentage compensation is incorrect';
    end if;
    select transferred_at into transfer_time from private.hr_doctor_salary_transfers where invoice_item_id = fee.item_id;
    perform public.add_assigned_diagnosis_fee_to_patient_invoice(completed_appointment, 400, doctor_a);
    perform private.sync_diagnosis_fee_salary_transfer(fee.item_id);
    if (select count(*) from private.hr_doctor_salary_transfers where invoice_item_id = fee.item_id) <> 1
      or (select transferred_at from private.hr_doctor_salary_transfers where invoice_item_id = fee.item_id) is distinct from transfer_time
      or (select count(*) from private.hr_doctor_payroll_case_lines('2099-01-01', '2099-01-31', doctor_a) where finding_id = completed_appointment) <> 1 then
      raise exception 'Repeat saves or backfill duplicated a diagnosis salary case';
    end if;

    select * into deferred_fee from public.add_assigned_diagnosis_fee_to_patient_invoice(scheduled_appointment, 300, doctor_a);
    if exists(select 1 from private.hr_doctor_salary_transfers where invoice_item_id = deferred_fee.item_id) then
      raise exception 'Scheduled appointment entered payroll';
    end if;
    update public.appointments set status = 'Completed' where id = scheduled_appointment;
    if (select salary_amount from private.hr_doctor_payroll_case_lines('2099-01-01', '2099-01-31', doctor_a) where finding_id = scheduled_appointment) is distinct from 75::numeric then
      raise exception 'Appointment completion did not automatically transfer its fee';
    end if;
    update public.patient_invoice_items set unit_price = 360 where id = deferred_fee.item_id;
    if (select salary_amount from private.hr_doctor_payroll_case_lines('2099-01-01', '2099-01-31', doctor_a) where finding_id = scheduled_appointment) is distinct from 90::numeric then
      raise exception 'Fee price change lost its automatic transfer';
    end if;
    perform public.add_assigned_diagnosis_fee_to_patient_invoice(scheduled_appointment, 360, doctor_b);
    if exists(select 1 from private.hr_doctor_payroll_case_lines('2099-01-01', '2099-01-31', doctor_a) where finding_id = scheduled_appointment)
      or (select salary_amount from private.hr_doctor_payroll_case_lines('2099-01-01', '2099-01-31', doctor_b) where finding_id = scheduled_appointment) is distinct from 75::numeric then
      raise exception 'Reassignment did not move the fee to the new doctor using fixed compensation';
    end if;
    update public.appointments set status = 'Scheduled' where id = scheduled_appointment;
    if exists(select 1 from private.hr_doctor_payroll_case_lines('2099-01-01', '2099-01-31', doctor_b) where finding_id = scheduled_appointment) then
      raise exception 'Reopened appointment remained payable';
    end if;
    update public.appointments set status = 'Completed' where id = scheduled_appointment;
    update public.patient_invoices set status = 'cancelled' where id = fee.invoice_id;
    if exists(select 1 from private.hr_doctor_payroll_case_lines('2099-01-01', '2099-01-31', null) where patient_id = patient) then
      raise exception 'Cancelled invoice remained payable';
    end if;
    update public.patient_invoices set status = 'unpaid' where id = fee.invoice_id;
    if (select count(*) from private.hr_doctor_payroll_case_lines('2099-01-01', '2099-01-31', null) where patient_id = patient) <> 2 then
      raise exception 'Restored invoice lost its automatic diagnosis transfers';
    end if;
    delete from private.hr_doctor_salary_transfers where invoice_item_id = deferred_fee.item_id;
    update public.user_profiles set active = false where user_id = doctor_b;
    update public.user_profiles set active = true where user_id = doctor_b;
    if (select transfer_status from public.get_diagnosis_fee_salary_state(scheduled_appointment)) is distinct from 'transferred' then
      raise exception 'Doctor reactivation did not include the diagnosis fee';
    end if;
    perform public.add_diagnosis_fee_to_patient_invoice(unassigned_appointment, 200);
    if exists(select 1 from private.hr_doctor_payroll_case_lines('2099-01-01', '2099-01-31', null) where finding_id = unassigned_appointment) then
      raise exception 'Unassigned diagnosis fee entered payroll';
    end if;

    insert into public.patient_invoice_items(invoice_id, finding_id, operation_id, operation_code, operation_name,
      operation_status, unit_price, quantity, doctor_id) values (fee.invoice_id, finding, diagnosis_operation.id,
      diagnosis_operation.code, 'Regular chart procedure', 'C', 1000, 1, doctor_a) returning id into regular_item;
    if exists(select 1 from private.hr_doctor_salary_transfers where invoice_item_id = regular_item)
      or (select transfer_status from public.get_patient_doctor_salary_transfers(patient) where invoice_item_id = regular_item) is distinct from 'eligible' then
      raise exception 'Ordinary chart procedure was transferred automatically';
    end if;
    perform public.transfer_doctor_salary_invoice_item(regular_item);
    if (select salary_amount from private.hr_doctor_payroll_case_lines('2099-01-01', '2099-01-31', doctor_a) where finding_id = finding) is distinct from 250::numeric then
      raise exception 'Manual transfer stopped working for ordinary procedures';
    end if;

    payment := public.hr_pay_doctor_procedures_with_method(doctor_a, 'cases', '2099-01-01', '2099-01-31',
      array[completed_appointment], method, 100);
    if (select transfer_status from public.get_diagnosis_fee_salary_state(completed_appointment)) is distinct from 'paid' then
      raise exception 'Automatically transferred diagnosis could not be settled';
    end if;
    perform private.sync_diagnosis_fee_salary_transfer(fee.item_id);
    begin
      perform public.hr_pay_doctor_procedures_with_method(doctor_a, 'cases', '2099-01-01', '2099-01-31', array[completed_appointment], method, 100);
      raise exception 'Duplicate salary payment accepted';
    exception when invalid_parameter_value or unique_violation then null; end;
    begin
      perform public.add_assigned_diagnosis_fee_to_patient_invoice(completed_appointment, 400, doctor_b);
      raise exception 'Paid diagnosis fee could be reassigned';
    exception when foreign_key_violation then null; end;
    begin
      update public.appointments set status = 'Scheduled' where id = completed_appointment;
      raise exception 'Paid diagnosis appointment could be reopened';
    exception when foreign_key_violation then null; end;
    begin
      delete from public.patient_invoice_items where id = fee.item_id;
      raise exception 'Paid diagnosis invoice item could be deleted';
    exception when foreign_key_violation then null; end;
    if has_function_privilege('authenticated', 'private.sync_diagnosis_fee_salary_transfer(bigint)', 'execute')
      or has_function_privilege('anon', 'private.auto_transfer_diagnosis_fee_salary()', 'execute') then
      raise exception 'Automatic transfer helpers are exposed';
    end if;
    raise exception using errcode = 'ZX001', message = 'Rollback successful diagnosis salary tests';
  exception when sqlstate 'ZX001' then null;
  end;
end;
$test$;
