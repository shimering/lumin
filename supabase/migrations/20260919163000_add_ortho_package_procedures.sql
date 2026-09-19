-- Migration: Add ortho package procedures support
-- 1. Add is_ortho_package column to dental_operations
alter table public.dental_operations
  add column if not exists is_ortho_package boolean not null default false;

comment on column public.dental_operations.is_ortho_package is
  'When true, procedure acts as an overarching multi-visit package with indented child visits, dedicated visit dates, inline notes, and visit-based invoicing.';

-- 2. Update add_chart_findings_to_patient_invoice to support invoicing child ortho visits
create or replace function public.add_chart_findings_to_patient_invoice(
  p_patient_id uuid,
  p_finding_ids uuid[],
  p_invoice_date date
)
returns table(invoice_id bigint, added_count integer, total_amount numeric)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_chart jsonb;
  v_finding_id uuid;
  v_finding jsonb;
  v_tooth_id text;
  v_surfaces text[];
  v_operation public.dental_operations%rowtype;
  v_operation_status text;
  v_price numeric(12,2);
  v_price_text text;
  v_batch_id text;
  v_billing_multiplier integer;
  v_billing_multiplier_text text;
  v_batch_member_ids text[];
  v_batch_member_count integer;
  v_batch_total numeric(12,2);
  v_batch_share numeric(12,2);
  v_invoice_id bigint;
  v_doctor_name text;
  v_added_count integer := 0;
  v_total_amount numeric(12,2) := 0;
  v_inserted_id bigint;
