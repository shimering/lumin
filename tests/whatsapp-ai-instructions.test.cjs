const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const webhook = fs.readFileSync(path.join(root, 'supabase', 'functions', 'whatsapp-webhook', 'index.ts'), 'utf8');
const migration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20260921210900_add_whatsapp_ai_instruction_blocks.sql'),
  'utf8'
);

const sourceStart = html.indexOf('function createWhatsAppAiInstructionId()');
const sourceEnd = html.indexOf('function setWhatsAppAiInstructionMessage(', sourceStart);
assert.ok(sourceStart >= 0 && sourceEnd > sourceStart, 'instruction normalization functions exist');

const sandbox = {
  Date,
  JSON,
  Math,
  String,
  window: { crypto: { randomUUID: () => 'generated-id' } }
};
vm.createContext(sandbox);
vm.runInContext(html.slice(sourceStart, sourceEnd), sandbox);

test('legacy WhatsApp AI instructions become an editable General section', () => {
  const result = vm.runInContext(
    `normaliseWhatsAppAiInstructionBlocks([], '  Keep replies concise and confirm bookings.  ')`,
    sandbox
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [{
    id: 'general',
    title: 'General',
    body: 'Keep replies concise and confirm bookings.',
    order: 0
  }]);
});

test('multiple title/body sections retain their saved order and text', () => {
  const blocks = [
    { id: 'general', title: 'General', body: 'Be welcoming.' },
    { id: 'booking', title: 'Booking rules', body: 'Check the live calendar first.' }
  ];
  sandbox.savedBlocks = JSON.stringify(blocks);
  const result = vm.runInContext('normaliseWhatsAppAiInstructionBlocks(savedBlocks)', sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [
    { ...blocks[0], order: 0 },
    { ...blocks[1], order: 1 }
  ]);
});

test('the old popup field is removed and the Admin WhatsApp editor is wired for structured saves', () => {
  assert.equal(html.includes('id="setting-whatsapp-ai-prompt"'), false);
  assert.match(html, /id="admin-whatsapp-ai-instruction-list"/);
  assert.match(html, /whatsapp_ai_instruction_blocks: cleanedBlocks/);
  assert.match(html, /whatsapp_ai_instructions: compiledLegacyInstructions/);
});

test('migration and webhook preserve legacy instructions while enabling titled sections', () => {
  assert.match(migration, /'title', 'General'/);
  assert.match(migration, /'body', btrim\(whatsapp_ai_instructions\)/);
  assert.match(webhook, /compileWhatsAppAiInstructions\(data\?\.whatsapp_ai_instruction_blocks, data\?\.whatsapp_ai_instructions\)/);
  assert.match(webhook, /`### \$\{title\}\\n\$\{body\}`/);
});
