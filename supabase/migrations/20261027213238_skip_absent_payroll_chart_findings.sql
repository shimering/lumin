-- Use native JSON path searches for direct findings and skip absent historical
-- identifiers before invoking the orthodontic projection. Surface matches keep
-- the full parser's alphabetical surface/array precedence.
create or replace function private.chart_finding_by_id(p_chart jsonb, p_finding_id uuid)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  result jsonb;
  target_id text := p_finding_id::text;
  match_filter text := ' ? (@.type() == "object" && exists(@.id) && @.id like_regex "^' || p_finding_id::text || '$" flag "i")';
  surfaces_path text := 'strict $.keyvalue() ? (@.key != "_meta" && @.value.type() == "object").value ? (exists(@.surfaces) && @.surfaces.type() == "object").surfaces.keyvalue()';
begin
  if p_finding_id is null or jsonb_typeof(p_chart) is distinct from 'object' then return null; end if;

  result := jsonb_path_query_first(p_chart,
    ('strict $ ? (exists(@._meta) && @._meta.type() == "object")._meta ? (exists(@.mouthOperations) && @.mouthOperations.type() == "array").mouthOperations[*]' || match_filter)::jsonpath, '{}'::jsonb, true);
  if result is not null then return result; end if;

  result := jsonb_path_query_first(p_chart,
    ('strict $.keyvalue() ? (@.key != "_meta" && @.value.type() == "object").value ? (exists(@.wholeOperations) && @.wholeOperations.type() == "array").wholeOperations[*]' || match_filter)::jsonpath, '{}'::jsonb, true);
  if result is not null then return result; end if;

  if jsonb_path_exists(p_chart,
    (surfaces_path || '.value' || match_filter)::jsonpath, '{}'::jsonb, true)
    or jsonb_path_exists(p_chart,
    (surfaces_path || ' ? (@.value.type() == "array").value[*]' || match_filter)::jsonpath, '{}'::jsonb, true) then
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
  end if;

  result := jsonb_path_query_first(p_chart,
    ('strict $.keyvalue() ? (@.key != "_meta" && @.value.type() == "object").value ? (exists(@.status) && @.status.type() == "object").status' || match_filter)::jsonpath, '{}'::jsonb, true);
  if result is not null then return result; end if;

  if not jsonb_path_exists(p_chart,
    ('lax $.**.id ? (@ like_regex "^' || target_id || '$" flag "i")')::jsonpath, '{}'::jsonb, true) then
    return null;
  end if;

  select visit.finding into result from private.ortho_visit_finding_rows(p_chart) visit
  where visit.finding_id = p_finding_id limit 1;
  return result;
end;
$$;
revoke all on function private.chart_finding_by_id(jsonb, uuid) from public, anon, authenticated;
