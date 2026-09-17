create or replace function public.get_doctor_working_schedules()
returns table (
  user_id uuid,
  weekly_schedule jsonb
)
language sql
security definer
set search_path = public
stable
as $func$
  select s.user_id, s.weekly_schedule
  from public.hr_staff_settings s
  join public.user_profiles p on p.user_id = s.user_id
  where p.active = true and p.is_doctor = true;
$func$;

grant execute on function public.get_doctor_working_schedules() to authenticated;
