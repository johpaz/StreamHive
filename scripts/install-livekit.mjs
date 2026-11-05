import { createHash } from "node:crypto";
import { mkdir, writeFile, mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const version = "1.13.11";
const expected =
  "1e9ee90ca301e1842b2887fc77cb122759756a9c8aeb4334ee91de3325ec43fb";
if (process.platform !== "linux" || process.arch !== "x64")
  throw Error(
    "La instalación local automática requiere Linux x86-64. Configura LIVEKIT_INTERNAL_URL para usar otro servidor.",
  );
const response = await fetch(
  `https://github.com/livekit/livekit/releases/download/v${version}/livekit_${version}_linux_amd64.tar.gz`,
  { signal: AbortSignal.timeout(60000) },
);
if (!response.ok)
  throw Error(`LiveKit download returned HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash("sha256").update(bytes).digest("hex") !== expected)
  throw Error("LiveKit release checksum mismatch");
const root = fileURLToPath(new URL("../runtime/bin/", import.meta.url));
await mkdir(root, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), "streamhive-livekit-"));
try {
  const archive = join(temp, "livekit.tgz");
  await writeFile(archive, bytes);
  execFileSync("tar", ["-xzf", archive, "-C", root, "livekit-server"]);
  await chmod(join(root, "livekit-server"), 0o755);
  console.log(`Installed official LiveKit ${version}; SHA-256 verified.`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
