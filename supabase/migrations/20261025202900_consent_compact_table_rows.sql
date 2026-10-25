-- Permit compact and content-fitting rows without changing saved documents.
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
    elsif jsonb_typeof(op->'insert')='object' and (op->'insert')-'consentVariable'='{}'::jsonb and op#>>'{insert,consentVariable}'=any(array['patient_name','patient_number','birth_date','phone','address','age','gender','doctor_name','date','procedure','details','doctor_name_ar','implant_count','implant_types','implant_teeth','implant_unit_price','implant_total','implant_details','payment_arrangement','first_visit_fee_mode','first_visit_percent','first_visit_amount','restoration_months','remaining_amount','monthly_installment_count','monthly_installment_amount','final_installment_amount'])
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
        elsif item.key='consentField' then if jsonb_typeof(item.value)<>'string' or not val=any(array['patient_name','patient_number','birth_date','phone','address','age','gender','doctor_name','date','procedure','details','doctor_name_ar','implant_count','implant_types','implant_teeth','implant_unit_price','implant_total','implant_details','payment_arrangement','first_visit_fee_mode','first_visit_percent','first_visit_amount','restoration_months','remaining_amount','monthly_installment_count','monthly_installment_amount','final_installment_amount']) then return false; end if;
        elsif item.key='consentFieldId' then if jsonb_typeof(item.value)<>'string' or val!~'^[a-zA-Z0-9_-]{1,80}$' then return false; end if;
        elsif item.key='table' then if jsonb_typeof(item.value)<>'string' or val!~'^[a-zA-Z0-9_-]{1,80}$' then return false; end if;
        elsif item.key=any(array['cellWidth','cellHeight']) then
          if item.key='cellHeight' and val='auto' then null;
          else
            if jsonb_typeof(item.value)<>'string' or val!~'^[0-9]{2,3}px$' then return false; end if;
            if item.key='cellWidth' and left(val,length(val)-2)::integer not between 64 and 640 then return false; end if;
            if item.key='cellHeight' and left(val,length(val)-2)::integer not between 16 and 480 then return false; end if;
          end if;
        else return false; end if;
      end loop;
    end if;
  end loop;
  return plain_length<=40001;
end;
$$;



notify pgrst,'reload schema';
