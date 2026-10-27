-- A payroll/invoice lookup needs one finding, not the full normalized chart.
-- Keep the parser's precedence and its orthodontic visit projection, while
-- avoiding surface aggregation, hashing and visit expansion for ordinary rows.
create or replace function private.chart_finding_by_id(p_chart jsonb, p_finding_id uuid)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  result jsonb;
  target_id text := p_finding_id::text;
begin
  if p_finding_id is null or jsonb_typeof(p_chart) is distinct from 'object' then
    return null;
  end if;

  select entry.value into result
  from jsonb_array_elements(case when jsonb_typeof(p_chart #> '{_meta,mouthOperations}') = 'array'
    then p_chart #> '{_meta,mouthOperations}' else '[]'::jsonb end) entry(value)
  where lower(entry.value->>'id') = target_id
  limit 1;
  if found then return result; end if;

  select entry.value into result
  from jsonb_each(p_chart) tooth
  cross join lateral jsonb_array_elements(case when jsonb_typeof(tooth.value->'wholeOperations') = 'array'
    then tooth.value->'wholeOperations' else '[]'::jsonb end) entry(value)
  where tooth.key <> '_meta' and jsonb_typeof(tooth.value) = 'object'
    and lower(entry.value->>'id') = target_id
  limit 1;
  if found then return result; end if;

  -- A surface finding may be repeated on several surfaces. The full parser
  -- selects its first surface alphabetically and then its array position.
  select entry.value into result
  from jsonb_each(p_chart) tooth
  cross join lateral jsonb_each(case when jsonb_typeof(tooth.value->'surfaces') = 'object'
    then tooth.value->'surfaces' else '{}'::jsonb end) surface
  cross join lateral jsonb_array_elements(case
    when jsonb_typeof(surface.value) = 'array' then surface.value
    when surface.value is null then '[]'::jsonb else jsonb_build_array(surface.value)
  end) with ordinality entry(value, position)
  where tooth.key <> '_meta' and jsonb_typeof(tooth.value) = 'object'
    and lower(entry.value->>'id') = target_id
  order by tooth.key, surface.key, entry.position
  limit 1;
  if found then return result; end if;

  select tooth.value->'status' into result
  from jsonb_each(p_chart) tooth
  where tooth.key <> '_meta' and jsonb_typeof(tooth.value) = 'object'
    and lower(tooth.value->'status'->>'id') = target_id
  limit 1;
  if found then return result; end if;

  select visit.finding into result
  from private.ortho_visit_finding_rows(p_chart) visit
  where visit.finding_id = p_finding_id
  limit 1;
  return result;
end;
$$;

-- This remains an internal helper; callers use the existing authorized RPCs.
revoke all on function private.chart_finding_by_id(jsonb, uuid) from public, anon, authenticated;
