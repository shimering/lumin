const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let PGlite;
try { ({PGlite} = require('@electric-sql/pglite')); } catch (_) {
  try { ({PGlite} = require('../.lumin-drive-test-tools/node/node_modules/@electric-sql/pglite')); } catch (_) {}
}
test('Drive migration protects backend tables and grants mutually exclusive expiring leases', {skip: !PGlite && 'Install @electric-sql/pglite to verify database privileges'}, async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key); create table public.patients(id uuid primary key);`);
    const name = fs.readdirSync(path.join(__dirname, '../supabase/migrations')).find(n => n.endsWith('_google_drive_storage.sql'));
    await db.exec(fs.readFileSync(path.join(__dirname, '../supabase/migrations', name), 'utf8'));
    const tables = await db.query(`select relname, relrowsecurity from pg_class where relnamespace='public'::regnamespace and relname like 'google_drive_%' and relkind='r'`);
    assert.equal(tables.rows.length, 9); assert.ok(tables.rows.every(r => r.relrowsecurity));
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query('select * from public.google_drive_connection'), /permission denied/);
      await assert.rejects(db.query("select public.google_drive_claim_lock('10000000-0000-0000-0000-000000000001')"), /permission denied/);
      await assert.rejects(db.query("select public.google_drive_rename_paths('10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002','[]','[]','{}','digest')"), /permission denied/);
      await db.exec('reset role');
    }
    await db.exec('set role service_role');
    const a = '10000000-0000-0000-0000-000000000001', b = '10000000-0000-0000-0000-000000000002';
    const claim = async id => (await db.query('select public.google_drive_claim_lock($1) as claimed', [id])).rows[0].claimed;
    assert.equal(await claim(a), true); assert.equal(await claim(b), false);
    assert.equal((await db.query('select public.google_drive_renew_lock($1) as renewed', [b])).rows[0].renewed, false);
    await db.exec('reset role');
    await db.query('insert into public.patients(id) values ($1)', [a]);
    await db.exec('set role service_role');
    await db.query('insert into public.google_drive_folders(path_key, relative_path, drive_id, patient_id) values ($1,$2,$3,$4)', ['old','Old','patient-folder',a]);
    await db.query('insert into public.google_drive_folders(path_key, relative_path, drive_id) values ($1,$2,$3)', ['old/c','Old/C','category-folder']);
    const record = {path:'Old/C/x.png',deleted:false,size:4,sha256:'a'.repeat(64),clock:{[a]:1}};
    await db.query('insert into public.google_drive_files(path_key,record,drive_id) values ($1,$2,$3)', ['old/c/x.png',JSON.stringify(record),'original-file']);
    const revision=(await db.query('select revision from public.google_drive_metadata where id=1')).rows[0].revision;
    const folders=[{old_key:'old',path_key:'new',relative_path:'New',drive_id:'patient-folder'},{old_key:'old/c',path_key:'new/c',relative_path:'New/C',drive_id:'category-folder'}];
    const records=[{path_key:'old/c/x.png',record:{...record,deleted:true,sha256:null,size:0},drive_id:'original-file',mime_type:'image/png'},
      {path_key:'new/c/x.png',record:{...record,path:'New/C/x.png'},drive_id:'original-file',mime_type:'image/png'}];
    const snapshot={version:2,patients:[{id:a,name:'New'}],files:[{patient_id:a,relative_path:'New/C/x.png'}]};
    const rename=()=>db.query('select public.google_drive_rename_paths($1,$2,$3,$4,$5,$6)',[a,revision,JSON.stringify(folders),JSON.stringify(records),JSON.stringify(snapshot),'new-digest']);
    await rename();
    assert.equal((await db.query('select relative_path from public.google_drive_folders where path_key=$1',['new/c'])).rows[0].relative_path,'New/C');
    assert.equal((await db.query('select record from public.google_drive_files where path_key=$1',['old/c/x.png'])).rows[0].record.deleted,true);
    assert.equal((await db.query('select snapshot from public.google_drive_metadata where id=1')).rows[0].snapshot.files[0].relative_path,'New/C/x.png');
    await assert.rejects(rename(), /Drive changed during rename/);
    assert.equal((await db.query('select public.google_drive_renew_lock($1) as renewed', [a])).rows[0].renewed, true);
    await db.query('select public.google_drive_release_lock($1)', [b]); assert.equal(await claim(b), false);
    await db.query('select public.google_drive_release_lock($1)', [a]); assert.equal(await claim(b), true);
    await db.query("update public.google_drive_lock set expires_at = now() - interval '1 second'");
    assert.equal((await db.query('select public.google_drive_renew_lock($1) as renewed', [b])).rows[0].renewed, false);
  } finally { await db.close(); }
});
