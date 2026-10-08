// Export generated icons at 3x their 32px UI size; retain transparency without shipping large originals.
// Usage: NODE_PATH=<path containing sharp> node scripts/optimize-specialty-icons.cjs <source-map.json>
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

async function main() {
  const sourceMap = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const output = path.resolve(__dirname, '../assets/specialties-3d');
  fs.mkdirSync(output, { recursive: true });
  let totalBytes = 0;
  for (const [name, source] of Object.entries(sourceMap)) {
    if (!/^dental-[a-z-]+$/.test(name)) throw new Error(`Invalid icon name: ${name}`);
    const metadata = await sharp(source).metadata();
    if (!metadata.hasAlpha) throw new Error(`${name} has no transparent alpha channel`);
    const target = path.join(output, name + '.webp');
    const result = await sharp(source).resize(96, 96, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 82, alphaQuality: 90, effort: 6 }).toFile(target);
    if (result.size > 8000) throw new Error(`${name} exceeds the 8 KB icon budget`);
    totalBytes += result.size;
    console.log(`${name}: ${result.size} bytes, 96 x 96 WebP with alpha`);
  }
  console.log(`Total: ${Object.keys(sourceMap).length} icons, ${totalBytes} bytes`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
