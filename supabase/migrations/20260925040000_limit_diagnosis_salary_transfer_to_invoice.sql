-- Salary transfers require patient or chart access, including for diagnosis fees.
CREATE OR REPLACE FUNCTION public.transfer_doctor_salary_invoice_item(p_item_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  item public.patient_invoice_items;
  invoice public.patient_invoices;
  finding jsonb;
  steps jsonb;
  allocations jsonb;
  doctor_id uuid;
  mode text;
begin
  if auth.uid() is null or not private.is_active_user() then
    raise exception 'Patient access is required.' using errcode = '42501';
  end if;
  select * into item from public.patient_invoice_items where id = p_item_id for update;
  if item is null then raise exception 'Invoice procedure was not found.' using errcode = 'P0002'; end if;
  if not (private.is_admin() or private.has_page_permission('patients')
    or private.has_page_permission('chart')) then
    raise exception 'Patient access is required.' using errcode = '42501';
  end if;
  select * into invoice from public.patient_invoices where id = item.invoice_id;
  if invoice.status = 'cancelled' or item.finding_id is null or item.operation_status <> 'C'
    or item.unit_price * item.quantity <= 0 then
    raise exception 'The procedure must be completed and invoiced before salary transfer.' using errcode = '22023';
  end if;
  if item.operation_code = 'diagnosis_fee' then
    if item.appointment_id is null or item.finding_id is distinct from item.appointment_id
      or not exists (
        select 1 from public.appointments appointment
        where appointment.id = item.appointment_id
          and appointment.patient_id = invoice.patient_id
          and appointment.status = 'Completed'
      ) then
      raise exception 'Complete the appointment before transferring its invoiced diagnosis fee to salary.' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.user_profiles profile
      where profile.user_id = item.doctor_id and profile.active and profile.is_doctor
    ) then
      raise exception 'Assign an active doctor to the diagnosis fee before salary transfer.' using errcode = '22023';
    end if;
    if exists (select 1 from private.doctor_salary_linked_expenses(item.id)) then
      raise exception 'Delete the linked doctor salary expenses before transferring this fee again.' using errcode = '23503';
    end if;
    insert into private.hr_doctor_salary_transfers
      (finding_id, invoice_item_id, doctor_id, assignment_mode, allocations, assignment_signature, transferred_by)
    values (
      item.finding_id, item.id, item.doctor_id, 'whole',
      jsonb_build_array(jsonb_build_object('finding_id', item.finding_id,
        'doctor_id', item.doctor_id, 'percentage', 100, 'step_name', null)),
      jsonb_build_object('doctor_id', item.doctor_id::text,
        'appointment_id', item.appointment_id::text),
      auth.uid()
    )
    on conflict (finding_id) do update set
      invoice_item_id = excluded.invoice_item_id,
      doctor_id = excluded.doctor_id,
      assignment_mode = excluded.assignment_mode,
      allocations = excluded.allocations,
      assignment_signature = excluded.assignment_signature,
      transferred_at = now(),
      transferred_by = excluded.transferred_by;
    return true;
  end if;
  select private.chart_finding_by_id(patient.chart_state, item.finding_id)
    into finding from public.patients as patient where patient.id = invoice.patient_id for share;
  if not private.doctor_salary_assignment_is_complete(finding) then
    raise exception 'Complete the procedure and assign either one whole-procedure doctor or every step doctor before salary transfer.' using errcode = '22023';
  end if;
  if exists (select 1 from private.doctor_salary_linked_expenses(item.id)) then
    raise exception 'Delete the linked doctor salary expenses before transferring this procedure again.' using errcode = '23503';
  end if;

  steps := case when jsonb_typeof(finding->'steps') = 'array' then finding->'steps' else '[]'::jsonb end;
  if nullif(btrim(coalesce(finding->>'doctorId', finding->>'doctor_id', '')), '') is null then
    mode := 'steps';
    doctor_id := null;
    select jsonb_agg(jsonb_build_object(
      'finding_id', coalesce(step.value->>'payrollFindingId', step.value->>'payroll_finding_id'),
      'doctor_id', coalesce(step.value->>'doctorId', step.value->>'doctor_id'),
      'percentage', (step.value->>'percentage')::numeric,
      'step_name', step.value->>'name') order by step.ordinality)
      into allocations
    from jsonb_array_elements(steps) with ordinality as step(value, ordinality);
  else
    mode := 'whole';
    doctor_id := coalesce(finding->>'doctorId', finding->>'doctor_id')::uuid;
    allocations := jsonb_build_array(jsonb_build_object(
      'finding_id', item.finding_id,
      'doctor_id', doctor_id,
      'percentage', 100,
      'step_name', null));
  end if;

  insert into private.hr_doctor_salary_transfers
    (finding_id, invoice_item_id, doctor_id, assignment_mode, allocations, assignment_signature, transferred_by)
  values (item.finding_id, item.id, doctor_id, mode, allocations,
    private.doctor_salary_assignment_signature(finding), auth.uid())
  on conflict (finding_id) do update set
    invoice_item_id = excluded.invoice_item_id,
    doctor_id = excluded.doctor_id,
    assignment_mode = excluded.assignment_mode,
    allocations = excluded.allocations,
    assignment_signature = excluded.assignment_signature,
    transferred_at = now(),
    transferred_by = excluded.transferred_by;
  return true;
end;
$function$;
