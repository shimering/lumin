const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');

test('inbound receipt trigger deduplicates atomically, preserves history and rolls back failed saves', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema private;
    create table public.whatsapp_messages (
      id text primary key,
      sender text not null,
      whatsapp_message_id text,
      content text not null,
      created_at timestamptz not null default now()
    );
    insert into public.whatsapp_messages(id,sender,whatsapp_message_id,content) values
      ('old-a','patient','old-provider-id','First historical copy'),
      ('old-b','patient','old-provider-id','Second historical copy');
    grant usage on schema public to anon, authenticated, service_role;
    grant select, insert, delete on public.whatsapp_messages to service_role;
  `);
  const migration = fs.readdirSync('supabase/migrations').find(name => name.endsWith('_whatsapp_inbound_replay_protection.sql'));
  await db.exec(fs.readFileSync('supabase/migrations/' + migration, 'utf8'));
  assert.equal((await db.query('select count(*)::int as n from public.whatsapp_messages')).rows[0].n, 2);
  assert.equal((await db.query('select count(*)::int as n from private.whatsapp_inbound_receipts')).rows[0].n, 1);
  await db.exec('set role anon');
  await assert.rejects(db.query('select * from private.whatsapp_inbound_receipts'), /permission denied/);
  await db.exec('reset role; set role authenticated');
  await assert.rejects(db.query("insert into private.whatsapp_inbound_receipts(whatsapp_message_id) values ('forged')"), /permission denied/);
  await db.exec('reset role; set role service_role');
  const insert = (id, providerId, content = 'Fixture') => db.query(
    "insert into public.whatsapp_messages(id,sender,whatsapp_message_id,content,provider_sent_at,ai_eligible) values ($1,'patient',$2,$3,'2026-11-04T12:00:00Z',true) returning id", [id, providerId, content]);
  assert.equal((await insert('replay', 'old-provider-id')).rows.length, 0);
  const concurrent = await Promise.all([insert('new-a', 'new-provider-id'), insert('new-b', 'new-provider-id')]);
  assert.equal(concurrent.reduce((n, result) => n + result.rows.length, 0), 1);
  const receipt = (await db.query("select provider_sent_at from private.whatsapp_inbound_receipts where whatsapp_message_id='new-provider-id'")).rows[0];
  assert.equal(new Date(receipt.provider_sent_at).toISOString(), '2026-11-04T12:00:00.000Z');
  await assert.rejects(insert('bad', 'retry-provider-id', null), /null value/);
  assert.equal((await db.query("select count(*)::int as n from private.whatsapp_inbound_receipts where whatsapp_message_id='retry-provider-id'")).rows[0].n, 0);
  assert.equal((await insert('retry', 'retry-provider-id')).rows.length, 1);
  await db.query("delete from public.whatsapp_messages where whatsapp_message_id='new-provider-id'");
  assert.equal((await insert('after-delete', 'new-provider-id')).rows.length, 0);
  await db.query("insert into public.whatsapp_messages(id,sender,whatsapp_message_id,content) values ('outbound','ai','old-provider-id','Outbound remains allowed')");
});
