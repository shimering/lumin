import { unzipSync, strFromU8 } from './vendor/fflate/esm/browser.js';
import { OBJLoader } from './vendor/three/examples/jsm/loaders/OBJLoader.js';

const MAX_EXPANDED = 256 * 1024 * 1024;
const MAX_ENTRY = 128 * 1024 * 1024;
const MAX_TRIANGLES = 750000;
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc;
});
let archive;
export function safeArchivePath(path) {
  if (!path || /[\x00-\x1f\\:]/.test(path) || path.startsWith('/')) throw new Error('unsafePath');
  if (path.split('/').some(part => part === '..')) throw new Error('unsafePath');
  const normalized = path.split('/').filter(part => part && part !== '.').join('/');
  if (!normalized) throw new Error('unsafePath');
  return normalized;
}
export function assetPath(base, path) {
  if (/^(?:[a-z]+:|\/|\\)/i.test(path) || /[\x00-\x1f\\]/.test(path)) throw new Error('externalAsset');
  const parts = base.split('/').filter(Boolean);
  for (const part of path.split('/')) {
    if (part === '..') { if (!parts.length) throw new Error('unsafePath'); parts.pop(); }
    else if (part && part !== '.') parts.push(part);
  }
  return safeArchivePath(parts.join('/'));
}
// Check central-directory lengths before fflate allocates output arrays, including ignored STL entries.
export function inspectZip(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
  }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error('damagedZip');
  const count = view.getUint16(end + 10, true), length = view.getUint32(end + 12, true);
  let at = view.getUint32(end + 16, true), total = 0;
  if (!count || count > 128 || at + length !== end) throw new Error('archiveLimit');
  const names = new Set(), checksums = new Map();
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) throw new Error('damagedZip');
    const flags = view.getUint16(at + 8, true), method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 24, true), n = view.getUint16(at + 28, true);
    const next = at + 46 + n + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    if (next > end || flags & 1 || ![0, 8].includes(method)) throw new Error('damagedZip');
    const path = safeArchivePath(strFromU8(bytes.subarray(at + 46, at + 46 + n)));
    if (names.has(path)) throw new Error('damagedZip');
    names.add(path); total += size;
    checksums.set(path, { size, crc: view.getUint32(at + 16, true) });
    if (size > MAX_ENTRY || total > MAX_EXPANDED) throw new Error('archiveLimit');
    at = next;
  }
  if (at !== end) throw new Error('damagedZip');
  const files = unzipSync(bytes, { filter: file => /\.(obj|mtl|png|jpe?g|webp)$/i.test(file.name) });
  const normalized = Object.create(null);
  for (const [name, data] of Object.entries(files)) {
    const path = safeArchivePath(name), expected = checksums.get(path);
    let crc = 0xffffffff;
    for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
    if (!expected || expected.size !== data.length || expected.crc !== ((crc ^ 0xffffffff) >>> 0)) throw new Error('damagedZip');
    normalized[path] = data;
  }
  return normalized;
}
export function textureDimensions(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && bytes[0] === 137 && strFromU8(bytes.subarray(1, 4)) === 'PNG') return [view.getUint32(16), view.getUint32(20)];
  if (bytes[0] === 255 && bytes[1] === 216) {
    for (let at = 2; at + 9 < bytes.length;) {
      if (bytes[at] !== 255) throw new Error('damagedTexture');
      const marker = bytes[at + 1];
      if (marker === 255) { at++; continue; }
      const length = view.getUint16(at + 2);
      if (length < 2 || at + 2 + length > bytes.length) throw new Error('damagedTexture');
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) return [view.getUint16(at + 7), view.getUint16(at + 5)];
      at += length + 2;
    }
  }
  if (bytes.length >= 30 && strFromU8(bytes.subarray(0, 4)) === 'RIFF' && strFromU8(bytes.subarray(8, 12)) === 'WEBP') {
    const kind = strFromU8(bytes.subarray(12, 16));
    const u24 = at => bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16;
    if (kind === 'VP8X') return [u24(24) + 1, u24(27) + 1];
    if (kind === 'VP8 ' && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) return [view.getUint16(26, true) & 16383, view.getUint16(28, true) & 16383];
    if (kind === 'VP8L' && bytes[20] === 47) { const bits = view.getUint32(21, true); return [(bits & 16383) + 1, ((bits >>> 14) & 16383) + 1]; }
  }
  throw new Error('damagedTexture');
}
function smoothNormals(geometry) {
  // Accumulate across UV seams, while retaining the original positions and texture coordinates.
  const pos = geometry.attributes.position, sums = new Map();
  const key = i => `${pos.getX(i)},${pos.getY(i)},${pos.getZ(i)}`;
  geometry.computeVertexNormals();
  const normal = geometry.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    const k = key(i), sum = sums.get(k) || [0, 0, 0];
    sum[0] += normal.getX(i); sum[1] += normal.getY(i); sum[2] += normal.getZ(i); sums.set(k, sum);
  }
  for (let i = 0; i < pos.count; i++) {
    const sum = sums.get(key(i)), length = Math.hypot(...sum) || 1;
    normal.setXYZ(i, sum[0] / length, sum[1] / length, sum[2] / length);
  }
}
function model(path, warnings) {
  if (!archive[path] || !/\.obj$/i.test(path)) throw new Error('selectArches');
  const text = strFromU8(archive[path]);
  let faces = 0, vertices = 0, triangleCount = 0;
  for (const line of text.split('\n')) {
    if (/^v\s/.test(line)) vertices++;
    if (/^f\s/.test(line)) {
      faces++; triangleCount += line.trim().split(/\s+/).length - 3;
      if (triangleCount > MAX_TRIANGLES) throw new Error('modelLimit');
    }
  }
  if (!faces || vertices > 1000000) throw new Error('modelLimit');
  const base = path.split('/').slice(0, -1).join('/');
  const mtls = [], textures = Object.create(null);
  for (const match of text.matchAll(/^mtllib\s+(.+)$/gm)) {
    const mtlPath = assetPath(base, match[1].trim());
    if (!archive[mtlPath]) { warnings.add('missingMaterial'); continue; }
    const mtlBase = mtlPath.split('/').slice(0, -1).join('/');
    const lines = strFromU8(archive[mtlPath]).split('\n').map(line => {
      if (!/^\s*(?:map_\w+|bump|refl|norm)\s/i.test(line)) return line;
      const trimmed = line.trim(), command = trimmed.split(/\s/)[0];
      // MTLLoader understands texture options; preserve them and rewrite only the filename.
      let value = trimmed.slice(command.length).trim();
      value = value.replace(/-(?:s|o)\s+\S+\s+\S+\s+\S+\s+/g, '').replace(/-bm\s+\S+\s+/g, '');
      const target = assetPath(mtlBase, value);
      if (!/\.(png|jpe?g|webp)$/i.test(target) || !archive[target]) { warnings.add('missingTexture'); return ''; }
      const [width, height] = textureDimensions(archive[target]);
      if (!width || !height || width > 8192 || height > 8192 || width * height > 16777216) throw new Error('textureLimit');
      textures[target] = archive[target];
      return `${command} ${target}`;
    });
    mtls.push(lines.join('\n'));
  }
  const object = new OBJLoader().parse(text), meshes = [];
  object.traverse(child => {
    if (!child.isMesh) return;
    const geometry = child.geometry;
    if (!/^vn\s/m.test(text)) smoothNormals(geometry);
    const attributes = {};
    for (const name of ['position', 'normal', 'uv']) {
      const a = geometry.attributes[name];
      if (a) {
        if (a.array.some(value => !Number.isFinite(value))) throw new Error('damagedObj');
        attributes[name] = { array: a.array, itemSize: a.itemSize };
      }
    }
    meshes.push({ attributes, groups: geometry.groups,
      materials: (Array.isArray(child.material) ? child.material : [child.material]).map(m => m.name) });
  });
  return { path, meshes, mtls, textures, triangleCount };
}
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'inspect') {
      archive = inspectZip(data.buffer);
      const paths = Object.keys(archive).filter(path => /\.obj$/i.test(path));
      if (paths.length < 2) throw new Error('selectArches');
      self.postMessage({ id: data.id, paths });
    } else if (data.type === 'parse') {
      if (data.upper === data.lower) throw new Error('selectArches');
      const warnings = new Set(), upper = model(data.upper, warnings), lower = model(data.lower, warnings);
      let pixels = 0;
      for (const arch of [upper, lower]) for (const bytes of Object.values(arch.textures)) { const [w, h] = textureDimensions(bytes); pixels += w * h; }
      if (pixels > 33554432) throw new Error('textureLimit');
      const transfer = [];
      for (const arch of [upper, lower]) for (const mesh of arch.meshes)
        for (const attr of Object.values(mesh.attributes)) transfer.push(attr.array.buffer);
      self.postMessage({ id: data.id, upper, lower, warnings: [...warnings] }, transfer);
    }
  } catch (error) {
    const known = ['unsafePath', 'externalAsset', 'damagedZip', 'damagedObj', 'damagedTexture', 'archiveLimit', 'modelLimit', 'textureLimit', 'selectArches'];
    self.postMessage({ id: data.id, error: known.includes(error.message) ? error.message : data.type === 'parse' ? 'damagedObj' : 'damagedZip' });
  }
};
