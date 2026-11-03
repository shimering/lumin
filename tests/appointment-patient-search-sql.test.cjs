const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { PGlite } = require('@electric-sql/pglite');
const root = path.resolve(__dirname, '..');

test('appointment patient search upgrades from five to ten summaries with matching and RLS intact', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  const actor = '00000000-0000-4000-8000-000000000099';
  await db.exec(`
    create schema private; create schema auth;
    create role anon; create role authenticated;
    create function auth.uid() returns uuid language sql as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create table public.patients (
      id uuid primary key default gen_random_uuid(), patient_number bigint,
      name text, phone text, created_at timestamptz
    );
    create table public.access_roles (id integer primary key, is_admin boolean);
    create table public.user_profiles (user_id uuid, role_id integer, active boolean);
    insert into public.access_roles values (1, true);
    insert into public.user_profiles values ('${actor}', 1, true);
    grant usage on schema public, private, auth to anon, authenticated;
    grant select on public.patients to authenticated;
    alter table public.patients enable row level security;
    create policy fixture_patient_access on public.patients for select to authenticated
      using ((select auth.uid()) = '${actor}'::uuid);
  `);
  await db.exec(fs.readFileSync(path.join(root, 'supabase/migrations/20261004073701_appointment_patient_search.sql'), 'utf8'));
  const migration = fs.readdirSync(path.join(root, 'supabase/migrations')).find(name => name.endsWith('_appointment_patient_search_ten_results.sql'));
  assert.ok(migration, 'ten-result upgrade migration exists');
  await db.exec(fs.readFileSync(path.join(root, 'supabase/migrations', migration), 'utf8'));
  const result = await db.exec(fs.readFileSync(path.join(root, 'supabase/tests/appointment_patient_search.test.sql'), 'utf8'));
  assert.equal(result.at(-1).rows[0].result, 'Appointment patient search SQL checks passed');
  assert.equal((await db.query('select count(*)::int as count from public.patients')).rows[0].count, 0, 'fixtures roll back');
});
