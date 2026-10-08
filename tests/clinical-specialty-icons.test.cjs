const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname, '..');
const folder = path.join(root, 'assets/specialties-3d');
const generation = JSON.parse(fs.readFileSync(path.join(folder, 'generation.json'), 'utf8'));

test('all fresh specialty icons retain alpha at 3x UI resolution within a small download budget', () => {
  let total = 0;
  assert.equal(generation.icons.length, 15);
  for (const icon of generation.icons) {
    const file = fs.readFileSync(path.join(folder, icon.file));
    assert.equal(file.toString('ascii', 0, 4), 'RIFF', icon.file);
    assert.equal(file.toString('ascii', 8, 12), 'WEBP', icon.file);
    assert.equal(file.toString('ascii', 12, 16), 'VP8X', icon.file);
    assert.ok(file[20] & 0x10, `${icon.file} keeps its alpha channel`);
    assert.equal(file.readUIntLE(24, 3) + 1, 96, icon.file);
    assert.equal(file.readUIntLE(27, 3) + 1, 96, icon.file);
    assert.ok(file.length < 8000, `${icon.file} stays below 8 KB`);
    total += file.length;
  }
  assert.ok(total < 64 * 1024, `The complete icon set is ${total} bytes`);
});

test('the specialty picker and every optimized icon are available in the offline shell', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const script = html.match(/src="(lumin-specialty-picker\.js\?v=\d+)"/)[1];
  assert.ok(sw.includes('/' + script));
  for (const icon of generation.icons) assert.ok(sw.includes('/assets/specialties-3d/' + icon.file), icon.file);
});
