-- Validate and persist the optional universal doctor compensation rule alongside specific rules.

create or replace function public.save_hr_staff_settings(
  p_user_id uuid,
  p_attendance_enabled boolean,
  p_regular_shift_rate numeric,
  p_extra_shift_rate numeric,
  p_weekly_schedule jsonb
)
returns public.hr_staff_settings
language plpgsql
security definer
set search_path = ''
as $$
declare
  result public.hr_staff_settings;
  target_is_doctor boolean;
  day_value jsonb;
  day_number integer;
  day_start text;
  day_end text;
  fallback_start text;
  fallback_end text;
  first_start text;
  first_end text;
  normalized_days integer[] := '{}'::integer[];
  normalized_daily jsonb := '{}'::jsonb;
  normalized_schedule jsonb;
  compensation_rules jsonb;
  normalized_rules jsonb := '[]'::jsonb;
  rule_value jsonb;
  rule_procedure_id_text text;
  rule_procedure_id uuid;
  rule_type text;
  rule_amount_text text;
  rule_amount numeric(12,2);
  rule_operation public.dental_operations%rowtype;
  seen_procedure_ids uuid[] := '{}'::uuid[];
  universal_rule jsonb;
  universal_enabled boolean := false;
  universal_type text := 'percentage';
  universal_amount_text text;
  universal_amount numeric(12,2) := 0;
