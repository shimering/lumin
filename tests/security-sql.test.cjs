const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
let PGlite;try{({PGlite}=require('@electric-sql/pglite'))}catch(_){}

test('security migration enforces anonymous, active staff, permission and rotated-key boundaries', {skip:!PGlite && 'Provide PGlite through NODE_PATH for isolated PostgreSQL checks'},async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema private; create schema storage;
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.user_id',true),'')::uuid$$;
    create function auth.jwt() returns jsonb language sql as $$select jsonb_build_object('role',coalesce(current_setting('test.jwt_role',true),'anon'))$$;
    create function private.is_admin() returns boolean language sql as $$select coalesce(current_setting('test.admin',true),'false')='true'$$;
    create function private.is_active_user() returns boolean language sql as $$select coalesce(current_setting('test.active',true),'false')='true'$$;
    create function private.has_page_permission(p_page text) returns boolean language sql as $$select p_page=any(string_to_array(coalesce(current_setting('test.pages',true),''),','))$$;
    create table public.clinic_settings(id integer,storage_secret_key text);
    insert into public.clinic_settings values(1,repeat('a',64));
    create table public.patient_media_details(patient_id uuid,relative_path text,display_name text,note text,tooth_id text,tooth_ids text[],scan_date date,scan_config jsonb,primary key(patient_id,relative_path));
    insert into public.patient_media_details(patient_id,relative_path,note) values('00000000-0000-4000-8000-000000000001','Patient/film.png','clinical fixture');
    create table public.hr_staff_settings(user_id uuid,weekly_schedule jsonb);
    create table public.user_profiles(user_id uuid,active boolean,is_doctor boolean);
    insert into public.hr_staff_settings values('00000000-0000-4000-8000-000000000001','{}');
    insert into public.user_profiles values('00000000-0000-4000-8000-000000000001',true,true);
    create table storage.objects(id uuid,metadata jsonb,bucket_id text);
    grant usage on schema public,auth to anon,authenticated,service_role;
  `);
  // This historical source must parse before the later hardening migration.
  await db.exec(fs.readFileSync('supabase/migrations/20260916020000_get_whatsapp_storage_usage.sql','utf8'));
  const migration=fs.readdirSync('supabase/migrations').find(name=>name.endsWith('_audit_security_hardening.sql'));
  await db.exec(fs.readFileSync(path.join('supabase/migrations',migration),'utf8'));
  await db.exec('set role anon');
  await assert.rejects(db.query('select * from public.get_doctor_working_schedules()'),/permission denied/);
  await assert.rejects(db.query('select public.get_whatsapp_storage_usage()'),/permission denied/);
  for(const key of ['', 'LuminClinicKey_2026','b'.repeat(64)]) {
    assert.deepEqual((await db.query('select public.get_all_patients_media_details($1) as data',[key])).rows[0].data,[]);
    assert.equal((await db.query("select public.upsert_patient_media_details_from_storage('00000000-0000-4000-8000-000000000001','Patient/new.png','','',null,null,null,null,$1) as accepted",[key])).rows[0].accepted,false);
  }
  assert.equal((await db.query('select public.get_all_patients_media_details($1) as data',['a'.repeat(64)])).rows[0].data.length,1);
  await db.exec("reset role; update public.clinic_settings set storage_secret_key=repeat('c',64); set role anon");
  assert.deepEqual((await db.query('select public.get_all_patients_media_details($1) as data',['a'.repeat(64)])).rows[0].data,[]);
  await db.exec("reset role; set role authenticated; select set_config('test.user_id','00000000-0000-4000-8000-000000000002',false); select set_config('test.active','true',false); select set_config('test.pages','appointments,whatsapp',false)");
  assert.equal((await db.query('select * from public.get_doctor_working_schedules()')).rows.length,1);
  assert.equal((await db.query('select public.get_whatsapp_storage_usage() as data')).rows[0].data.total_files,0);
  await db.exec("select set_config('test.pages','',false)");
  await assert.rejects(db.query('select * from public.get_doctor_working_schedules()'),/Appointment access required/);
  await db.exec("select set_config('test.admin','true',false)");
  assert.equal((await db.query('select * from public.get_doctor_working_schedules()')).rows.length,1);
  assert.equal((await db.query('select public.get_whatsapp_storage_usage() as data')).rows[0].data.total_files,0);
  await db.exec("select set_config('test.admin','false',false); select set_config('test.pages','appointments',false); select set_config('test.active','false',false)");
  await assert.rejects(db.query('select * from public.get_doctor_working_schedules()'),/Appointment access required/);
});
