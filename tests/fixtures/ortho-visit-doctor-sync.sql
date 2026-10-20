CREATE OR REPLACE FUNCTION public.sync_chart_finding_doctor(p_patient_id uuid, p_finding_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_chart jsonb;
  v_finding_id uuid;
  v_finding jsonb;
  v_doctor_id_text text;
  v_doctor_id uuid;
  v_doctor_name text;
  v_updated integer;
  v_total_updated integer := 0;
begin
  if auth.uid() is null or not private.is_active_user() or not (private.is_admin() or private.has_page_permission('chart')) then
    raise exception 'Chart access is required.' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_finding_ids), 0) = 0 then raise exception 'Select at least one documented finding.' using errcode = '22023'; end if;
  select patient.chart_state into v_chart from public.patients as patient where patient.id = p_patient_id;
  if not found then raise exception 'The selected patient no longer exists.' using errcode = '22023'; end if;
  foreach v_finding_id in array p_finding_ids loop
    v_finding := private.chart_finding_by_id(v_chart, v_finding_id);
    if v_finding is null then raise exception 'A selected documented finding no longer exists.' using errcode = '22023'; end if;
    v_doctor_id_text := nullif(btrim(coalesce(v_finding->>'doctorId', v_finding->>'doctor_id')), '');
    v_doctor_id := null;
    v_doctor_name := '';
    if v_doctor_id_text is not null then
      if v_doctor_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then raise exception 'The assigned doctor identifier is invalid.' using errcode = '22023'; end if;
      select profile.user_id, profile.full_name into v_doctor_id, v_doctor_name
      from public.user_profiles as profile where profile.user_id = v_doctor_id_text::uuid and profile.active and profile.is_doctor;
      if not found then raise exception 'The assigned doctor is no longer active.' using errcode = '22023'; end if;
    end if;
    update public.patient_invoice_items as item set doctor_id = v_doctor_id, doctor_name = v_doctor_name
    where item.finding_id = v_finding_id and exists (select 1 from public.patient_invoices as invoice where invoice.id = item.invoice_id and invoice.patient_id = p_patient_id);
    get diagnostics v_updated = row_count;
    v_total_updated := v_total_updated + v_updated;
  end loop;
  return v_total_updated;
end;
$function$