begin
  if auth.uid() is null
    or not private.is_active_user()
    or not (private.is_admin() or private.has_page_permission('chart')) then
    raise exception 'You are not authorized to create invoice items.'
      using errcode = '42501';
  end if;

  if coalesce(cardinality(p_finding_ids), 0) = 0 then
    raise exception 'Select at least one documented finding.'
      using errcode = '22023';
  end if;

  select chart_state
    into v_chart
    from public.patients
    where id = p_patient_id;

  if not found then
    raise exception 'The selected patient no longer exists.'
      using errcode = '22023';
  end if;

  select coalesce(nullif(btrim(full_name), ''), 'Clinic user')
    into v_doctor_name
    from public.user_profiles
    where user_id = auth.uid();

  foreach v_finding_id in array p_finding_ids loop
    v_finding := null;
    v_tooth_id := null;
    v_surfaces := '{}'::text[];
    v_batch_id := null;
    v_batch_member_ids := '{}'::text[];
    v_batch_member_count := 0;

    -- Check direct mouthOperations
    select mouth_finding.value
      into v_finding
      from jsonb_array_elements(
        case
          when jsonb_typeof(v_chart->'_meta'->'mouthOperations') = 'array'
            then v_chart->'_meta'->'mouthOperations'
          else '[]'::jsonb
        end
      ) as mouth_finding(value)
      where mouth_finding.value->>'id' = v_finding_id::text
      limit 1;

    -- Check direct wholeOperations
    if v_finding is null then
      select tooth.key, whole_finding.value
        into v_tooth_id, v_finding
        from jsonb_each(coalesce(v_chart, '{}'::jsonb)) as tooth(key, value)
        cross join lateral jsonb_array_elements(
          case
            when jsonb_typeof(tooth.value->'wholeOperations') = 'array'
              then tooth.value->'wholeOperations'
            else '[]'::jsonb
          end
        ) as whole_finding(value)
        where tooth.key <> '_meta'
          and whole_finding.value->>'id' = v_finding_id::text
        limit 1;
    end if;

    -- Check direct surface findings
    if v_finding is null then
      select tooth.key, surface_entry.value
        into v_tooth_id, v_finding
        from jsonb_each(coalesce(v_chart, '{}'::jsonb)) as tooth(key, value)
        cross join lateral jsonb_each(
          case
            when jsonb_typeof(tooth.value->'surfaces') = 'object'
              then tooth.value->'surfaces'
            else '{}'::jsonb
          end
        ) as surface_finding(key, value)
        cross join lateral jsonb_array_elements(
          case jsonb_typeof(surface_finding.value)
            when 'array' then surface_finding.value
            when 'object' then jsonb_build_array(surface_finding.value)
            else '[]'::jsonb
          end
        ) as surface_entry(value)
        where surface_entry.value->>'id' = v_finding_id::text
        limit 1;

      if v_finding is not null then
        select coalesce(array_agg(surface_finding.key order by surface_finding.key), '{}'::text[])
          into v_surfaces
          from jsonb_each(
            case
              when jsonb_typeof(v_chart->v_tooth_id->'surfaces') = 'object'
                then v_chart->v_tooth_id->'surfaces'
              else '{}'::jsonb
            end
          ) as surface_finding(key, value)
          where exists (
            select 1
              from jsonb_array_elements(
                case jsonb_typeof(surface_finding.value)
                  when 'array' then surface_finding.value
                  when 'object' then jsonb_build_array(surface_finding.value)
                  else '[]'::jsonb
                end
              ) as surface_entry(value)
             where surface_entry.value->>'id' = v_finding_id::text
          );
      end if;
    end if;

    -- Check child orthoVisits under mouthOperations
    if v_finding is null then
      select
        null as tooth_id,
        jsonb_build_object(
          'id', visit.value->>'id',
          'code', mouth_finding.value->>'code',
          'status', coalesce(visit.value->>'status', 'C'),
          'price', visit.value->>'price',
          'doctorId', coalesce(visit.value->>'doctorId', mouth_finding.value->>'doctorId'),
          'doctorName', coalesce(visit.value->>'doctorName', mouth_finding.value->>'doctorName'),
          'visitNumber', visit.value->>'visitNumber',
          'isOrthoVisit', true,
          'notes', visit.value->>'notes'
        )
        into v_tooth_id, v_finding
        from jsonb_array_elements(
          case
            when jsonb_typeof(v_chart->'_meta'->'mouthOperations') = 'array'
              then v_chart->'_meta'->'mouthOperations'
            else '[]'::jsonb
          end
        ) as mouth_finding(value)
        cross join lateral jsonb_array_elements(
          case
            when jsonb_typeof(mouth_finding.value->'orthoVisits') = 'array'
              then mouth_finding.value->'orthoVisits'
            else '[]'::jsonb
          end
        ) as visit(value)
        where visit.value->>'id' = v_finding_id::text
        limit 1;
    end if;

    -- Check child orthoVisits under wholeOperations
    if v_finding is null then
      select
        tooth.key,
        jsonb_build_object(
          'id', visit.value->>'id',
          'code', whole_finding.value->>'code',
          'status', coalesce(visit.value->>'status', 'C'),
          'price', visit.value->>'price',
          'doctorId', coalesce(visit.value->>'doctorId', whole_finding.value->>'doctorId'),
          'doctorName', coalesce(visit.value->>'doctorName', whole_finding.value->>'doctorName'),
          'visitNumber', visit.value->>'visitNumber',
          'isOrthoVisit', true,
          'notes', visit.value->>'notes'
        )
        into v_tooth_id, v_finding
        from jsonb_each(coalesce(v_chart, '{}'::jsonb)) as tooth(key, value)
        cross join lateral jsonb_array_elements(
          case
            when jsonb_typeof(tooth.value->'wholeOperations') = 'array'
              then tooth.value->'wholeOperations'
            else '[]'::jsonb
          end
        ) as whole_finding(value)
        cross join lateral jsonb_array_elements(
          case
            when jsonb_typeof(whole_finding.value->'orthoVisits') = 'array'
              then whole_finding.value->'orthoVisits'
            else '[]'::jsonb
          end
        ) as visit(value)
        where tooth.key <> '_meta'
          and visit.value->>'id' = v_finding_id::text
        limit 1;
    end if;

    if v_finding is null then
      raise exception 'A selected documented finding no longer exists.'
        using errcode = '22023';
    end if;

    select *
      into v_operation
      from public.dental_operations
      where code = v_finding->>'code'
      limit 1;

    if not found then
      raise exception 'The operation configured for a selected finding no longer exists.'
        using errcode = '22023';
    end if;

    -- Main package procedure itself cannot be invoiced directly
    if (v_operation.is_ortho_package is true or coalesce(v_finding->>'isOrthoPackage', v_finding->>'is_ortho_package') = 'true')
       and coalesce((v_finding->>'isOrthoVisit')::boolean, false) is false then
      raise exception 'Package procedure fee cannot be invoiced directly. Please invoice individual visits.'
        using errcode = '22023';
    end if;

    v_operation_status := v_finding->>'status';
    if v_operation_status not in ('P', 'In', 'C', 'E') then
      v_operation_status := 'P';
    end if;

    v_price_text := nullif(btrim(v_finding->>'price'), '');
    if v_price_text is not null and v_price_text ~ '^[0-9]+([.][0-9]{1,2})?$' then
      v_price := v_price_text::numeric(12,2);
    else
      v_price := v_operation.price;
    end if;

    if v_price <= 0 then
      raise exception 'Every selected finding must have a price greater than zero.'
        using errcode = '22023';
    end if;

    v_batch_id := nullif(btrim(coalesce(v_finding->>'batchId', v_finding->>'batch_id')), '');
    if v_batch_id is not null then
      select coalesce(array_agg(candidate.finding_id order by candidate.finding_id), '{}'::text[])
        into v_batch_member_ids
        from (
          select distinct whole_finding.value->>'id' as finding_id
            from jsonb_each(coalesce(v_chart, '{}'::jsonb)) as tooth(key, value)
            cross join lateral jsonb_array_elements(
              case
                when jsonb_typeof(tooth.value->'wholeOperations') = 'array'
                  then tooth.value->'wholeOperations'
                else '[]'::jsonb
              end
            ) as whole_finding(value)
           where tooth.key <> '_meta'
             and coalesce(whole_finding.value->>'batchId', whole_finding.value->>'batch_id') = v_batch_id
             and whole_finding.value->>'code' = v_finding->>'code'
          union
          select distinct surface_entry.value->>'id' as finding_id
            from jsonb_each(coalesce(v_chart, '{}'::jsonb)) as tooth(key, value)
            cross join lateral jsonb_each(
              case
                when jsonb_typeof(tooth.value->'surfaces') = 'object'
                  then tooth.value->'surfaces'
                else '{}'::jsonb
              end
            ) as surface_finding(key, value)
            cross join lateral jsonb_array_elements(
              case jsonb_typeof(surface_finding.value)
                when 'array' then surface_finding.value
                when 'object' then jsonb_build_array(surface_finding.value)
                else '[]'::jsonb
              end
            ) as surface_entry(value)
           where tooth.key <> '_meta'
             and coalesce(surface_entry.value->>'batchId', surface_entry.value->>'batch_id') = v_batch_id
             and surface_entry.value->>'code' = v_finding->>'code'
        ) as candidate
       where nullif(btrim(candidate.finding_id), '') is not null;

      v_batch_member_count := coalesce(cardinality(v_batch_member_ids), 0);
      if v_batch_member_count > 1 then
        v_billing_multiplier_text := nullif(btrim(coalesce(v_finding->>'billingMultiplier', v_finding->>'billing_multiplier')), '');
        if v_billing_multiplier_text is not null
          and v_billing_multiplier_text ~ '^[0-9]+$'
          and v_billing_multiplier_text::numeric between 1 and 999 then
          v_billing_multiplier := v_billing_multiplier_text::integer;
        else
          v_billing_multiplier := v_batch_member_count;
        end if;

        v_batch_total := round(v_price * v_billing_multiplier, 2);
        v_batch_share := round(v_batch_total / v_batch_member_count, 2);
        if v_finding_id::text = v_batch_member_ids[v_batch_member_count] then
          v_price := v_batch_total - (v_batch_share * (v_batch_member_count - 1));
        else
          v_price := v_batch_share;
        end if;

        if v_price <= 0 then
          raise exception 'The batch total is too small to preserve a positive invoice amount for every tooth.'
            using errcode = '22023';
        end if;
      end if;
    end if;

    if v_invoice_id is null then
      insert into public.patient_invoices (patient_id, invoice_date, created_by)
      values (p_patient_id, coalesce(p_invoice_date, current_date), auth.uid())
      on conflict (patient_id, invoice_date)
      do update set updated_at = now()
      returning id into v_invoice_id;
    end if;

    insert into public.patient_invoice_items (
      invoice_id,
      finding_id,
      operation_id,
      operation_code,
      operation_name,
      operation_status,
      tooth_id,
      surfaces,
      unit_price,
      quantity,
      doctor_id,
      doctor_name
    )
    values (
      v_invoice_id,
      v_finding_id,
      v_operation.id,
      v_operation.code,
      case
        when coalesce((v_finding->>'isOrthoVisit')::boolean, false) is true
          then v_operation.name || ' - Visit ' || coalesce(v_finding->>'visitNumber', '1')
        else v_operation.name
      end,
      v_operation_status,
      v_tooth_id,
      v_surfaces,
      v_price,
      1,
      auth.uid(),
      coalesce(v_doctor_name, 'Clinic user')
    )
    on conflict do nothing
    returning id into v_inserted_id;

    if v_inserted_id is not null then
      v_added_count := v_added_count + 1;
      v_total_amount := v_total_amount + v_price;
    end if;
    v_inserted_id := null;
  end loop;

  return query
  select v_invoice_id, v_added_count, v_total_amount;
end;
$function$;
