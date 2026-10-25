-- Extend validated consent formatting and payment options; preserve existing text.
create or replace function private.consent_document_valid(value jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare op jsonb; attrs jsonb; item record; plain_length integer:=0; val text;
begin
  if value is null then return true; end if;
  if jsonb_typeof(value)<>'object' or value-'ops'<>'{}'::jsonb or jsonb_typeof(value->'ops') is distinct from 'array' then return false; end if;
  if jsonb_array_length(value->'ops') not between 1 and 2500 or octet_length(value::text)>250000 then return false; end if;
  for op in select * from jsonb_array_elements(value->'ops') loop
    if jsonb_typeof(op)<>'object' or op-'insert'-'attributes'<>'{}'::jsonb then return false; end if;
    if jsonb_typeof(op->'insert')='string' then plain_length:=plain_length+length(op->>'insert');
    elsif jsonb_typeof(op->'insert')='object' and (op->'insert')-'consentVariable'='{}'::jsonb and op#>>'{insert,consentVariable}'=any(array['patient_name','patient_number','birth_date','phone','address','age','gender','doctor_name','date','procedure','details'])
      then plain_length:=plain_length+length(op#>>'{insert,consentVariable}')+4;
    else return false; end if;
    if op?'attributes' then
      attrs:=op->'attributes';if jsonb_typeof(attrs)<>'object' then return false; end if;
      for item in select * from jsonb_each(attrs) loop
        val:=item.value#>>'{}';
        if item.key=any(array['bold','italic','underline','strike','blockquote']) then if item.value<>'true'::jsonb then return false; end if;
        elsif item.key='font' then if jsonb_typeof(item.value)<>'string' or not val=any(array['Arial','Tahoma','Amiri','Segoe UI','Times New Roman','Georgia','Courier New']) then return false; end if;
        elsif item.key='size' then if jsonb_typeof(item.value)<>'string' or not val=any(array['10px','12px','14px','16px','18px','20px','24px','28px','32px','36px','48px']) then return false; end if;
        elsif item.key=any(array['color','background']) then if jsonb_typeof(item.value)<>'string' or val!~'^#[0-9a-fA-F]{6}$' then return false; end if;
        elsif item.key='header' then if jsonb_typeof(item.value)<>'number' or not val=any(array['1','2','3']) then return false; end if;
        elsif item.key='indent' then if jsonb_typeof(item.value)<>'number' or not val=any(array['1','2','3','4','5','6','7','8']) then return false; end if;
        elsif item.key='align' then if jsonb_typeof(item.value)<>'string' or not val=any(array['left','right','center','justify']) then return false; end if;
        elsif item.key='direction' then if jsonb_typeof(item.value)<>'string' or not val=any(array['rtl','ltr']) then return false; end if;
        elsif item.key='list' then if jsonb_typeof(item.value)<>'string' or not val=any(array['bullet','ordered']) then return false; end if;
        elsif item.key='script' then if jsonb_typeof(item.value)<>'string' or not val=any(array['sub','super']) then return false; end if;
        elsif item.key='table' then if jsonb_typeof(item.value)<>'string' or val!~'^[a-zA-Z0-9_-]{1,80}$' then return false; end if;
        elsif item.key=any(array['cellWidth','cellHeight']) then
          if jsonb_typeof(item.value)<>'string' or val!~'^[0-9]{2,3}px$' then return false; end if;
          if item.key='cellWidth' and left(val,length(val)-2)::integer not between 64 and 640 then return false; end if;
          if item.key='cellHeight' and left(val,length(val)-2)::integer not between 32 and 480 then return false; end if;
        else return false; end if;
      end loop;
    end if;
  end loop;
  return plain_length<=40001;
end;
$$;

create or replace function private.implant_consent_terms_valid(value jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
begin
  if value is null then return true; end if;
  if jsonb_typeof(value) is distinct from 'object' or value-'interval_months'-'first_visit_percent'-'payment_mode'-'monthly_count'-'first_visit_mode'-'first_visit_amount'<>'{}'::jsonb then return false; end if;
  if jsonb_typeof(value->'interval_months') is distinct from 'number' or (value->>'interval_months')!~'^[0-9]+$'
    or jsonb_typeof(value->'monthly_count') is distinct from 'number' or (value->>'monthly_count')!~'^[0-9]+$'
    or jsonb_typeof(value->'first_visit_percent') is distinct from 'number' or coalesce(value->>'payment_mode','') not in ('two','monthly') then return false; end if;
  if value?'first_visit_mode' and (jsonb_typeof(value->'first_visit_mode')<>'string' or value->>'first_visit_mode' not in ('percent','amount')) then return false; end if;
  if value->>'first_visit_mode'='amount' and not (value?'first_visit_amount') then return false; end if;
  if value?'first_visit_amount' then
    if jsonb_typeof(value->'first_visit_amount')<>'number' then return false; end if;
    if (value->>'first_visit_amount')::numeric not between 0 and 1000000000 then return false; end if;
  end if;
  return (value->>'interval_months')::numeric between 1 and 24 and (value->>'monthly_count')::numeric between 1 and 60 and (value->>'first_visit_percent')::numeric between 0 and 100;
end;
$$;

create or replace function private.guard_patient_consent() returns trigger language plpgsql security invoker set search_path='' as $$
declare v_template public.consent_templates; v_patient public.patients; assignment_ids uuid[]; total_cents numeric;
begin
  if tg_op='UPDATE' then
    if old.status='finalized' and (new.status<>'draft' or (to_jsonb(new)-'status'-'revision'-'updated_at'-'finalized_at') is distinct from (to_jsonb(old)-'status'-'revision'-'updated_at'-'finalized_at')) then raise exception 'Reopen the finalized consent before editing'; end if;
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
  if new.implant_terms->>'first_visit_mode'='amount' then
    select coalesce(sum(case when coalesce(item->>'batch_id','')<>'' and item->>'billing_multiplier' is not null then
      case when member_index=member_count-1 then price_cents*(item->>'billing_multiplier')::numeric-floor(price_cents*(item->>'billing_multiplier')::numeric/member_count)*(member_count-1)
      else floor(price_cents*(item->>'billing_multiplier')::numeric/member_count) end
      else price_cents end),0) into total_cents
    from (select item,round((item->>'price')::numeric*100) price_cents,
      greatest(1,case when item->>'batch_member_count'~'^[0-9]+$' then (item->>'batch_member_count')::numeric else 1 end) member_count,
      case when item->>'batch_member_index'~'^[0-9]+$' then (item->>'batch_member_index')::numeric else -1 end member_index
      from jsonb_array_elements(new.procedure_assignments) item) entries;
    if round((new.implant_terms->>'first_visit_amount')::numeric*100)>total_cents then raise exception 'First visit amount cannot exceed total implant fee'; end if;
  end if;
  if new.doctor_id is not null and not exists (select 1 from private.consent_doctors() p where p.user_id=new.doctor_id)
  then raise exception 'Choose an active treating doctor'; end if;
  new.updated_at:=now();
  new.finalized_at:=case when new.status='finalized' then now() else null end;
  return new;
end;
$$;

-- Clinical permissions also govern explicit reopening and deletion.
grant delete on public.patient_consents to authenticated;
create policy patient_consents_remove on public.patient_consents for delete to authenticated
using (((select private.has_page_permission('patients')) or (select private.has_page_permission('chart'))) and exists (select 1 from public.patients p where p.id=patient_id));
