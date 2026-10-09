// Build only public frontend assets; never publish the repository or clinic server files.
const fs = require('node:fs');
const path = require('node:path');
const root = fs.realpathSync(path.resolve(__dirname,'..'));
const output = path.resolve(root,'.cloudflare-assets');
if (path.relative(root,output) !== '.cloudflare-assets' || fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) throw new Error('Invalid asset output directory');
fs.rmSync(output,{recursive:true,force:true});
fs.mkdirSync(output,{recursive:true});
for (const entry of fs.readdirSync(root,{withFileTypes:true})) {
  if (entry.isFile() && (/^(?:index|quotation)\.html$/.test(entry.name) || /^lumin-[\w-]+\.(?:js|mjs|css)$/.test(entry.name) || /^(?:favicon\.svg|og\.png|manifest\.webmanifest|sw\.js|OneSignalSDKWorker\.js|app-version\.json|_headers)$/.test(entry.name))) {
    fs.copyFileSync(path.join(root,entry.name),path.join(output,entry.name));
  }
}
for (const directory of ['assets','icons','vendor','push']) fs.cpSync(path.join(root,directory),path.join(output,directory),{recursive:true});
console.log('Prepared public frontend assets in .cloudflare-assets');
