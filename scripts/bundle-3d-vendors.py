"""Fetch the pinned browser-only viewer dependencies without running package scripts."""
import hashlib
import io
import json
from pathlib import Path
import tarfile
import urllib.request

base = Path(__file__).resolve().parents[1] / 'vendor'
records = []
for name, version, files in [
    ('three', '0.180.0', ['build/three.module.js', 'build/three.core.js',
     'examples/jsm/loaders/OBJLoader.js', 'examples/jsm/loaders/MTLLoader.js',
     'examples/jsm/controls/OrbitControls.js', 'LICENSE']),
    ('fflate', '0.8.2', ['esm/browser.js', 'LICENSE']),
]:
    data = urllib.request.urlopen(f'https://registry.npmjs.org/{name}/-/{name}-{version}.tgz', timeout=30).read()
    archive = tarfile.open(fileobj=io.BytesIO(data), mode='r:gz')
    for rel in files:
        dest = base / name / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        content = archive.extractfile('package/' + rel).read()
        if name == 'three' and rel.startswith('examples/'):
            content = content.replace(b"from 'three'", b"from '../../../build/three.module.js'")
        if name == 'three' and rel == 'build/three.core.js':
            content = content.replace(b'\t\t\t \tmaterial = getMaterial( data.material );', b'\t\t\t\tmaterial = getMaterial( data.material );')
        dest.write_bytes(content)
    records.append({'package': name, 'version': version,
                    'tarballSha256': hashlib.sha256(data).hexdigest(), 'files': files})
(base / '3d-packages.json').write_text(json.dumps(records, indent=2))
print('Bundled Three.js 0.180.0 and fflate 0.8.2, including licenses.')
