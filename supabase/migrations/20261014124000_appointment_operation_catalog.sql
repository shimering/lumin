-- Appointment staff need operation names and configured category icons, without chart or price access.
create or replace function private.appointment_operation_catalog()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not coalesce(private.is_admin() or
    (private.is_active_user() and private.has_page_permission('appointments')), false) then
    raise exception 'Appointment access required' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'code', o.code, 'name', o.name, 'category_name', s.name, 'icon_name', s.icon_name
    ) order by o.name, o.code)
    from public.dental_operations o left join public.dental_specialties s on s.id = o.specialty_id
  ), '[]'::jsonb);
end;
$$;
revoke all on function private.appointment_operation_catalog() from public, anon;
grant execute on function private.appointment_operation_catalog() to authenticated;

create or replace function public.get_appointment_operation_catalog()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select private.appointment_operation_catalog();
$$;
revoke all on function public.get_appointment_operation_catalog() from public, anon;
grant execute on function public.get_appointment_operation_catalog() to authenticated;
notify pgrst, 'reload schema';
