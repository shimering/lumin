-- Visits are independent billable findings. Parent assignment takes precedence,
-- while the visit's own clinical date controls its payroll day.
create or replace function private.ortho_visit_finding_rows(p_chart jsonb)
returns table(finding_id uuid, tooth_id text, finding jsonb)
language sql immutable set search_path = '' as $$
  with parents as (
    select null::text as tooth_id, entry.value as finding
    from jsonb_array_elements(case when jsonb_typeof(p_chart->'_meta'->'mouthOperations')='array'
      then p_chart->'_meta'->'mouthOperations' else '[]'::jsonb end) entry(value)
    union all
    select tooth.key, entry.value
    from jsonb_each(case when jsonb_typeof(p_chart)='object' then p_chart else '{}'::jsonb end) tooth
    cross join lateral jsonb_array_elements(case when jsonb_typeof(tooth.value->'wholeOperations')='array'
      then tooth.value->'wholeOperations' else '[]'::jsonb end) entry(value)
    where tooth.key<>'_meta'
  )
  select (visit.value->>'id')::uuid, parent.tooth_id,
    visit.value || jsonb_build_object(
      'code', coalesce(parent.finding->>'code',parent.finding->>'operationCode'),
      'parentFindingId', parent.finding->>'id', 'isOrthoVisit',true,
      'doctorId', coalesce(nullif(btrim(coalesce(parent.finding->>'doctorId',parent.finding->>'doctor_id')),''),
        nullif(btrim(coalesce(visit.value->>'doctorId',visit.value->>'doctor_id')),'')),
      'doctorName', case when nullif(btrim(coalesce(parent.finding->>'doctorId',parent.finding->>'doctor_id')),'') is not null
        then coalesce(parent.finding->>'doctorName',parent.finding->>'doctor_name','')
        else coalesce(visit.value->>'doctorName',visit.value->>'doctor_name','') end,
      'status', coalesce(nullif(visit.value->>'status',''),'C'),
      'completedAt', case when coalesce(nullif(visit.value->>'status',''),'C')='C'
        then coalesce(nullif(visit.value->>'date',''),visit.value->>'completedAt',visit.value->>'createdAt') else null end,
      'steps','[]'::jsonb, 'doctorAssignmentMode','whole')
  from parents parent
  cross join lateral jsonb_array_elements(case
    when jsonb_typeof(parent.finding->'orthoVisits')='array' then parent.finding->'orthoVisits'
    when jsonb_typeof(parent.finding->'ortho_visits')='array' then parent.finding->'ortho_visits'
    else '[]'::jsonb end) visit(value)
  where jsonb_typeof(visit.value)='object'
    and coalesce(visit.value->>'id','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
$$;
revoke all on function private.ortho_visit_finding_rows(jsonb) from public,anon,authenticated;

CREATE OR REPLACE FUNCTION private.patient_chart_finding_rows(p_state jsonb)
 RETURNS TABLE(finding_key text, finding_id uuid, tooth_id text, finding_kind text, surfaces text[], finding jsonb, operation_code text, operation_status text, finding_price numeric, created_at_text text)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  with teeth as (
    select tooth.key as tooth_id, tooth.value as tooth
      from jsonb_each(
        case when jsonb_typeof(p_state) = 'object' then p_state else '{}'::jsonb end
      ) tooth
     where tooth.key <> '_meta'
       and jsonb_typeof(tooth.value) = 'object'
  ),
  mouth_findings as (
    select
      null::text as tooth_id,
      'mouth'::text as finding_kind,
      '{}'::text[] as surfaces,
      mouth_finding.ordinality,
      case
        when jsonb_typeof(mouth_finding.value) = 'object' then mouth_finding.value
        else jsonb_build_object('code', mouth_finding.value #>> '{}', 'status', 'P')
      end as finding
    from jsonb_array_elements(
      case
        when jsonb_typeof(p_state -> '_meta' -> 'mouthOperations') = 'array'
          then p_state -> '_meta' -> 'mouthOperations'
        else '[]'::jsonb
      end
    ) with ordinality mouth_finding(value, ordinality)
  ),
  whole_findings as (
    select
      tooth.tooth_id,
      'whole'::text as finding_kind,
      '{}'::text[] as surfaces,
      whole_finding.ordinality,
      case
        when jsonb_typeof(whole_finding.value) = 'object' then whole_finding.value
        else jsonb_build_object('code', whole_finding.value #>> '{}', 'status', 'P')
      end as finding
    from teeth tooth
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(tooth.tooth -> 'wholeOperations') = 'array'
          then tooth.tooth -> 'wholeOperations'
        else '[]'::jsonb
      end
    ) with ordinality whole_finding(value, ordinality)
  ),
  legacy_findings as (
    select
      tooth.tooth_id,
      'legacy'::text as finding_kind,
      '{}'::text[] as surfaces,
      1::bigint as ordinality,
      case
        when jsonb_typeof(tooth.tooth -> 'status') = 'object' then tooth.tooth -> 'status'
        else jsonb_build_object('code', tooth.tooth ->> 'status', 'status', 'P')
      end as finding
    from teeth tooth
    where tooth.tooth ? 'status'
      and tooth.tooth -> 'status' is not null
      and not (
        jsonb_typeof(tooth.tooth -> 'status') = 'string'
        and lower(btrim(tooth.tooth ->> 'status')) in ('', 'none', 'healthy')
      )
  ),
  surface_members as (
    select
      tooth.tooth_id,
      surface.key as surface_key,
      surface_finding.ordinality,
      case
        when jsonb_typeof(surface_finding.value) = 'object' then surface_finding.value
        else jsonb_build_object('code', surface_finding.value #>> '{}', 'status', 'P')
      end as finding
    from teeth tooth
    cross join lateral jsonb_each(
      case
        when jsonb_typeof(tooth.tooth -> 'surfaces') = 'object' then tooth.tooth -> 'surfaces'
        else '{}'::jsonb
      end
    ) surface
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(surface.value) = 'array' then surface.value
        when surface.value is null then '[]'::jsonb
        else jsonb_build_array(surface.value)
      end
    ) with ordinality surface_finding(value, ordinality)
    where not (
      jsonb_typeof(surface_finding.value) = 'string'
      and lower(btrim(surface_finding.value #>> '{}')) in ('', 'none', 'healthy')
    )
  ),
  direct_findings as (
    select
      case
        when coalesce(finding ->> 'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then 'id:' || lower(finding ->> 'id')
        else finding_kind || ':' || coalesce(tooth_id, '') || ':' || ordinality::text || ':' || md5(finding::text)
      end as finding_key,
      case
        when coalesce(finding ->> 'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then (finding ->> 'id')::uuid
        else null::uuid
      end as finding_id,
      tooth_id,
      finding_kind,
      surfaces,
      finding,
      nullif(btrim(coalesce(finding ->> 'code', finding ->> 'operationCode', '')), '') as operation_code,
      coalesce(nullif(btrim(finding ->> 'status'), ''), 'P') as operation_status,
      case
        when coalesce(finding ->> 'price', '') ~ '^-?[0-9]+(?:\.[0-9]+)?$' then (finding ->> 'price')::numeric
        else null::numeric
      end as finding_price,
      nullif(btrim(finding ->> 'createdAt'), '') as created_at_text
    from (
      select * from mouth_findings
      union all
      select * from whole_findings
      union all
      select * from legacy_findings
    ) direct
  ),
  grouped_surfaces as (
    select
      member.finding_key,
      member.finding_id,
      member.tooth_id,
      'surface'::text as finding_kind,
      array_agg(distinct member.surface_key order by member.surface_key) as surfaces,
      (jsonb_agg(member.finding order by member.surface_key, member.ordinality) -> 0) as finding,
      member.operation_code,
      member.operation_status,
      member.finding_price,
      member.created_at_text
    from (
      select
        case
          when coalesce(surface.finding ->> 'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            then 'id:' || lower(surface.finding ->> 'id')
          else 'surface:' || surface.tooth_id || ':' || md5(surface.finding::text)
        end as finding_key,
        case
          when coalesce(surface.finding ->> 'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            then (surface.finding ->> 'id')::uuid
          else null::uuid
        end as finding_id,
        surface.tooth_id,
        surface.surface_key,
        surface.ordinality,
        surface.finding,
        nullif(btrim(coalesce(surface.finding ->> 'code', surface.finding ->> 'operationCode', '')), '') as operation_code,
        coalesce(nullif(btrim(surface.finding ->> 'status'), ''), 'P') as operation_status,
        case
          when coalesce(surface.finding ->> 'price', '') ~ '^-?[0-9]+(?:\.[0-9]+)?$'
            then (surface.finding ->> 'price')::numeric
          else null::numeric
        end as finding_price,
        nullif(btrim(surface.finding ->> 'createdAt'), '') as created_at_text
      from surface_members surface
    ) member
    group by
      member.finding_key,
      member.finding_id,
      member.tooth_id,
      member.operation_code,
      member.operation_status,
      member.finding_price,
      member.created_at_text
  )
  select * from direct_findings
  union all
  select * from grouped_surfaces
  union all
  select 'id:' || visit.finding_id::text, visit.finding_id, visit.tooth_id, 'ortho_visit'::text,
    '{}'::text[], visit.finding, visit.finding->>'code', visit.finding->>'status',
    case when coalesce(visit.finding->>'price','') ~ '^[0-9]+([.][0-9]+)?$'
      then (visit.finding->>'price')::numeric else null::numeric end,
    coalesce(visit.finding->>'date',visit.finding->>'createdAt')
  from private.ortho_visit_finding_rows(p_state) visit;
$function$;

create or replace function private.chart_finding_by_id(p_chart jsonb,p_finding_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  select row.finding from private.patient_chart_finding_rows(p_chart) row
  where row.finding_id=p_finding_id
  order by case row.finding_kind when 'mouth' then 1 when 'whole' then 2 when 'surface' then 3 else 4 end
  limit 1;
$$;

-- The invoice item retains the visit fee snapshot and the assigned clinician,
-- rather than recording the user who happened to create the invoice.
create or replace function private.prepare_ortho_visit_invoice_item()
returns trigger language plpgsql security definer set search_path = '' as $$
declare visit jsonb; doctor_id_text text;
begin
  select row.finding into visit
  from public.patient_invoices invoice join public.patients patient on patient.id=invoice.patient_id
  cross join lateral private.ortho_visit_finding_rows(patient.chart_state) row
  where invoice.id=new.invoice_id and row.finding_id=new.finding_id limit 1;
  if visit is null then return new; end if;
  doctor_id_text:=nullif(btrim(visit->>'doctorId'),'');
  new.doctor_id:=doctor_id_text::uuid;
  new.doctor_name:='';
  if new.doctor_id is not null then
    select profile.full_name into new.doctor_name from public.user_profiles profile
      where profile.user_id=new.doctor_id and profile.active and profile.is_doctor;
    if not found then raise exception 'The assigned visit doctor is no longer active.' using errcode='22023'; end if;
  end if;
  return new;
end;
$$;
revoke all on function private.prepare_ortho_visit_invoice_item() from public,anon,authenticated;
create trigger prepare_ortho_visit_invoice_item before insert or update of invoice_id,finding_id
on public.patient_invoice_items for each row execute function private.prepare_ortho_visit_invoice_item();

-- Keep existing visit invoices in sync when a main doctor is assigned or removed,
-- and when a visit changes status. Never rewrite invoiced prices or paid salaries.
create or replace function private.sync_ortho_visit_invoice_doctors()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.patient_invoice_items item
  set doctor_id=nullif(visit.finding->>'doctorId','')::uuid,
      doctor_name=coalesce(profile.full_name,''), operation_status=visit.finding->>'status'
  from private.ortho_visit_finding_rows(new.chart_state) visit
  join public.patient_invoices invoice on invoice.patient_id=new.id
  left join public.user_profiles profile on profile.user_id=nullif(visit.finding->>'doctorId','')::uuid
  where item.invoice_id=invoice.id and item.finding_id=visit.finding_id
    and (item.doctor_id,item.doctor_name,item.operation_status) is distinct from
      (nullif(visit.finding->>'doctorId','')::uuid,coalesce(profile.full_name,''),visit.finding->>'status');
  return new;
end;
$$;
revoke all on function private.sync_ortho_visit_invoice_doctors() from public,anon,authenticated;
create trigger sync_ortho_visit_invoice_doctors after update of chart_state on public.patients
for each row when(old.chart_state is distinct from new.chart_state)
execute function private.sync_ortho_visit_invoice_doctors();
