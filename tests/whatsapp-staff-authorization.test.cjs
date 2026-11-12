const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const webhookContent = fs.readFileSync(path.join(root, 'supabase', 'functions', 'whatsapp-webhook', 'index.ts'), 'utf8');

test('authorizeWhatsAppStaff queries whatsapp_notifications and role permissions', () => {
  assert.match(webhookContent, /access_roles\(is_admin,\s*whatsapp_notifications,\s*role_permissions\(page_key,\s*can_view\)\)/);
});

test('authorizeWhatsAppStaff grants access to admin, whatsapp_notifications, or appointments permission', () => {
  assert.match(webhookContent, /role\?\.is_admin === true/);
  assert.match(webhookContent, /role\?\.whatsapp_notifications === true/);
  assert.match(webhookContent, /p\.page_key === "whatsapp_notifications"/);
  assert.match(webhookContent, /p\.page_key === "appointments"/);
});

test('parseMetaErrorMessage handles 24-hour customer window error code 131047', () => {
  assert.match(webhookContent, /code === 131047 \|\| code === 131026/);
  assert.match(webhookContent, /Outside 24-hour customer window/);
});
