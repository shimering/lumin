-- Keep patient-specific signature labels with the existing immutable layout.
create or replace function private.consent_page_layout_valid(value jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare item record; label record; number_value numeric;
begin
  if jsonb_typeof(value) is distinct from 'object' or octet_length(value::text)>6000 then return false; end if;
  for item in select * from jsonb_each(value) loop
    if item.key=any(array['logo_visible','signatures_visible','signature_divider']) then
      if jsonb_typeof(item.value)<>'boolean' then return false; end if;
    elsif item.key=any(array['signature_labels_en','signature_labels_ar']) then
      if jsonb_typeof(item.value)<>'object' then return false; end if;
      for label in select * from jsonb_each(item.value) loop
        if not label.key=any(array['patient','relationship','doctor','witness','name','date'])
          or jsonb_typeof(label.value)<>'string' or char_length(label.value#>>'{}')>160 then return false; end if;
      end loop;
    elsif item.key='logo_align' then
      if jsonb_typeof(item.value)<>'string' or not (item.value#>>'{}')=any(array['left','center','right','start','end']) then return false; end if;
    elsif item.key='logo_pages' then
      if jsonb_typeof(item.value)<>'string' or not (item.value#>>'{}')=any(array['first','all']) then return false; end if;
    elsif item.key='frame' then
      if jsonb_typeof(item.value)<>'string' or not (item.value#>>'{}')=any(array['none','single','double','rounded']) then return false; end if;
    elsif item.key=any(array['logo_width_mm','logo_offset_mm','margin_top_mm','margin_bottom_mm','margin_left_mm','margin_right_mm']) then
      if jsonb_typeof(item.value)<>'number' then return false; end if;
      number_value:=(item.value#>>'{}')::numeric;
      if item.key='logo_width_mm' and number_value not between 10 and 80 then return false; end if;
      if item.key='logo_offset_mm' and number_value not between 0 and 40 then return false; end if;
      if item.key=any(array['margin_top_mm','margin_bottom_mm']) and number_value not between 0 and 35 then return false; end if;
      if item.key=any(array['margin_left_mm','margin_right_mm']) and number_value not between 8 and 35 then return false; end if;
    else return false;
    end if;
  end loop;
  if value->>'frame'=any(array['single','double','rounded']) then
    if coalesce((value->>'margin_top_mm')::numeric,0)<8 or coalesce((value->>'margin_bottom_mm')::numeric,0)<8
      or coalesce((value->>'margin_left_mm')::numeric,12)<8 or coalesce((value->>'margin_right_mm')::numeric,12)<8 then return false; end if;
  end if;
  return true;
end;
$$;
revoke all on function private.consent_page_layout_valid(jsonb) from public,anon;
grant execute on function private.consent_page_layout_valid(jsonb) to authenticated,service_role;
notify pgrst,'reload schema';
