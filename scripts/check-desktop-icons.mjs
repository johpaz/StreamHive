// Validate versioned distribution assets without installing an image conversion tool.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "desktop/electron/build/icons-manifest.json")));
const hash = file => createHash("sha256").update(readFileSync(resolve(root, file))).digest("hex");
if (hash(manifest.source) !== manifest.sha256) throw Error("Logo changed: run python3 scripts/desktop-icons.py");
for (const [file, expected] of Object.entries(manifest.files)) {
  if (hash(file) !== expected) throw Error(`Missing or outdated icon: ${file}. Run python3 scripts/desktop-icons.py`);
}
const ico = readFileSync(resolve(root, "desktop/electron/build/icon.ico"));
const icns = readFileSync(resolve(root, "desktop/electron/build/icon.icns"));
if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1 || ico.readUInt16LE(4) < 6) throw Error("Invalid Windows multi-resolution ICO");
if (icns.subarray(0, 4).toString() !== "icns" || icns.readUInt32BE(4) !== icns.length) throw Error("Invalid macOS ICNS");
console.log("Desktop distribution icons verified: Windows, macOS and Linux");
