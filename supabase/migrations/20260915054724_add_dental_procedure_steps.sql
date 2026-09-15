create or replace function public.is_valid_dental_procedure_steps(value jsonb)
returns boolean
language plpgsql
immutable
strict
set search_path = pg_catalog, public
as $$
declare
  item jsonb;
  step_percentage numeric;
  percentage_total numeric := 0;
  step_ids text[] := array[]::text[];
begin
  if jsonb_typeof(value) <> 'array' or jsonb_array_length(value) > 5 then
    return false;
  end if;

  if jsonb_array_length(value) = 0 then
    return true;
  end if;

  for item in select entry from jsonb_array_elements(value) as entries(entry)
  loop
    if jsonb_typeof(item) <> 'object'
      or jsonb_typeof(item -> 'id') <> 'string'
      or jsonb_typeof(item -> 'name') <> 'string'
      or jsonb_typeof(item -> 'percentage') <> 'number'
      or (item ->> 'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or length(btrim(item ->> 'name')) not between 1 and 100
      or (item ->> 'id') = any(step_ids)
    then
      return false;
    end if;

    step_percentage := (item ->> 'percentage')::numeric;
    if step_percentage <= 0 or step_percentage > 100 then
      return false;
    end if;

    step_ids := array_append(step_ids, item ->> 'id');
    percentage_total := percentage_total + step_percentage;
  end loop;

  return percentage_total = 100;
end;
$$;

alter table public.dental_operations
  add column if not exists procedure_steps jsonb not null default '[]'::jsonb;

alter table public.dental_operations
  drop constraint if exists dental_operations_procedure_steps_valid;

alter table public.dental_operations
  add constraint dental_operations_procedure_steps_valid
  check (public.is_valid_dental_procedure_steps(procedure_steps));

comment on column public.dental_operations.procedure_steps is
  'Up to five ordered clinical steps. Empty means the procedure is completed as one unit; otherwise percentages must total exactly 100.';

comment on function public.is_valid_dental_procedure_steps(jsonb) is
  'Validates dental procedure step IDs, labels, percentages, count, uniqueness, and the required 100 percent total.';
