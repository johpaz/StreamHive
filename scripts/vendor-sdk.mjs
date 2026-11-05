// The npm-distributed UMD bundle is self contained. Serve it locally, never from a runtime CDN.
import { createHash } from "node:crypto";
import { mkdir, writeFile, mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const version = "2.23.0";
const metadata = await fetch(
  `https://registry.npmjs.org/livekit-client/${version}`,
).then((r) => {
  if (!r.ok) throw Error("SDK registry unavailable");
  return r.json();
});
const response = await fetch(metadata.dist.tarball);
if (!response.ok) throw Error("SDK download failed");
const bytes = Buffer.from(await response.arrayBuffer());
const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
if (metadata.dist.integrity !== integrity)
  throw Error("SDK integrity mismatch");
const temp = await mkdtemp(join(tmpdir(), "streamhive-sdk-"));
try {
  await writeFile(join(temp, "sdk.tgz"), bytes);
  execFileSync("tar", [
    "-xzf",
    join(temp, "sdk.tgz"),
    "-C",
    temp,
    "package/dist/livekit-client.umd.js",
  ]);
  const output = new URL("../frontend/public/", import.meta.url);
  await mkdir(output, { recursive: true });
  await copyFile(
    join(temp, "package/dist/livekit-client.umd.js"),
    new URL("livekit-client.umd.js", output),
  );
  console.log(`Vendored LiveKit ${version} (${integrity})`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
