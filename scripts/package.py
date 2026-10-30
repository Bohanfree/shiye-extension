#!/usr/bin/env python3
"""Package only the explicit extension files, never browser data or server config."""
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
root = Path(__file__).resolve().parent.parent
source = root / 'extension'
version = json.loads((source / 'manifest.json').read_text())['version']
files = ['background.js', 'manifest.json', 'model.js',
         'options.css', 'options.html', 'options.js', 'policy.js'] + [f'icons/icon-{size}.png' for size in (16, 32, 48, 128)]
destination = root / 'dist'
destination.mkdir(exist_ok=True)
archive = destination / f'shiye-extension-v{version}.zip'
with ZipFile(archive, 'w', compression=ZIP_DEFLATED) as bundle:
    for filename in files:
        bundle.write(source / filename, filename)
checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
(destination / 'SHA256SUMS.txt').write_text(f'{checksum}  {archive.name}\n')
print(archive)
