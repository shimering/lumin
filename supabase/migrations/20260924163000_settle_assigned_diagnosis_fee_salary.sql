-- Diagnosis fees use their appointment ID as the salary case ID, so settlement
-- must validate the completed appointment instead of looking for a chart finding.
create or replace function private.guard_doctor_salary_payment_item_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  parent_finding_id uuid;
  chart_state jsonb;
  signature jsonb;
  operation_code text;
  appointment_id uuid;
  invoice_doctor_id uuid;
  invoice_amount numeric;
begin
  select transfer.finding_id, patient.chart_state, transfer.assignment_signature,
    item.operation_code, item.appointment_id, item.doctor_id,
    item.unit_price * item.quantity
    into parent_finding_id, chart_state, signature, operation_code,
      appointment_id, invoice_doctor_id, invoice_amount
  from private.hr_doctor_salary_transfers as transfer
  join public.patient_invoice_items as item on item.id = transfer.invoice_item_id
    and item.finding_id = transfer.finding_id
  join public.patient_invoices as invoice on invoice.id = item.invoice_id
  join public.patients as patient on patient.id = invoice.patient_id
  where item.operation_status = 'C' and invoice.patient_id = new.patient_id
    and invoice.status <> 'cancelled'
    and exists (select 1 from jsonb_to_recordset(transfer.allocations)
      as allocation(finding_id uuid, doctor_id uuid, percentage numeric, step_name text)
      where allocation.finding_id = new.finding_id and allocation.doctor_id = new.doctor_id)
  for key share of item;

  if parent_finding_id is null then
    raise exception 'This doctor case is no longer completed, invoiced, and transferred.' using errcode = '23503';
  end if;

  if operation_code = 'diagnosis_fee' then
    if appointment_id is distinct from parent_finding_id
      or invoice_doctor_id is distinct from new.doctor_id
      or invoice_amount <= 0
      or signature is distinct from jsonb_build_object(
        'doctor_id', invoice_doctor_id::text, 'appointment_id', appointment_id::text)
      or not exists (
        select 1 from public.appointments as appointment
        where appointment.id = appointment_id and appointment.patient_id = new.patient_id
          and appointment.status = 'Completed'
      ) then
      raise exception 'This diagnosis fee is no longer completed, invoiced, and transferred.' using errcode = '23503';
    end if;
    return new;
  end if;

  if not private.doctor_salary_assignment_is_complete(
      private.chart_finding_by_id(chart_state, parent_finding_id))
    or signature is distinct from private.doctor_salary_assignment_signature(
      private.chart_finding_by_id(chart_state, parent_finding_id)) then
    raise exception 'This doctor case is no longer completed, invoiced, and transferred.' using errcode = '23503';
  end if;
  return new;
end;
$$;
