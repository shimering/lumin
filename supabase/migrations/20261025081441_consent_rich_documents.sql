-- Strict document data, never executable HTML. Null preserves legacy records.
create function private.consent_document_valid(value jsonb) returns boolean
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
        else return false; end if;
      end loop;
    end if;
  end loop;
  return plain_length<=40001;
end;
$$;
create function private.consent_document_text(value jsonb) returns text
language sql immutable security invoker set search_path='' as $$
  select coalesce(string_agg(case when jsonb_typeof(op->'insert')='string' then op->>'insert' else '{{'||(op#>>'{insert,consentVariable}')||'}}' end,'' order by ordinal),'') from jsonb_array_elements(value->'ops') with ordinality as rows(op,ordinal);
$$;
revoke all on function private.consent_document_valid(jsonb),private.consent_document_text(jsonb) from public,anon,authenticated;
grant execute on function private.consent_document_valid(jsonb),private.consent_document_text(jsonb) to authenticated,service_role;
alter table public.consent_templates
  add column content_en jsonb,
  add column content_ar jsonb,
  add constraint consent_template_document_en check (case when content_en is null then true when private.consent_document_valid(content_en) then btrim(private.consent_document_text(content_en),E' \t\n\r')=btrim(body_en,E' \t\n\r') else false end),
  add constraint consent_template_document_ar check (case when content_ar is null then true when private.consent_document_valid(content_ar) then btrim(private.consent_document_text(content_ar),E' \t\n\r')=btrim(body_ar,E' \t\n\r') else false end);
alter table public.patient_consents
  add column content jsonb,
  add column alternate_title text not null default '' check(length(alternate_title)<=200),
  add column alternate_body text not null default '' check(length(alternate_body)<=40000),
  add column alternate_content jsonb,
  add constraint patient_consent_document check (case when content is null then true when private.consent_document_valid(content) then btrim(private.consent_document_text(content),E' \t\n\r')=btrim(body,E' \t\n\r') else false end),
  add constraint patient_consent_alternate_document check (case when alternate_content is null then true when private.consent_document_valid(alternate_content) then btrim(private.consent_document_text(alternate_content),E' \t\n\r')=btrim(alternate_body,E' \t\n\r') else false end);