begin
  if not (select private.is_admin()) then
    raise exception 'Only administrators can change staff payroll settings.' using errcode = '42501';
  end if;

  select is_doctor into target_is_doctor from public.user_profiles where user_id = p_user_id;
  if not found then raise exception 'Login user was not found.' using errcode = '22023'; end if;

  if jsonb_typeof(p_weekly_schedule) <> 'object'
     or jsonb_typeof(p_weekly_schedule -> 'days') <> 'array'
     or jsonb_array_length(p_weekly_schedule -> 'days') = 0 then
    raise exception 'Select at least one regular working day.' using errcode = '22023';
  end if;

  fallback_start := coalesce(p_weekly_schedule ->> 'start', '');
  fallback_end := coalesce(p_weekly_schedule ->> 'end', '');
  if fallback_start !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     or fallback_end !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'Every working day needs valid start and end times.' using errcode = '22023';
  end if;
  if p_weekly_schedule ? 'daily' and jsonb_typeof(p_weekly_schedule -> 'daily') <> 'object' then
    raise exception 'Daily shift times must be an object.' using errcode = '22023';
  end if;

  for day_value in select value from jsonb_array_elements(p_weekly_schedule -> 'days') loop
    if jsonb_typeof(day_value) <> 'number' or day_value::text !~ '^[0-6]$' then
      raise exception 'Working days must be whole numbers from 0 to 6.' using errcode = '22023';
    end if;
    day_number := day_value::text::integer;
    if array_position(normalized_days, day_number) is not null then
      raise exception 'Working days cannot contain duplicates.' using errcode = '22023';
    end if;
    day_start := coalesce(p_weekly_schedule #>> array['daily', day_number::text, 'start'], fallback_start);
    day_end := coalesce(p_weekly_schedule #>> array['daily', day_number::text, 'end'], fallback_end);
    if day_start !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or day_end !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or day_start = day_end then
      raise exception 'Every working day needs different valid start and end times.' using errcode = '22023';
    end if;
    normalized_days := array_append(normalized_days, day_number);
    normalized_daily := jsonb_set(normalized_daily, array[day_number::text], jsonb_build_object('start', day_start, 'end', day_end), true);
    if first_start is null then first_start := day_start; first_end := day_end; end if;
  end loop;

  normalized_schedule := jsonb_build_object(
    'days', to_jsonb(normalized_days),
    'start', first_start,
    'end', first_end,
    'daily', normalized_daily
  );

  if target_is_doctor then
    compensation_rules := case
      when jsonb_typeof(p_weekly_schedule #> '{doctorCompensation,rules}') = 'array' then p_weekly_schedule #> '{doctorCompensation,rules}'
      when p_weekly_schedule #> '{doctorCompensation,rules}' is null then '[]'::jsonb
      else null
    end;
    if compensation_rules is null then
      raise exception 'Doctor procedure compensation rules must be an array.' using errcode = '22023';
    end if;

    for rule_value in select value from jsonb_array_elements(compensation_rules) loop
      if jsonb_typeof(rule_value) <> 'object' then
        raise exception 'Every doctor compensation rule must be an object.' using errcode = '22023';
      end if;
      rule_procedure_id_text := btrim(coalesce(rule_value->>'procedureId', rule_value->>'procedure_id', ''));
      if rule_procedure_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
        raise exception 'Every doctor compensation rule needs a valid procedure.' using errcode = '22023';
      end if;
      rule_procedure_id := rule_procedure_id_text::uuid;
      if array_position(seen_procedure_ids, rule_procedure_id) is not null then
        raise exception 'A dental procedure can only have one doctor compensation rule.' using errcode = '22023';
      end if;

      rule_type := case when rule_value->>'type' = 'fixed' then 'fixed' else 'percentage' end;
      rule_amount_text := btrim(coalesce(rule_value->>'amount', rule_value->>'value', ''));
      if rule_amount_text !~ '^[0-9]+([.][0-9]{1,2})?$' then
        raise exception 'Every doctor compensation rule needs a valid amount.' using errcode = '22023';
      end if;
      rule_amount := round(rule_amount_text::numeric, 2);
      if rule_amount <= 0 or (rule_type = 'percentage' and rule_amount > 100) then
        raise exception 'Doctor compensation must be positive and percentages cannot exceed 100.' using errcode = '22023';
      end if;

      select * into rule_operation from public.dental_operations where id = rule_procedure_id and active;
      if not found then
        raise exception 'Every doctor compensation rule must use an active dental procedure.' using errcode = '22023';
      end if;

      normalized_rules := normalized_rules || jsonb_build_array(jsonb_build_object(
        'procedureId', rule_operation.id::text,
        'procedureCode', rule_operation.code,
        'procedureName', rule_operation.name,
        'type', rule_type,
        'amount', rule_amount
      ));
      seen_procedure_ids := array_append(seen_procedure_ids, rule_procedure_id);
    end loop;

    universal_rule := case
      when jsonb_typeof(p_weekly_schedule #> '{doctorCompensation,universal}') = 'object'
        then p_weekly_schedule #> '{doctorCompensation,universal}'
      when jsonb_typeof(p_weekly_schedule #> '{doctorCompensation,fallback}') = 'object'
        then p_weekly_schedule #> '{doctorCompensation,fallback}'
      when p_weekly_schedule #> '{doctorCompensation,universal}' is null
        and p_weekly_schedule #> '{doctorCompensation,fallback}' is null
        then '{}'::jsonb
      else null
    end;
    if universal_rule is null then
      raise exception 'The universal doctor compensation rule must be an object.' using errcode = '22023';
    end if;
    if universal_rule ? 'enabled' and jsonb_typeof(universal_rule->'enabled') <> 'boolean' then
      raise exception 'The universal doctor compensation enabled value must be true or false.' using errcode = '22023';
    end if;

    universal_enabled := coalesce((universal_rule->>'enabled')::boolean, false);
    universal_type := case when universal_rule->>'type' = 'fixed' then 'fixed' else 'percentage' end;
    universal_amount_text := btrim(coalesce(universal_rule->>'amount', universal_rule->>'value', ''));
    if universal_amount_text ~ '^[0-9]+([.][0-9]{1,2})?$' then
      universal_amount := round(universal_amount_text::numeric, 2);
    elsif universal_enabled then
      raise exception 'The universal doctor compensation rule needs a valid amount.' using errcode = '22023';
    end if;
    if universal_enabled and (universal_amount <= 0 or (universal_type = 'percentage' and universal_amount > 100)) then
      raise exception 'Universal doctor compensation must be positive and percentages cannot exceed 100.' using errcode = '22023';
    end if;
    if not universal_enabled and (universal_amount < 0 or (universal_type = 'percentage' and universal_amount > 100)) then
      universal_amount := 0;
    end if;

    normalized_schedule := normalized_schedule || jsonb_build_object(
      'doctorCompensation',
      jsonb_build_object(
        'rules', normalized_rules,
        'universal', jsonb_build_object(
          'enabled', universal_enabled,
          'type', universal_type,
          'amount', universal_amount
        )
      )
    );
  end if;

  insert into public.hr_staff_settings (user_id, attendance_enabled, regular_shift_rate, extra_shift_rate, weekly_schedule, updated_by)
  values (
    p_user_id,
    p_attendance_enabled,
    round(coalesce(p_regular_shift_rate, 0), 2),
    case when target_is_doctor then 0 else round(coalesce(p_extra_shift_rate, 0), 2) end,
    normalized_schedule,
    (select auth.uid())
  )
  on conflict (user_id) do update
  set attendance_enabled = excluded.attendance_enabled,
      regular_shift_rate = excluded.regular_shift_rate,
      extra_shift_rate = excluded.extra_shift_rate,
      weekly_schedule = excluded.weekly_schedule,
      updated_by = excluded.updated_by,
      updated_at = now()
  returning * into result;
  return result;
end;
$$;
