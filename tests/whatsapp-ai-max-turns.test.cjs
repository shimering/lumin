const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const webhook = fs.readFileSync(path.join(root, 'supabase', 'functions', 'whatsapp-webhook', 'index.ts'), 'utf8');

test('index.html contains max reasoning turns setting field in modal', () => {
  assert.match(html, /id="setting-whatsapp-max-turns"/);
  assert.match(html, /<option value="5">/);
  assert.match(html, /<option value="8"/);
  assert.match(html, /<option value="10">/);
  assert.match(html, /<option value="15">/);
});

test('index.html loads and saves whatsapp_ai_max_turns in clinic settings', () => {
  assert.match(html, /whatsapp_ai_max_turns/);
  assert.match(html, /turnsSelect\.value = String\(data\.whatsapp_ai_max_turns \|\| 8\)/);
  assert.match(html, /whatsapp_ai_max_turns: Math\.min\(Math\.max\(parseInt\(document\.getElementById\('setting-whatsapp-max-turns'\)\?\.value/);
});

test('webhook reads whatsapp_ai_max_turns and configures aiMaxTurns', () => {
  assert.match(webhook, /whatsapp_ai_max_turns/);
  assert.match(webhook, /aiMaxTurns: Number\.isFinite\(Number\(data\?\.whatsapp_ai_max_turns\)\)/);
});

test('webhook runGeminiAgentWithModel uses maxTurns and includes synthesis fallback', () => {
  assert.match(webhook, /maxTurns: number = 8/);
  assert.match(webhook, /for \(let turn = 0; turn < maxTurns; turn\+\+\)/);
  assert.match(webhook, /Max turns \(\${maxTurns}\) reached on tool calls\. Generating final conversational reply\./);
  assert.match(webhook, /CRITICAL: Maximum tool calls reached\. You must now formulate a warm, polite, and complete final response/);
});

test('webhook check_available_slots exposes available_doctors_by_slot when checking all doctors', () => {
  assert.match(webhook, /available_doctors_by_slot: !selectedDoctor \? slotDoctorMap : undefined/);
  assert.match(webhook, /CRITICAL: When proposing or booking any slot from available_slots, only offer or book it with a doctor listed in available_doctors_by_slot/);
});
