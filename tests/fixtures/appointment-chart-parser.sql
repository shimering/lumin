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
  select * from grouped_surfaces;
$function$
