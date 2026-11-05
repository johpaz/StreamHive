// Exercises the actual `dev` launcher without ENGINE or an Egress service.
// Uses isolated settings and a local RTMP receiver; never reads a real stream key.
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "sh-local-stream-"));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const assert = (ok, message) => { if (!ok) throw Error(message); };
const free = () => new Promise(r => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const children = [];
const launch = (cmd, args, env) => {
  const p = spawn(cmd, args, { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; for (const out of [p.stdout, p.stderr]) out.on("data", d => { log = (log + d).slice(-5000); });
  p.log = () => log; children.push(p); return p;
};
let browser, success = false;
try {
  const [api, web, lk, tcp, udp, rtmp] = await Promise.all(Array.from({ length: 6 }, free));
  const origin = `http://localhost:${web}`, secret = randomBytes(32).toString("hex");
  const env = { ...process.env }; delete env.ENGINE;
  const config = join(work, "livekit.yaml");
  writeFileSync(config, `port: ${lk}\nbind_addresses: [127.0.0.1]\nrtc:\n  tcp_port: ${tcp}\n  udp_port: ${udp}\n  use_external_ip: false\nkeys:\n  localtest: ${secret}\n`);
  launch(join(root, "runtime/bin/livekit-server"), ["--config", config, "--node-ip", "127.0.0.1"], env);
  const received = join(work, "received.flv");
  launch(env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-listen", "1", "-i", `rtmp://127.0.0.1:${rtmp}/live/test`, "-c", "copy", "-y", received], env);
  const launcher = launch(process.execPath, ["scripts/dev.mjs"], { ...env, STREAMHIVE_REVIEW_DIR: work, STREAMHIVE_API_PORT: String(api), STREAMHIVE_PORT: String(web), LIVEKIT_INTERNAL_URL: `http://127.0.0.1:${lk}`, LIVEKIT_PUBLIC_URL: `ws://localhost:${lk}`, LIVEKIT_API_KEY: "localtest", LIVEKIT_API_SECRET: secret });
  for (let i = 0; ; i++) {
    try { if ((await fetch(origin)).ok) break; } catch {}
    assert(i < 600 && launcher.exitCode === null, "local launcher unavailable: " + launcher.log()); await sleep(100);
  }
  assert(launcher.log().includes("Motor de salida: ffmpeg"), "launcher did not default to FFmpeg");
  const { ADMIN_PASSWORD } = JSON.parse(readFileSync(join(work, "secrets.json")));
  browser = await chromium.launch({ headless: true, executablePath: env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(origin); await page.getByLabel("Contraseña de administrador").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Abrir mi estudio" }).click(); await page.getByRole("heading", { name: "Mi estudio" }).waitFor();
  const request = async (path, data) => {
    const r = await page.request.post(origin + "/api/v1" + path, { headers: { Origin: origin }, data });
    assert(r.ok(), path + ": " + await r.text()); return r.json();
  };
  await request("/destinations", { platform: "custom", name: "Local receiver", url: `rtmp://127.0.0.1:${rtmp}/live`, key: "test" });
  const started = await request("/broadcast/start?record=true", {});
  const studio = async () => (await page.request.get(origin + "/api/v1/studio")).json();
  for (let i = 0; ; i++) {
    const state = await studio(); if (state.destinations[0]?.status === "live") break;
    assert(i < 120, "RTMP never became live: " + JSON.stringify(state.broadcast)); await sleep(500);
  }
  assert(page.frames().some(f => f.url().includes("ingest=1")), "no browser compositor started");
  await sleep(4000); await request("/broadcast/stop?all=true", {});
  for (let i = 0; ; i++) { if ((await studio()).broadcast.status === "complete") break; assert(i < 100, "recording did not complete"); await sleep(200); }
  await sleep(1000);
  for (const file of [received, join(work, "recordings", started.id + ".mp4")]) {
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height", "-of", "json", file]));
    assert(statSync(file).size > 10000, "empty output");
    assert(probe.streams.some(s => s.codec_name === "h264" && s.width === 1920 && s.height === 1080), "missing H264 video");
    assert(probe.streams.some(s => s.codec_name === "aac"), "missing AAC audio");
  }
  assert(!errors.length, errors.join("\n")); success = true;
  console.log("LOCAL STREAM E2E OK: dev default, browser compositor, RTMP H264/AAC and local MP4");
} catch (e) { console.error(e.message); for (const p of children) console.error(p.log()); }
finally {
  await browser?.close();
  for (const p of children) try { process.kill(-p.pid, "SIGTERM"); } catch {}
  await sleep(1000);
  for (const p of children) try { process.kill(-p.pid, "SIGKILL"); } catch {}
  console.log("Artifacts:", work); process.exit(success ? 0 : 1);
}
