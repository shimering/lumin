-- Diagnosis fees enter payroll automatically once completed, invoiced and
-- assigned. Keep the existing transfer ledger and settlement guards; ordinary
-- chart procedures still require an explicit invoice transfer.
create or replace function private.sync_diagnosis_fee_salary_transfer(p_item_id bigint)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  -- Serialize a fee save with completion of its appointment, including fees
  -- inserted while another session is completing the appointment.
  perform 1 from public.appointments as appointment
  join public.patient_invoice_items as item on item.appointment_id = appointment.id
  where item.id = p_item_id and item.operation_code = 'diagnosis_fee'
  for share of appointment;

  insert into private.hr_doctor_salary_transfers as transfer
    (finding_id, invoice_item_id, doctor_id, assignment_mode, allocations,
      assignment_signature, transferred_by)
  select item.finding_id, item.id, item.doctor_id, 'whole',
    jsonb_build_array(jsonb_build_object('finding_id', item.finding_id,
      'doctor_id', item.doctor_id, 'percentage', 100, 'step_name', null)),
    jsonb_build_object('doctor_id', item.doctor_id::text,
      'appointment_id', item.appointment_id::text),
    coalesce(auth.uid(), invoice.created_by)
  from public.patient_invoice_items as item
  join public.patient_invoices as invoice on invoice.id = item.invoice_id
    and invoice.status <> 'cancelled'
  join public.appointments as appointment on appointment.id = item.appointment_id
    and appointment.id = item.finding_id and appointment.patient_id = invoice.patient_id
    and appointment.status = 'Completed'
  join public.user_profiles as doctor on doctor.user_id = item.doctor_id
    and doctor.active and doctor.is_doctor
  where item.id = p_item_id and item.operation_code = 'diagnosis_fee'
    and item.operation_status = 'C' and item.unit_price * item.quantity > 0
    and not exists (select 1 from private.doctor_salary_linked_expenses(item.id))
  on conflict (finding_id) do update set
    invoice_item_id = excluded.invoice_item_id,
    doctor_id = excluded.doctor_id,
    assignment_mode = excluded.assignment_mode,
    allocations = excluded.allocations,
    assignment_signature = excluded.assignment_signature,
    transferred_at = now(),
    transferred_by = excluded.transferred_by
  where transfer.invoice_item_id is distinct from excluded.invoice_item_id
    or transfer.doctor_id is distinct from excluded.doctor_id
    or transfer.assignment_mode is distinct from excluded.assignment_mode
    or transfer.allocations is distinct from excluded.allocations
    or transfer.assignment_signature is distinct from excluded.assignment_signature;
end;
$$;

create or replace function private.auto_transfer_diagnosis_fee_salary()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_item_id bigint; v_item_ids bigint[];
begin
  if tg_table_name = 'patient_invoice_items' then
    perform private.sync_diagnosis_fee_salary_transfer(new.id);
    return new;
  elsif tg_table_name = 'appointments' then
    select array_agg(item.id order by item.id) into v_item_ids
    from public.patient_invoice_items as item
    where item.operation_code = 'diagnosis_fee' and item.appointment_id = new.id;
  elsif tg_table_name = 'patient_invoices' then
    select array_agg(item.id order by item.id) into v_item_ids
    from public.patient_invoice_items as item
    where item.operation_code = 'diagnosis_fee' and item.invoice_id = new.id;
  elsif tg_table_name = 'user_profiles' then
    select array_agg(item.id order by item.id) into v_item_ids
    from public.patient_invoice_items as item
    where item.operation_code = 'diagnosis_fee' and item.doctor_id = new.user_id;
  end if;
  foreach v_item_id in array coalesce(v_item_ids, '{}'::bigint[]) loop
    perform private.sync_diagnosis_fee_salary_transfer(v_item_id);
  end loop;
  return new;
end;
$$;

revoke all on function private.sync_diagnosis_fee_salary_transfer(bigint) from public, anon, authenticated;
revoke all on function private.auto_transfer_diagnosis_fee_salary() from public, anon, authenticated;

create trigger auto_transfer_diagnosis_fee_salary_item
after insert or update on public.patient_invoice_items
for each row when (new.operation_code = 'diagnosis_fee')
execute function private.auto_transfer_diagnosis_fee_salary();

create trigger auto_transfer_diagnosis_fee_salary_appointment
after update of status, patient_id on public.appointments
for each row when (new.status = 'Completed'
  and (old.status is distinct from new.status or old.patient_id is distinct from new.patient_id))
execute function private.auto_transfer_diagnosis_fee_salary();

create trigger auto_transfer_diagnosis_fee_salary_invoice
after update of status, patient_id on public.patient_invoices
for each row when (new.status <> 'cancelled'
  and (old.status is distinct from new.status or old.patient_id is distinct from new.patient_id))
execute function private.auto_transfer_diagnosis_fee_salary();

create trigger auto_transfer_diagnosis_fee_salary_doctor
after update of active, is_doctor on public.user_profiles
for each row when (new.active and new.is_doctor
  and (old.active is distinct from new.active or old.is_doctor is distinct from new.is_doctor))
execute function private.auto_transfer_diagnosis_fee_salary();

-- Lock the appointment before editing its invoice item to keep the lock order
-- consistent with the appointment-completion trigger.
create or replace function public.add_assigned_diagnosis_fee_to_patient_invoice(
  p_appointment_id uuid, p_amount numeric, p_doctor_id uuid
)
returns table(invoice_id bigint, item_id bigint, unit_price numeric, created boolean, doctor_id uuid, doctor_name text)
language plpgsql security definer set search_path = '' as $$
declare
  v_result record;
  v_doctor_name text;
  v_diagnosis_operation_id uuid;
begin
  if auth.uid() is null or not private.is_active_user()
    or not (private.is_admin() or private.has_page_permission('appointments')
      or private.has_page_permission('dashboard')) then
    raise exception 'You are not authorized to add diagnosis fees.' using errcode = '42501';
  end if;
  perform 1 from public.appointments where id = p_appointment_id for update;
  select profile.full_name into v_doctor_name
    from public.user_profiles as profile
    where profile.user_id = p_doctor_id and profile.active and profile.is_doctor;
  if v_doctor_name is null then
    raise exception 'Choose an active doctor for this diagnosis fee.' using errcode = '22023';
  end if;
  select operation.id into v_diagnosis_operation_id
    from public.dental_operations as operation where operation.code = 'dz_diagnosis_a1';
  if v_diagnosis_operation_id is null then
    raise exception 'The Diagnosis operation is unavailable.' using errcode = 'P0002';
  end if;
  select * into v_result
    from public.add_diagnosis_fee_to_patient_invoice(p_appointment_id, p_amount);
  update public.patient_invoice_items as item
     set finding_id = p_appointment_id, operation_id = v_diagnosis_operation_id,
         doctor_id = p_doctor_id, doctor_name = v_doctor_name
   where item.id = v_result.item_id;
  return query select v_result.invoice_id::bigint, v_result.item_id::bigint,
    v_result.unit_price::numeric, v_result.created::boolean, p_doctor_id, v_doctor_name;
end;
$$;

-- Include existing eligible fees without changing any paid salary allocation.
do $$
declare v_item_id bigint;
begin
  for v_item_id in
    select item.id from public.patient_invoice_items as item
    where item.operation_code = 'diagnosis_fee' order by item.id
  loop
    perform private.sync_diagnosis_fee_salary_transfer(v_item_id);
  end loop;
end;
$$;
