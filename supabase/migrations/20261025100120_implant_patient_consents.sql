-- Patient implant consent settings and independently saved procedure snapshots.
alter table public.dental_operations
  add column is_implant_procedure boolean not null default false,
  add column implant_type text not null default '' check(length(implant_type)<=160);
update public.dental_operations set is_implant_procedure=true,track_implant_progress=true,
  implant_type=case code when 'dz_implantation_i9' then 'Economic (dual)' else 'Standard (b&b)' end
where code in ('dz_implantation_i9','dz_implantation_i10');

alter table public.consent_templates add column form_type text not null default 'general' check(form_type in ('general','implant'));
-- Identify only the bundled starter. Clinic-created templates opt in in Admin.
update public.consent_templates set form_type='implant'
where title_en='Dental implants' and source_url='https://dentolize.com/tools/dental-consent-form-generator/';

create function private.consent_assignments_valid(value jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare item jsonb; seen text[]:='{}'; finding text;
begin
  if jsonb_typeof(value) is distinct from 'array' or jsonb_array_length(value)>1000 or octet_length(value::text)>500000 then return false; end if;
  for item in select * from jsonb_array_elements(value) loop
    if jsonb_typeof(item) is distinct from 'object' then return false; end if;
    finding:=item->>'finding_id';
    if finding is null or finding!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or finding=any(seen) then return false; end if;
    seen:=array_append(seen,finding);
    if jsonb_typeof(item->'code') is distinct from 'string' or length(item->>'code') not between 1 and 100
      or jsonb_typeof(item->'name') is distinct from 'string' or length(item->>'name')>300
      or jsonb_typeof(item->'tooth') is distinct from 'string' or length(item->>'tooth')>100
      or jsonb_typeof(item->'tooth_label') is distinct from 'string' or length(item->>'tooth_label')>200
      or jsonb_typeof(item->'implant_type') is distinct from 'string' or length(item->>'implant_type')>160
      or jsonb_typeof(item->'is_implant') is distinct from 'boolean' then return false; end if;
    if item->'price' is distinct from 'null'::jsonb then
      if jsonb_typeof(item->'price') is distinct from 'number' then return false; end if;
      if (item->>'price')::numeric<0 or (item->>'price')::numeric>1000000000 then return false; end if;
    end if;
    if item->>'billing_multiplier' is not null then
      if jsonb_typeof(item->'billing_multiplier')<>'number' or (item->>'billing_multiplier')!~'^[0-9]+$' then return false; end if;
      if (item->>'billing_multiplier')::numeric not between 1 and 999 then return false; end if;
    end if;
    if item?'batch_member_count' and (jsonb_typeof(item->'batch_member_count')<>'number' or (item->>'batch_member_count')!~'^[0-9]+$') then return false; end if;
  end loop;
  return true;
end;
$$;
create function private.implant_consent_terms_valid(value jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
begin
  if value is null then return true; end if;
  if jsonb_typeof(value) is distinct from 'object' or value-'interval_months'-'first_visit_percent'-'payment_mode'-'monthly_count'<>'{}'::jsonb then return false; end if;
  if jsonb_typeof(value->'interval_months') is distinct from 'number' or (value->>'interval_months')!~'^[0-9]+$'
    or jsonb_typeof(value->'monthly_count') is distinct from 'number' or (value->>'monthly_count')!~'^[0-9]+$'
    or jsonb_typeof(value->'first_visit_percent') is distinct from 'number' or coalesce(value->>'payment_mode','') not in ('two','monthly') then return false; end if;
  return (value->>'interval_months')::numeric between 1 and 24 and (value->>'monthly_count')::numeric between 1 and 60 and (value->>'first_visit_percent')::numeric between 0 and 100;
end;
$$;
revoke all on function private.consent_assignments_valid(jsonb),private.implant_consent_terms_valid(jsonb) from public,anon,authenticated;
grant execute on function private.consent_assignments_valid(jsonb),private.implant_consent_terms_valid(jsonb) to authenticated,service_role;
alter table public.patient_consents
  add column procedure_assignments jsonb not null default '[]' check(private.consent_assignments_valid(procedure_assignments)),
  add column implant_terms jsonb check(private.implant_consent_terms_valid(implant_terms));

create or replace function private.guard_patient_consent() returns trigger language plpgsql security invoker set search_path='' as $$
declare v_template public.consent_templates; v_patient public.patients; assignment_ids uuid[];
begin
  if tg_op='UPDATE' then
    if old.status='finalized' then raise exception 'Finalized consents are immutable'; end if;
    if (new.id,new.patient_id,new.template_id,new.template_revision,new.patient_data,new.created_by,new.created_at,new.language)
       is distinct from (old.id,old.patient_id,old.template_id,old.template_revision,old.patient_data,old.created_by,old.created_at,old.language)
    then raise exception 'Consent identity and template snapshot cannot change'; end if;
    new.revision:=old.revision+1;
  else
    select * into v_template from public.consent_templates where id=new.template_id;
    if not found or not v_template.active then raise exception 'Choose an active consent template'; end if;
    if new.template_revision<>v_template.revision then raise exception 'Template changed; reopen the form'; end if;
    if v_template.form_type='implant' and new.implant_terms is null then raise exception 'Implant consent terms required'; end if;
    select * into strict v_patient from public.patients where id=new.patient_id;
    new.patient_data:=jsonb_build_object('name',v_patient.name,'number',coalesce(v_patient.patient_number::text,''),'birth_date',coalesce(v_patient.birth_date::text,''),'phone',coalesce(v_patient.phone,''),'address',coalesce(v_patient.address,''),'age',v_patient.age,'gender',coalesce(v_patient.gender,''));
    new.created_by:=auth.uid(); new.created_at:=now(); new.revision:=1;
  end if;
  if not private.consent_assignments_valid(new.procedure_assignments) or not private.implant_consent_terms_valid(new.implant_terms) then raise exception 'Invalid consent procedure assignments or implant terms'; end if;
  if jsonb_array_length(new.procedure_assignments)>0 or new.implant_terms is not null then
    select coalesce(array_agg((item->>'finding_id')::uuid order by item->>'finding_id'),'{}') into assignment_ids from jsonb_array_elements(new.procedure_assignments) item;
    if assignment_ids is distinct from array(select unnest(new.finding_ids) order by 1) then raise exception 'Assigned procedure IDs must match consent findings'; end if;
  end if;
  if new.implant_terms is not null and (jsonb_array_length(new.procedure_assignments)=0 or exists(select 1 from jsonb_array_elements(new.procedure_assignments) item where item->>'is_implant'<>'true' or btrim(item->>'tooth')='' or btrim(item->>'implant_type')='' or item->'price'='null'::jsonb)) then raise exception 'Implant consent needs an implant type, tooth and price for each procedure'; end if;
  if tg_op='UPDATE' and old.implant_terms is not null and new.implant_terms is null then raise exception 'Implant consent terms cannot be removed'; end if;
  if new.doctor_id is not null and not exists (select 1 from private.consent_doctors() p where p.user_id=new.doctor_id)
  then raise exception 'Choose an active treating doctor'; end if;
  new.updated_at:=now();
  new.finalized_at:=case when new.status='finalized' then now() else null end;
  return new;
end;
$$;
