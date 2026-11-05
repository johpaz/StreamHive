// Prepara los sidecars de Electron en desktop/electron/resources/bin/<nombre>[.exe] (ffmpeg LGPL por defecto):
//   streamhive-backend  -> compilado desde este repo (cargo build --release)
//   livekit-server      -> release oficial de GitHub, SHA-256 contra checksums.txt de la release
//   ffmpeg              -> FFMPEG_SOURCE, o build GPL de BtbN verificado (Linux/Windows x64), o el del PATH
// Uso: bun scripts/desktop-sidecars.mjs [--triple <triple>]
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, copyFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = join(root, "desktop/electron/resources/bin");
const LIVEKIT = "1.13.11";
const arg = process.argv.indexOf("--triple");
const triple =
  arg > 0
    ? process.argv[arg + 1]
    : execFileSync("rustc", ["-vV"]).toString().match(/host: (\S+)/)[1];
const win = triple.includes("windows");
const ext = win ? ".exe" : "";
const dest = (name) => join(out, `${name}${ext}`);
mkdirSync(out, { recursive: true });

// triple de Rust -> nombre de asset de LiveKit
const assetOf = {
  "x86_64-unknown-linux-gnu": "linux_amd64.tar.gz",
  "aarch64-unknown-linux-gnu": "linux_arm64.tar.gz",
  "x86_64-apple-darwin": "darwin_amd64.tar.gz",
  "aarch64-apple-darwin": "darwin_arm64.tar.gz",
  "x86_64-pc-windows-msvc": "windows_amd64.zip",
}[triple];
if (!assetOf) throw Error(`Plataforma sin build de LiveKit: ${triple}`);

// 1) backend
execFileSync("cargo", ["build", "--release", "--locked", "-p", "streamhive", "--target", triple], { cwd: root, stdio: "inherit" });
copyFileSync(join(root, "target", triple, "release", `streamhive${ext}`), dest("streamhive-backend"));

// 2) livekit-server
const base = `https://github.com/livekit/livekit/releases/download/v${LIVEKIT}`;
const name = `livekit_${LIVEKIT}_${assetOf}`;
const get = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
};
const sums = (await get(`${base}/checksums.txt`)).toString();
const expected = sums.split("\n").map((l) => l.trim().split(/\s+/)).find((p) => p[1] === name)?.[0];
if (!expected) throw Error(`checksums.txt no lista ${name}`);
const archive = await get(`${base}/${name}`);
if (createHash("sha256").update(archive).digest("hex") !== expected) throw Error("Checksum de LiveKit no coincide");
const tmp = mkdtempSync(join(tmpdir(), "sh-lk-"));
try {
  const file = join(tmp, name);
  writeFileSync(file, archive);
  execFileSync("tar", ["-xf", file, "-C", tmp]); // bsdtar (Windows/macOS) y GNU tar extraen tar.gz y zip
  copyFileSync(join(tmp, `livekit-server${ext}`), dest("livekit-server"));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// 3) ffmpeg. Por defecto un build LGPL de BtbN (sin x264; codifica por GPU con VA-API/NVENC/QSV/AMF y tiene OpenH264 de
//    respaldo por CPU), verificado por SHA-256, en Linux/Windows x64. `FFMPEG_FLAVOR=gpl` elige el build con libx264, que
//    OBLIGA a cumplir la GPL al redistribuir. `FFMPEG_SOURCE` manda sobre todo (ruta a un binario propio).
//    En otras plataformas (macOS...) no hay build verificado: se usa el del PATH con aviso, y se comprueba su licencia.
const flavorName = (process.env.FFMPEG_FLAVOR || "lgpl").toLowerCase();
if (!["lgpl", "gpl"].includes(flavorName)) throw Error("FFMPEG_FLAVOR debe ser lgpl o gpl");
const btbn = { "x86_64-unknown-linux-gnu": [`linux64-${flavorName}`, "tar.xz", "ffmpeg"], "x86_64-pc-windows-msvc": [`win64-${flavorName}`, "zip", "ffmpeg.exe"] }[triple];
if (process.env.FFMPEG_SOURCE) copyFileSync(process.env.FFMPEG_SOURCE, dest("ffmpeg"));
else if (btbn) {
  const [flavor, kind, exeName] = btbn;
  const file = `ffmpeg-master-latest-${flavor}.${kind}`;
  const rel = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest";
  const want = (await get(`${rel}/checksums.sha256`)).toString().split("\n").map((l) => l.trim().split(/\s+/)).find((p) => p[1] === file)?.[0];
  if (!want) throw Error(`checksums.sha256 no lista ${file}`);
  const data = await get(`${rel}/${file}`);
  if (createHash("sha256").update(data).digest("hex") !== want) throw Error("Checksum de ffmpeg no coincide");
  const t = mkdtempSync(join(tmpdir(), "sh-ff-"));
  try {
    writeFileSync(join(t, file), data);
    execFileSync("tar", ["-xf", join(t, file), "-C", t, "--strip-components=2", "--wildcards", `*/bin/${exeName}`]);
    copyFileSync(join(t, exeName), dest("ffmpeg"));
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
} else {
  const found = execFileSync(win ? "where" : "which", ["ffmpeg"]).toString().split(/\r?\n/)[0];
  console.warn("AVISO: usando el ffmpeg del PATH (dinámico, no portable):", found);
  copyFileSync(found, dest("ffmpeg"));
}
// Comprobación de licencia del binario que se va a distribuir (solo se puede ejecutar si es de esta plataforma).
if (!triple.includes("windows") || process.platform === "win32") {
  try {
    const cfg = execFileSync(dest("ffmpeg"), ["-hide_banner", "-version"]).toString();
    const gpl = /--enable-gpl|--enable-nonfree/.test(cfg), x264 = /--enable-libx264/.test(cfg);
    console.log(`ffmpeg incluido: ${gpl ? "GPL/no libre" : "LGPL"}${x264 ? " (con libx264)" : ""}`);
    if (flavorName === "lgpl" && !process.env.FFMPEG_SOURCE && (gpl || x264)) throw Error("El ffmpeg descargado no es LGPL: " + cfg.split("\n").find((l) => l.includes("configuration")));
  } catch (e) {
    if (String(e.message).startsWith("El ffmpeg descargado")) throw e;
    console.warn("No se pudo comprobar la licencia del ffmpeg:", e.message.split("\n")[0]);
  }
}

// Se vacía antes de copiar: Vite genera nombres con hash y los bundles viejos se acumularían en el instalador.
rmSync(join(out, "../web"), { recursive: true, force: true });
cpSync(join(root, "frontend/dist"), join(out, "../web"), { recursive: true, force: true });
if (!win) for (const n of ["streamhive-backend", "livekit-server", "ffmpeg"]) chmodSync(dest(n), 0o755);
console.log(`Sidecars listos para ${triple} en ${out}`);
