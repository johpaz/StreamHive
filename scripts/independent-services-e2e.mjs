// Drives the live and recording buttons through every combination on the real `dev` launcher.
// Uses isolated settings and a local RTMP receiver; never reads a real stream key.
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "sh-independent-services-"));
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
  const receive = (name) => {
    const file = join(work, name);
    const sink = launch(env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-listen", "1", "-i", `rtmp://127.0.0.1:${rtmp}/live/test`, "-c", "copy", "-y", file], env);
    return { file, sink };
  };
  const first = receive("first.flv");
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
  await page.getByRole("button", { name: /Estudio en vivo/ }).click();
  const studio = async () => (await page.request.get(origin + "/api/v1/studio")).json();
  const recordings = async () => (await page.request.get(origin + "/api/v1/recordings")).json();
  const until = async (label, check, timeout = 60000) => {
    let state;
    for (const end = Date.now() + timeout; Date.now() < end;) {
      state = await studio(); if (await check(state)) return state; await sleep(300);
    }
    throw Error(`${label}: ${JSON.stringify(state?.broadcast)} ${JSON.stringify(state?.destinations)}`);
  };
  const button = (name) => page.locator(".workspace-broadcast-bar").getByRole("button", { name, exact: true });
  const destination = (s) => s.destinations[0]?.status;
  const mp4s = () => readdirSync(join(work, "recordings")).filter(f => f.endsWith(".mp4"));
  const media = (file) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height:format=duration", "-of", "json", file]));
  const valid = (file) => {
    const probe = media(file);
    assert(statSync(file).size > 10000, "empty output " + file);
    assert(probe.streams.some(s => s.codec_name === "h264" && s.width === 1920 && s.height === 1080), "missing H264 video " + file);
    assert(probe.streams.some(s => s.codec_name === "aac"), "missing AAC audio " + file);
    return Number(probe.format.duration);
  };

  // Directo solo: emite sin escribir ningún archivo.
  await button("Iniciar directo").click();
  await until("live never started", s => destination(s) === "live");
  await sleep(4000);
  assert(mp4s().length === 0, "going live wrote a recording: " + mp4s());
  assert((await recordings()).length === 0, "going live listed a recording");
  console.log("OK live only: RTMP publishing, no file");

  // Grabar a mitad del directo, sin cortar la emisión.
  await button("Grabar").click();
  await button("Detener grabación").waitFor();
  const { id } = (await studio()).broadcast;
  await sleep(8000);
  const both = await studio();
  assert(both.broadcast.id === id && destination(both) === "live", "recording interrupted the live");
  await page.locator(".workspace-broadcast-bar").screenshot({ path: join(work, "bar-both.png") });
  console.log("OK recording joined the running live");

  // Finalizar el directo no detiene la grabación.
  await button("Finalizar directo").click();
  await button("Iniciar directo").waitFor();
  const onlyRecording = await until("live did not stop", s => s.broadcast.live === false && destination(s) === "ready");
  assert(onlyRecording.broadcast.id === id && onlyRecording.broadcast.recording, "stopping the live ended the session");
  await sleep(2000);
  const size = statSync(join(work, "recordings", `${id}.mp4`)).size;
  await sleep(3000);
  assert(statSync(join(work, "recordings", `${id}.mp4`)).size > size, "recording stopped growing after the live ended");
  await page.locator(".workspace-broadcast-bar").screenshot({ path: join(work, "bar-recording.png") });
  console.log("OK live stopped, recording continues");

  // Volver al aire mientras se graba.
  await sleep(1000);
  const second = receive("second.flv");
  await button("Iniciar directo").click();
  await until("live did not come back", s => destination(s) === "live");
  await sleep(4000);
  console.log("OK live restarted during the recording");

  // Detener la grabación con el directo en marcha.
  await button("Detener grabación").click();
  await button("Grabar").waitFor();
  await until("recording did not finish", async s => s.broadcast.id === id && (await recordings()).every(r => r.status === "complete"));
  const live = await studio();
  assert(destination(live) === "live" && live.broadcast.status !== "ending", "stopping the recording touched the live");
  await sleep(1000);
  const duration = valid(join(work, "recordings", `${id}.mp4`));
  assert(duration > 10, "recording too short: " + duration);
  console.log("OK recording closed during the live, duration", duration);

  // Terminar el último servicio cierra la sesión.
  await button("Finalizar directo").click();
  await until("session did not end", s => s.broadcast.status === "complete");
  await button("Grabar").waitFor();
  await sleep(1000);
  for (const { file } of [first, second]) valid(file);
  console.log("OK both RTMP receptions are valid");

  // Solo grabación: sin publicar nada.
  const third = receive("never.flv");
  await button("Grabar").click();
  await until("recording-only did not start", s => s.broadcast.id !== id && s.broadcast.status === "live" && s.broadcast.live === false);
  await sleep(6000);
  assert(destination(await studio()) === "ready", "recording-only reached a destination");
  await button("Detener grabación").click();
  const last = await until("recording-only did not end", s => s.broadcast.id !== id && s.broadcast.status === "complete");
  await sleep(1000);
  valid(join(work, "recordings", `${last.broadcast.id}.mp4`));
  assert(!existsSync(third.file), "recording-only published to RTMP");
  assert((await recordings()).every(r => r.status === "complete" && r.bytes > 0), "library state: " + JSON.stringify(await recordings()));

  // Carpeta de grabaciones: se ve la predeterminada y se puede elegir otra.
  const folder = join(work, "elegida", "videos");
  await page.getByRole("button", { name: /Configuración/ }).first().click();
  const panel = page.locator(".recordings-folder");
  await panel.getByText(join(work, "recordings"), { exact: true }).waitFor();
  await panel.getByText("Carpeta actual (predeterminada)").waitFor();
  const field = panel.getByLabel("Guardar las grabaciones en");
  await field.fill("carpeta-relativa");
  await panel.getByRole("button", { name: "Guardar carpeta" }).click();
  await page.getByText("Indica la ruta completa de la carpeta").waitFor();
  await field.fill(folder);
  await panel.getByRole("button", { name: "Guardar carpeta" }).click();
  await panel.getByText(folder, { exact: true }).waitFor();
  await panel.getByText("Predeterminada", { exact: true }).waitFor();
  await panel.screenshot({ path: join(work, "folder.png") });
  const before = mp4s().length;
  await page.getByRole("button", { name: /Estudio en vivo/ }).click();
  await button("Grabar").click();
  await button("Detener grabación").waitFor();
  const chosen = await until("chosen folder session", s => s.broadcast.id !== last.broadcast.id && s.broadcast.status === "live");
  await sleep(6000);
  await button("Detener grabación").click();
  await until("chosen folder session did not end", s => s.broadcast.id === chosen.broadcast.id && s.broadcast.status === "complete");
  await sleep(1000);
  valid(join(folder, `${chosen.broadcast.id}.mp4`));
  assert(mp4s().length === before, "recording also written to the default folder");
  const library = await recordings();
  assert(library[0].location === join(folder, `${chosen.broadcast.id}.mp4`), "library hides the chosen location");
  assert(library.slice(1).every(r => r.location.startsWith(join(work, "recordings"))), "older recordings moved");
  const download = await page.request.get(`${origin}/api/v1/recordings/${chosen.broadcast.id}`);
  assert(download.ok() && (await download.body()).length > 10000, "cannot download from the chosen folder");
  await page.getByRole("button", { name: /Grabaciones/ }).first().click();
  await page.locator(".recording-card").first().getByText(folder, { exact: false }).waitFor();
  await page.getByRole("button", { name: /Configuración/ }).first().click();
  await panel.getByRole("button", { name: "Usar la predeterminada" }).click();
  await panel.getByText("Carpeta actual (predeterminada)").waitFor();
  console.log("OK folder: default visible, chosen folder used, older recordings kept");
  assert(!errors.length, errors.join("\n")); success = true;
  console.log("INDEPENDENT SERVICES E2E OK: live and recording start and stop separately");
} catch (e) { console.error(e.message); for (const p of children) console.error(p.log()); }
finally {
  await browser?.close();
  for (const p of children) try { process.kill(-p.pid, "SIGTERM"); } catch {}
  await sleep(1000);
  for (const p of children) try { process.kill(-p.pid, "SIGKILL"); } catch {}
  console.log("Artifacts:", work); process.exit(success ? 0 : 1);
}
