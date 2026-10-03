const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const root = path.join(__dirname, '..');
const edgeSource = fs.readFileSync(path.join(root, 'supabase/functions/hr-attendance-push/index.ts'), 'utf8');
const edgeScript = stripTypeScriptTypes(edgeSource.replace(/^import .*;\r?\n/gm, ''));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const staffId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const hrId = '33333333-3333-4333-8333-333333333333';

function createEdgeHarness({ session = {}, profile = {}, envKey = 'os_v2_test', authenticated = true } = {}) {
  let handler;
  const pushes = [];
  const tables = {
    hr_attendance_sessions: [{
      id: sessionId, user_id: staffId,
      check_in_at: new Date().toISOString(), check_in_method: 'mobile_geofence',
      check_out_at: null, check_out_method: null, ...session,
    }],
    user_profiles: [
      { user_id: staffId, active: true, full_name: '  Sara Ahmed  ', login_name: 'sara', role_id: 'staff', ...profile },
      { user_id: hrId, active: true, role_id: 'hr' },
      { user_id: '44444444-4444-4444-8444-444444444444', active: true, role_id: 'staff' },
    ],
    role_permissions: [{ role_id: 'hr', page_key: 'hr', can_view: true }],
    access_roles: [],
    clinic_settings: [{ id: 1, onesignal_rest_api_key: 'os_v2_settings_test' }],
  };
  const client = {
    auth: { getUser: async () => ({ data: { user: authenticated ? { id: staffId } : null }, error: null }) },
    from(table) {
      let rows = tables[table];
      let columns;
      let single = false;
      const query = {
        select(value) { columns = value.split(','); return this; },
        eq(key, value) { rows = rows.filter(row => row[key] === value); return this; },
        neq(key, value) { rows = rows.filter(row => row[key] !== value); return this; },
        in(key, values) { rows = rows.filter(row => values.includes(row[key])); return this; },
        maybeSingle() { single = true; return this; },
        then(resolve, reject) {
          const selected = rows.map(row => Object.fromEntries(columns.map(key => [key, row[key]])));
          return Promise.resolve({ data: single ? selected[0] || null : selected, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  vm.runInNewContext(edgeScript, {
    Request, Response, URL, AbortSignal, console: { error() {} }, createClient: () => client,
    Deno: {
      env: { get: key => ({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'test-anon', SUPABASE_SERVICE_ROLE_KEY: 'test-service', ONESIGNAL_REST_API_KEY: envKey })[key] },
      serve: callback => { handler = callback; },
    },
    fetch: async (url, options) => {
      pushes.push({ url, payload: JSON.parse(options.body), authorization: options.headers.Authorization });
      return Response.json({ id: 'test-notification', recipients: 1 });
    },
  });
  return {
    pushes,
    invoke: (body = {}) => handler(new Request('https://example.supabase.co/functions/v1/hr-attendance-push', {
      method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ attendance_session_id: sessionId, app_url: 'https://clinic.example', ...body }),
    })),
  };
}

test('check-in push includes the saved staff name in English and Arabic and keeps HR recipients', async () => {
  const harness = createEdgeHarness();
  const response = await harness.invoke({ action: 'check_in', staff_name: 'Spoofed name' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).sent, true);
  const { payload } = harness.pushes[0];
  assert.equal(payload.contents.en, 'Sara Ahmed checked in. Open HR to review it.');
  assert.equal(payload.contents.ar, 'تم تسجيل حضور Sara Ahmed. افتح صفحة الموارد البشرية للمراجعة.');
  assert.deepEqual(payload.include_external_user_ids, [hrId]);
  assert.equal(payload.url, 'https://clinic.example/?view=hr');
});

test('check-out uses its own timestamp after a full shift and includes an Arabic staff name', async () => {
  const harness = createEdgeHarness({
    session: { check_in_at: new Date(Date.now() - 8 * 60 * 60_000).toISOString(), check_out_at: new Date().toISOString(), check_out_method: 'mobile_geofence' },
    profile: { full_name: 'سارة أحمد' },
  });
  const response = await harness.invoke({ action: 'check_out' });
  assert.equal(response.status, 200);
  const { payload } = harness.pushes[0];
  assert.equal(payload.headings.en, 'Staff check-out');
  assert.equal(payload.contents.en, 'سارة أحمد checked out. Open HR to review it.');
  assert.equal(payload.contents.ar, 'تم تسجيل انصراف سارة أحمد. افتح صفحة الموارد البشرية للمراجعة.');
  assert.equal(payload.data.action, 'check_out');
});

test('older clients still send named check-in pushes without an action field', async () => {
  const harness = createEdgeHarness();
  assert.equal((await harness.invoke()).status, 200);
  assert.equal(harness.pushes[0].payload.data.action, 'check_in');
});

test('blank full name falls back to the saved login name and settings provide the push key', async () => {
  const harness = createEdgeHarness({ profile: { full_name: '   ', login_name: ' sara ' }, envKey: '' });
  assert.equal((await harness.invoke({ action: 'check_in' })).status, 200);
  assert.equal(harness.pushes[0].payload.contents.en, 'sara checked in. Open HR to review it.');
  assert.equal(harness.pushes[0].authorization, 'Key os_v2_settings_test');
});

test('invalid, unrecorded, manual, stale, or unauthorized attendance cannot send a push', async () => {
  const recent = new Date().toISOString();
  const stale = new Date(Date.now() - 31 * 60_000).toISOString();
  const cases = [
    { options: {}, body: { action: 'invalid' }, status: 400 },
    { options: {}, body: { action: 'check_out' }, status: 403 },
    { options: { session: { check_out_at: recent, check_out_method: 'manual' } }, body: { action: 'check_out' }, status: 403 },
    { options: { session: { check_out_at: stale, check_out_method: 'mobile_geofence' } }, body: { action: 'check_out' }, status: 409 },
    { options: { session: { check_out_at: recent, check_out_method: 'mobile_geofence', user_id: hrId } }, body: { action: 'check_out' }, status: 403 },
    { options: { profile: { active: false } }, body: { action: 'check_in' }, status: 403 },
    { options: { authenticated: false }, body: { action: 'check_in' }, status: 401 },
  ];
  for (const { options, body, status } of cases) {
    const harness = createEdgeHarness(options);
    assert.equal((await harness.invoke(body)).status, status);
    assert.equal(harness.pushes.length, 0);
  }
});

function createClientHarness({ checkedIn = false, rpcFails = false, pushFails = false, arrayResult = false } = {}) {
  const calls = [];
  const button = {};
  const message = { classList: { remove() {}, add() {} } };
  const context = {
    currentSession: { user: { id: staffId } }, currentUserAccess: { isDoctor: false },
    myOpenAttendanceSession: checkedIn ? { id: sessionId } : null,
    window: { location: { origin: 'https://clinic.example' } },
    document: { getElementById: id => id === 'dashboard-attendance-action' ? button : message },
    console: { warn() {} },
    getDevicePosition: async () => ({ coords: { latitude: 30, longitude: 31, accuracy: 10 } }),
    refreshMyAttendanceState: async () => {},
    db: {
      rpc: async (name, args) => {
        calls.push({ type: 'rpc', args });
        return { data: arrayResult ? [{ id: sessionId }] : { id: sessionId }, error: rpcFails ? new Error('Attendance rejected') : null };
      },
      functions: { invoke: async (name, options) => {
        calls.push({ type: 'push', name, body: options.body });
        return { data: { sent: !pushFails }, error: pushFails ? new Error('Push unavailable') : null };
      } },
    },
  };
  const source = html.slice(html.indexOf('    async function queueHrAttendancePushNotification'), html.indexOf('    async function handleSavePatient'));
  vm.createContext(context);
  vm.runInContext(source, context);
  return { context, calls, button, message };
}

test('the dashboard queues both check-in and check-out only after saving attendance', async () => {
  for (const checkedIn of [false, true]) {
    const harness = createClientHarness({ checkedIn, arrayResult: checkedIn });
    await harness.context.recordMobileAttendance();
    assert.deepEqual(harness.calls.map(call => call.type), ['rpc', 'push']);
    assert.equal(harness.calls[1].body.action, checkedIn ? 'check_out' : 'check_in');
    assert.equal(harness.calls[1].body.attendance_session_id, sessionId);
    assert.equal(harness.button.disabled, false);
  }
});

test('failed attendance does not notify HR and push failure does not invalidate saved attendance', async () => {
  const rejected = createClientHarness({ rpcFails: true });
  await rejected.context.recordMobileAttendance();
  assert.deepEqual(rejected.calls.map(call => call.type), ['rpc']);
  const pushFailure = createClientHarness({ checkedIn: true, pushFails: true });
  await pushFailure.context.recordMobileAttendance();
  assert.equal(pushFailure.message.textContent, 'Checked out successfully using server time.');
  assert.equal(pushFailure.button.disabled, false);
});
