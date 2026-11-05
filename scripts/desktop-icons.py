#!/usr/bin/env python3
"""Regenerate versioned desktop icons: python3 -m pip install Pillow; python3 scripts/desktop-icons.py."""
from pathlib import Path
import hashlib
import io
import json
import struct
from PIL import Image

root = Path(__file__).resolve().parent.parent
source = root / 'frontend/public/branding/icon-512.png'
out = root / 'desktop/electron/build'
out.mkdir(parents=True, exist_ok=True)
image = Image.open(source).convert('RGBA')
if image.size != (512, 512):
    raise ValueError('The canonical desktop logo must be 512x512')
files = []
for size in (16, 24, 32, 48, 64, 128, 256, 512):
    path = out / 'icons' / f'{size}x{size}.png'
    path.parent.mkdir(exist_ok=True)
    image.resize((size, size), Image.Resampling.LANCZOS).save(path)
    files.append(path)
# Preserve identical bytes for the runtime PNG.
(out / 'icon.png').write_bytes(source.read_bytes())
image.save(out / 'icon.ico', sizes=[(n, n) for n in (16, 24, 32, 48, 64, 128, 256)])
# Native macOS ICNS entries; no Linux-only conversion tool is needed.
entries = []
for kind, size in ((b'icp4', 16), (b'icp5', 32), (b'icp6', 64), (b'ic07', 128), (b'ic08', 256), (b'ic09', 512)):
    data = io.BytesIO()
    image.resize((size, size), Image.Resampling.LANCZOS).save(data, format='PNG')
    payload = data.getvalue()
    entries.append(kind + struct.pack('>I', len(payload) + 8) + payload)
payload = b''.join(entries)
(out / 'icon.icns').write_bytes(b'icns' + struct.pack('>I', len(payload) + 8) + payload)
files.extend(out / name for name in ('icon.png', 'icon.ico', 'icon.icns'))
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
manifest = {'source': str(source.relative_to(root)), 'sha256': digest(source),
            'files': {str(p.relative_to(root)): digest(p) for p in files}}
(out / 'icons-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print('Generated Windows ICO, macOS ICNS and Linux PNG icons from the StreamHive logo')
