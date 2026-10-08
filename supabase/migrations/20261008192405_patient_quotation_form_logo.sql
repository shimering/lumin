-- Quotation branding follows the saved form logo, including later changes or removal.
-- The source remains service-role-only; no print settings access is granted to patients.
create or replace function public.quotation_source(p_token text) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'id',q.id,'language',q.language,'expires_at',q.expires_at,'updated_at',q.updated_at,
    'patient_name',p.name,'chart_state',p.chart_state,'selected_ids',q.selected_ids,
    'clinic',jsonb_build_object('name',s.clinic_name,'logo',coalesce(f.logo_data_url,''),'whatsapp',s.whatsapp_phone),
    'operations',(select coalesce(jsonb_agg(jsonb_build_object('code',o.code,'name',o.name,'price',o.price,'action_scope',o.action_scope,'visual_code',o.visual_code)),'[]'::jsonb) from public.dental_operations o)
  ) from public.patient_quotations q join public.patients p on p.id = q.patient_id
  cross join public.quotation_settings s
  left join public.prescription_print_settings f on f.id = 1
  where q.token = p_token and q.revoked_at is null and q.expires_at > now() and s.id = 1;
$$;
revoke all on function public.quotation_source(text) from public, anon, authenticated;
grant execute on function public.quotation_source(text) to service_role;
