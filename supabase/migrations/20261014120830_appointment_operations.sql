-- Optional chart references travel with the existing appointment reads and RLS policies.
alter table public.appointments add column operations jsonb not null default '[]'::jsonb
  constraint appointments_operations_array check (jsonb_typeof(operations) = 'array' and jsonb_array_length(operations) <= 100);

-- Group surfaces and treatment batches once, using the same chart parser as invoicing.
create or replace function private.appointment_operation_choices(p_state jsonb)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with members as (
    select distinct f.finding_id, f.tooth_id, f.finding_kind, f.operation_code,
      f.operation_status, f.surfaces,
      case when nullif(f.finding->>'batchId', '') is not null
        then 'batch:' || (f.finding->>'batchId') || ':' || f.operation_code || ':' || f.finding_kind
        else 'id:' || f.finding_id::text end as group_key
    from private.patient_chart_finding_rows(p_state) f
    where f.finding_id is not null and f.operation_code is not null
      and coalesce(f.finding->>'isProcedureStep', 'false') <> 'true'
  ), grouped as (
    select m.group_key, m.operation_code,
      jsonb_agg(distinct m.finding_id::text order by m.finding_id::text) as finding_ids,
      coalesce(jsonb_agg(distinct m.tooth_id order by m.tooth_id) filter (where m.tooth_id is not null and m.tooth_id <> ''), '[]'::jsonb) as tooth_ids,
      case when bool_or(m.operation_status = 'In') then 'In'
        when bool_and(m.operation_status = 'C') then 'C'
        when bool_and(m.operation_status = 'E') then 'E' else 'P' end as status
    from members m group by m.group_key, m.operation_code
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'finding_ids', g.finding_ids, 'code', g.operation_code,
    'name', coalesce(o.name, g.operation_code), 'status', g.status, 'tooth_ids', g.tooth_ids,
    'surfaces', coalesce((select jsonb_agg(distinct s.surface order by s.surface)
      from members m cross join lateral unnest(m.surfaces) s(surface)
      where m.group_key = g.group_key), '[]'::jsonb)
  ) order by coalesce(o.name, g.operation_code), g.group_key), '[]'::jsonb)
  from grouped g left join public.dental_operations o on o.code = g.operation_code;
$$;
revoke all on function private.appointment_operation_choices(jsonb) from public, anon;
grant execute on function private.appointment_operation_choices(jsonb) to authenticated;

create or replace function public.get_patient_appointment_operations(p_patient_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_state jsonb;
begin
  if auth.uid() is null or not (private.is_admin() or
    (private.is_active_user() and private.has_page_permission('appointments'))) then
    raise exception 'Appointment access required' using errcode = '42501';
  end if;
  select p.chart_state into v_state from public.patients p where p.id = p_patient_id;
  if not found then raise exception 'Patient unavailable' using errcode = '42501'; end if;
  return private.appointment_operation_choices(v_state);
end;
$$;
revoke all on function public.get_patient_appointment_operations(uuid) from public, anon;
grant execute on function public.get_patient_appointment_operations(uuid) to authenticated;

-- Ignore client labels/statuses and validate every link against this patient's chart.
create or replace function private.validate_appointment_operations()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  v_state jsonb; v_choices jsonb; v_link jsonb; v_ids jsonb; v_choice jsonb;
  v_result jsonb := '[]'::jsonb; v_previous jsonb := '[]'::jsonb;
begin
  if new.patient_id is null then new.operations := '[]'::jsonb; return new; end if;
  if jsonb_typeof(new.operations) is distinct from 'array' or jsonb_array_length(new.operations) > 100 then
    raise exception 'Invalid appointment operations' using errcode = '22023';
  end if;
  if new.operations = '[]'::jsonb then return new; end if;
  if tg_op = 'UPDATE' and new.patient_id = old.patient_id then v_previous := old.operations; end if;
  select p.chart_state into v_state from public.patients p where p.id = new.patient_id;
  if not found then raise exception 'Patient unavailable' using errcode = '42501'; end if;
  v_choices := private.appointment_operation_choices(v_state);
  for v_link in select value from jsonb_array_elements(new.operations) loop
    if jsonb_typeof(v_link->'finding_ids') is distinct from 'array' then
      raise exception 'Invalid operation reference' using errcode = '22023';
    end if;
    select jsonb_agg(distinct value order by value) into v_ids from jsonb_array_elements_text(v_link->'finding_ids');
    select value into v_choice from jsonb_array_elements(v_choices) where value->'finding_ids' = v_ids;
    if v_choice is null then
      raise exception 'An operation changed or was deleted. Choose operations again.' using errcode = '22023';
    end if;
    if v_choice->>'status' not in ('P', 'In') and not exists (
      select 1 from jsonb_array_elements(v_previous) previous
      cross join lateral jsonb_array_elements_text(previous->'finding_ids') prior_id
      where v_choice->'finding_ids' ? prior_id.value
    ) then
      raise exception 'Only planned or in-progress operations can be assigned' using errcode = '22023';
    end if;
    if not v_result @> jsonb_build_array(v_choice) then v_result := v_result || jsonb_build_array(v_choice); end if;
  end loop;
  new.operations := v_result;
  return new;
end;
$$;
revoke all on function private.validate_appointment_operations() from public, anon, authenticated;
create trigger validate_appointment_operations before insert or update of operations, patient_id on public.appointments
for each row execute function private.validate_appointment_operations();

-- Chart editors can lack appointment edit rights; only this internal trigger can refresh links.
-- No appointment dates, statuses, or clinical findings are changed by the synchronization.
create or replace function private.sync_appointment_operations_from_chart()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_choices jsonb;
begin
  if auth.uid() is not null and not (private.is_active_user() or private.is_admin()) then
    raise exception 'Active staff required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.appointments a where a.patient_id = new.id and a.operations <> '[]'::jsonb) then return new; end if;
  v_choices := private.appointment_operation_choices(new.chart_state);
  update public.appointments a set operations = refreshed.operations
  from (
    select a2.id, coalesce(jsonb_agg(choice.value order by choice.ordinality)
      filter (where choice.value is not null), '[]'::jsonb) as operations
    from public.appointments a2
    left join lateral jsonb_array_elements(v_choices) with ordinality choice(value, ordinality) on exists (
      select 1 from jsonb_array_elements(a2.operations) linked
      cross join lateral jsonb_array_elements_text(linked->'finding_ids') linked_id
      where choice.value->'finding_ids' ? linked_id.value
    )
    where a2.patient_id = new.id and a2.operations <> '[]'::jsonb
    group by a2.id
  ) refreshed
  where a.id = refreshed.id and a.operations is distinct from refreshed.operations;
  return new;
end;
$$;
revoke all on function private.sync_appointment_operations_from_chart() from public, anon, authenticated;
create trigger sync_appointment_operations_from_chart after update of chart_state on public.patients
for each row when (old.chart_state is distinct from new.chart_state)
execute function private.sync_appointment_operations_from_chart();

notify pgrst, 'reload schema';
