const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {stripTypeScriptTypes} = require('node:module');
const {webcrypto} = require('node:crypto');

function edge(file, env = {}, client = {}) {
  let handler;
  const requests = [];
  const context = vm.createContext({Request, Response, URL, TextEncoder, TextDecoder,
    crypto: webcrypto, btoa, atob, console,
    Deno: {env: {get: name => env[name]}, serve: value => {handler = value}},
    createClient: () => client,
    fetch: async (...args) => {requests.push(args); throw Error('Unexpected provider request')},
  });
  const code = fs.readFileSync(file, 'utf8').replace(/^import .*;\r?\n/gm, '');
  new vm.Script(stripTypeScriptTypes(code)).runInContext(context);
  return {context, requests, handle: request => handler(request)};
}

test('Calendar has no embedded provider credentials and requires every configured secret', () => {
  const env = {}, fixture = edge('supabase/functions/google-calendar/index.ts', env);
  const empty = fixture.context.configuration();
  assert.equal(empty.clientId, ''); assert.equal(empty.clientSecret, ''); assert.equal(empty.encryptionKey, '');
  assert.equal(fixture.context.providerConfigured(), false);
  env.GOOGLE_CALENDAR_CLIENT_ID = 'fixture-client-id';
  env.GOOGLE_CALENDAR_CLIENT_SECRET = 'fixture-client-secret';
  assert.equal(fixture.context.providerConfigured(), false);
  env.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY = 'fixture-private-encryption-key';
  assert.equal(fixture.context.providerConfigured(), true);
});

test('Calendar token encryption round-trips with the configured key and rejects a different key', async () => {
  const fixture = edge('supabase/functions/google-calendar/index.ts');
  const encrypted = await fixture.context.encryptToken('fixture-refresh-token', 'fixture-private-key');
  assert.equal(await fixture.context.decryptToken(encrypted, 'fixture-private-key'), 'fixture-refresh-token');
  await assert.rejects(fixture.context.decryptToken(encrypted, 'different-private-key'));
});

test('Appointment push without an environment API key returns configuration failure without contacting OneSignal', async () => {
  const userId = '00000000-0000-4000-8000-000000000001';
  const client = {
    auth: {getUser: async () => ({data: {user: {id: userId}}, error: null})},
    from(table) {
      return {select() {return this}, eq() {return this},
        single: async () => ({data: {active: true, access_roles: {is_admin: true}}, error: null}),
        maybeSingle: async () => ({data: table === 'appointments'
          ? {assigned_user_id: userId, patients: {name: 'Fixture Patient'}} : {active: true}, error: null}),
      };
    },
  };
  const fixture = edge('supabase/functions/appointment-push/index.ts', {
    SUPABASE_URL: 'https://fixture.invalid', SUPABASE_ANON_KEY: 'fixture-anon', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service',
  }, client);
  const response = await fixture.handle(new Request('https://fixture.invalid', {
    method: 'POST', headers: {Authorization: 'Bearer fixture', 'Content-Type': 'application/json'},
    body: JSON.stringify({appointment_id: userId, change_type: 'created', idempotency_key: userId}),
  }));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /ONESIGNAL_REST_API_KEY is not configured/);
  assert.equal(fixture.requests.length, 0);
});
