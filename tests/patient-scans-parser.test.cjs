const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const root = path.resolve(__dirname, '..');

test('archive parser bounds expansion, checks CRC, rejects traversal, and bounds image dimensions before decoding', async () => {
  global.self = {};
  const parser = await import(pathToFileURL(path.join(root, 'lumin-scan-worker.js')));
  const { zipSync, strToU8 } = await import(pathToFileURL(path.join(root, 'vendor/fflate/esm/browser.js')));
  const valid = zipSync({ 'upper.obj': strToU8('v 0 0 0'), 'lower.obj': strToU8('v 0 0 1') }, { level: 0 });
  assert.equal(Object.keys(parser.inspectZip(valid.buffer)).length, 2);
  for (const path of ['../outside.obj', 'P/../outside.obj', '/outside.obj', 'C:/outside.obj', 'P\\outside.obj', '.']) assert.throws(() => parser.safeArchivePath(path), /unsafePath/);
  assert.equal(parser.assetPath('P/materials', '../textures/a.jpg'), 'P/textures/a.jpg');
  for (const path of ['https://host/a.jpg', 'data:image/png,abc', '/a.jpg', '../../outside.jpg']) assert.throws(() => parser.assetPath('P', path));
  const corrupt = valid.slice();corrupt[39] ^= 1;
  assert.throws(() => parser.inspectZip(corrupt.buffer), /damagedZip/);
  const huge = valid.slice(), view = new DataView(huge.buffer);
  for (let at=0;at<huge.length-4;at++) if(view.getUint32(at,true)===0x02014b50){view.setUint32(at+24,129*1048576,true);break;}
  assert.throws(() => parser.inspectZip(huge.buffer), /archiveLimit/);
  const png = new Uint8Array(24);png.set([137,80,78,71,13,10,26,10]);const pngView=new DataView(png.buffer);pngView.setUint32(16,100000);pngView.setUint32(20,100000);
  assert.deepEqual(parser.textureDimensions(png),[100000,100000]);
  assert.throws(() => parser.textureDimensions(new Uint8Array([1,2,3])),/damagedTexture/);
});
