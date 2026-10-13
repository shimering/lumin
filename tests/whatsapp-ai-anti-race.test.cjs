const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const webhookContent = fs.readFileSync(path.join(root, 'supabase', 'functions', 'whatsapp-webhook', 'index.ts'), 'utf8');

test('incoming webhook captures inserted message id for race protection', () => {
  assert.match(webhookContent, /const\s*\{\s*data:\s*insertedMsg,\s*error:\s*msgInsertErr\s*\}\s*=\s*await supabase/);
  assert.match(webhookContent, /\.select\("id,\s*created_at"\)/);
});

test('aiTask performs anti-race debounce and skips superseded tasks', () => {
  assert.match(webhookContent, /Anti-race debounce/);
  assert.match(webhookContent, /latestCheck\.id\s*!==\s*insertedMsg\.id/);
  assert.match(webhookContent, /Superseded by newer incoming message; skipping earlier AI task/);
});

test('aiTask verifies conversation is still active before and after Gemini generation', () => {
  assert.match(webhookContent, /AI was muted or taken over by staff; skipping AI task/);
  assert.match(webhookContent, /latestCheckAfterGen\.id\s*!==\s*insertedMsg\.id/);
  assert.match(webhookContent, /Conversation taken over by staff during generation; skipping dispatch/);
});
