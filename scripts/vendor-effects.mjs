// Pinned, self-hosted camera-effects runtime. No CDN requests from participants.
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  mkdtemp,
  copyFile,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
const output = new URL("../frontend/public/effects/", import.meta.url);
const packages = [
  {
    name: "track-processors",
    version: "0.8.2",
    url: "https://registry.npmjs.org/@livekit/track-processors/-/track-processors-0.8.2.tgz",
    cache: "streamhive-processors.tgz",
    integrity:
      "sha512-e7mBsNMR7Ond4IyJ4afZ2azAdbd9SwQTUQgJvJBySp9M9UlObXjp/H9oKyV5UttBUjTS1h0O7SksN4PJIjYScg==",
    files: {
      "package/dist/index.mjs": "processors.mjs",
      "package/LICENSE": "LICENSE",
    },
  },
  {
    name: "tasks-vision",
    version: "0.10.14",
    url: "https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-0.10.14.tgz",
    cache: "streamhive-vision.tgz",
    integrity:
      "sha512-vOifgZhkndgybdvoRITzRkIueWWSiCKuEUXXK6Q4FaJsFvRJuwgg++vqFUMlL0Uox62U5aEXFhHxlhV7Ja5e3Q==",
    files: {
      "package/vision_bundle.mjs": "vision/vision_bundle.mjs",
      "package/wasm/vision_wasm_internal.js":
        "vision/wasm/vision_wasm_internal.js",
      "package/wasm/vision_wasm_internal.wasm":
        "vision/wasm/vision_wasm_internal.wasm",
      "package/wasm/vision_wasm_nosimd_internal.js":
        "vision/wasm/vision_wasm_nosimd_internal.js",
      "package/wasm/vision_wasm_nosimd_internal.wasm":
        "vision/wasm/vision_wasm_nosimd_internal.wasm",
    },
  },
];
const model = {
  url: "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite",
  cache: "streamhive-segmenter.tflite",
  sha256: "191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b",
};
async function download(url, cache) {
  if (process.env.STREAMHIVE_EFFECTS_CACHE_DIR) {
    try {
      return await readFile(
        join(process.env.STREAMHIVE_EFFECTS_CACHE_DIR, cache),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok)
    throw Error(`Effects download returned HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
await mkdir(output, { recursive: true });
for (const pkg of packages) {
  const bytes = await download(pkg.url, pkg.cache);
  if (
    `sha512-${createHash("sha512").update(bytes).digest("base64")}` !==
    pkg.integrity
  )
    throw Error(`Integrity mismatch: ${pkg.name}`);
  const temp = await mkdtemp(join(tmpdir(), "streamhive-effects-"));
  try {
    await writeFile(join(temp, "package.tgz"), bytes);
    execFileSync("tar", [
      "-xzf",
      join(temp, "package.tgz"),
      "-C",
      temp,
      ...Object.keys(pkg.files),
    ]);
    for (const [source, dest] of Object.entries(pkg.files)) {
      const target = new URL(dest, output);
      await mkdir(new URL(".", target), { recursive: true });
      await copyFile(join(temp, source), target);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
const modelBytes = await download(model.url, model.cache);
if (createHash("sha256").update(modelBytes).digest("hex") !== model.sha256)
  throw Error("Segmentation model checksum mismatch");
await writeFile(new URL("selfie_segmenter.tflite", output), modelBytes);
await writeFile(
  new URL("livekit-bridge.mjs", output),
  `// Use the same SDK instance as the room.\nexport const getLogger=(...args)=>window.LivekitClient.getLogger(...args);\n`,
);
await writeFile(
  new URL("loader.mjs", output),
  `import {BackgroundProcessor,supportsBackgroundProcessors} from './processors.mjs';\nwindow.StreamHiveEffects={BackgroundProcessor,supportsBackgroundProcessors};\n`,
);
await writeFile(
  new URL("NOTICE.txt", output),
  "LiveKit track-processors 0.8.2: https://github.com/livekit/track-processors-js\nMediaPipe tasks-vision 0.10.14 and selfie segmenter float16 v1: https://github.com/google-ai-edge/mediapipe\nComponents licensed under Apache-2.0; see LICENSE.\n",
);
await writeFile(
  new URL("manifest.json", output),
  JSON.stringify(
    {
      packages: packages.map(({ name, version, integrity }) => ({
        name,
        version,
        integrity,
      })),
      model,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "Camera effects installed: pinned LiveKit processor, MediaPipe WASM and segmentation model verified.",
);
