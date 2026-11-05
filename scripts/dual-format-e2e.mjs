// Isolated web E2E: two actual compositors, RTMP receivers, reconnects and MP4s.
// No production credentials or external streaming platforms are used.
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, writeFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "sh-dual-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (ok, message) => { if (!ok) throw Error(message); };
const port = () => new Promise((resolve, reject) => { const server = createServer(); server.on("error", reject); server.listen(0, "127.0.0.1", () => { const n = server.address().port; server.close(() => resolve(n)); }); });
const procs = [];
const launch = (cmd, args, env = {}) => {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; p.stdout.on("data", (s) => { log = (log + s).slice(-2000); }); p.stderr.on("data", (s) => { log = (log + s).slice(-2000); });
  p.log = () => log; procs.push(p); return p;
};
let browser, failed = false;
try {
  const [api, lk, tcp, udp, a, b, c] = await Promise.all(Array.from({ length: 7 }, port));
  const origin = `http://localhost:${api}`;
  const secret = randomBytes(32).toString("hex"), pass = randomBytes(16).toString("hex");
  const config = join(work, "livekit.yaml");
  writeFileSync(config, `port: ${lk}\nbind_addresses:\n  - 127.0.0.1\nrtc:\n  tcp_port: ${tcp}\n  udp_port: ${udp}\n  use_external_ip: false\nkeys:\n  dual: ${secret}\n`);
  launch(join(root, "runtime/bin/livekit-server"), ["--config", config, "--node-ip", "127.0.0.1"]);
  const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";
  const sink = (n, filename) => launch(ffmpeg, ["-v", "error", "-listen", "1", "-i", `rtmp://127.0.0.1:${n}/live/test`, "-c", "copy", "-y", join(work, filename)]);
  sink(a, "horizontal.flv"); const verticalSink = sink(b, "vertical.flv");
  launch(join(root, "target/release/streamhive"), [], {
    ENGINE: "ffmpeg", FFMPEG_BIN: ffmpeg, DATA_DIR: join(work, "data"), RECORDINGS_DIR: join(work, "rec"),
    LISTEN_ADDR: `127.0.0.1:${api}`, STATIC_DIR: join(root, "frontend/dist"), PUBLIC_ORIGIN: origin,
    RENDERER_URL: `${origin}/render`, LIVEKIT_INTERNAL_URL: `http://127.0.0.1:${lk}`, LIVEKIT_PUBLIC_URL: `ws://localhost:${lk}`,
    LIVEKIT_API_KEY: "dual", LIVEKIT_API_SECRET: secret, ADMIN_PASSWORD: pass, SESSION_SECRET: secret, MASTER_KEY: randomBytes(32).toString("base64"),
  });
  for (let i = 0; ; i++) { try { if ((await fetch(`${origin}/healthz`)).ok) break; } catch {} assert(i < 100, "backend unavailable"); await sleep(100); }
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await ctx.newPage(); const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  await page.getByLabel("Contraseña de administrador").fill(pass);
  await page.getByRole("button", { name: "Abrir mi estudio" }).click();
  await page.getByRole("heading", { name: "Mi estudio" }).waitFor();
  const request = async (path, body, method = "POST") => {
    const r = await page.request.fetch(`${origin}/api/v1${path}`, { method, headers: { Origin: origin }, data: body });
    assert(r.ok(), `${method} ${path}: ${await r.text()}`); return r.json();
  };
  const studio = () => page.request.get(`${origin}/api/v1/studio`).then((r) => r.json());
  // Store independent compositions and recall a saved scene from the UI.
  let state = await studio();
  await request("/program", { ...state.program, background: "#112233" }, "PUT");
  await page.getByLabel("Nombre de la escena").fill("Horizontal QA");
  await page.getByRole("button", { name: "Guardar escena actual" }).click();
  await page.getByRole("list", { name: "Escenas guardadas" }).getByText("Horizontal QA", { exact: true }).waitFor();
  await page.getByLabel("Composición", { exact: true }).selectOption("portrait");
  state = await studio();
  await request("/program?format=portrait", { ...state.portrait_program, background: "#553322" }, "PUT");
  await page.getByLabel("Nombre de la escena").fill("Vertical QA");
  await page.getByRole("button", { name: "Guardar escena actual" }).click();
  await page.getByRole("list", { name: "Escenas guardadas" }).getByText("Vertical QA", { exact: true }).waitFor();
  await page.locator(".stage.format-portrait").waitFor();
  await page.screenshot({ path: join(work, "vertical-preview.png") });
  await page.getByRole("button", { name: /Configuración/ }).first().click();
  await page.getByRole("heading", { name: "Destinos de transmisión" }).waitFor();
  for (const [name, n, format] of [["Horizontal QA", a, "landscape"], ["Vertical QA", b, "portrait"], ["Recovery QA", c, "landscape"]]) {
    await page.getByLabel("Plataforma").selectOption("custom");
    await page.getByLabel("Nombre", { exact: true }).fill(name);
    await page.getByLabel("Formato de salida").selectOption(format);
    await page.getByLabel("URL RTMP / RTMPS").fill(`rtmp://127.0.0.1:${n}/live`);
    await page.getByLabel("Clave de transmisión").fill("test");
    await page.getByRole("button", { name: "Añadir destino", exact: true }).click();
    await page.getByRole("list", { name: "Destinos de transmisión" }).getByText(name, { exact: true }).waitFor();
  }
  // Edits preserve the destination ID and keep saved credentials hidden.
  const row = page.getByRole("list", { name: "Destinos de transmisión" }).locator("li").filter({ hasText: "Vertical QA" });
  await row.getByRole("button", { name: "Editar", exact: true }).click();
  await page.getByLabel("Clave de transmisión").fill("test");
  await page.getByRole("button", { name: "Guardar destino", exact: true }).click();
  await page.getByRole("button", { name: "Añadir destino", exact: true }).waitFor();
  await page.getByRole("button", { name: /Estudio en vivo/ }).click();
  const started = await request("/broadcast/start?record=true", {});
  const waitState = async (name, expected, timeout = 30000) => {
    for (const end = Date.now() + timeout; Date.now() < end;) {
      const s = await studio();
      if (s.destinations.find((d) => d.name === name)?.status === expected) return s;
      await sleep(300);
    }
    console.error("Renderers:", await Promise.all(page.frames().filter((f) => f.url().includes("/render?")).map((f) => f.evaluate(() => ({ stage: !!document.querySelector(".stage"), text: document.body.innerText.slice(0, 100), capture: window.__streamhiveCapture?.frames, visibility: document.visibilityState })))));
    throw Error(`${name} did not reach ${expected}: ${JSON.stringify((await studio()).destinations)}`);
  };
  await waitState("Horizontal QA", "live"); await waitState("Vertical QA", "live");
  state = await waitState("Recovery QA", "reconnecting");
  assert(state.broadcast.status === "reconnecting", "unhealthy output hidden by healthy one");
  assert(page.frames().filter((f) => f.url().includes("/render?")).length === 2, "expected two independent compositors");
  console.log("Both formats publish simultaneously; failed destination is visible");
  sink(c, "recovered.flv"); await waitState("Recovery QA", "live");
  verticalSink.kill("SIGTERM"); await waitState("Vertical QA", "reconnecting");
  sink(b, "vertical-recovered.flv");
  const vertical = (await studio()).destinations.find((d) => d.name === "Vertical QA");
  await request(`/broadcast/retry?destination_id=${vertical.id}`, {});
  state = await waitState("Vertical QA", "live");
  assert(state.broadcast.id === started.id && state.destinations.find((d) => d.name === "Horizontal QA").status === "live", "recovery interrupted other outputs");
  await sleep(4000);
  await request("/broadcast/stop?all=true", {});
  for (let i = 0; i < 100; i++) { if (["complete", "error"].includes((await studio()).broadcast.status)) break; await sleep(200); }
  assert((await studio()).broadcast.status === "complete", "broadcast did not finish cleanly");
  await sleep(1000);
  const probe = (file) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height,r_frame_rate:format=duration", "-of", "json", file]).toString());
  for (const [name, width, height] of [["horizontal.flv", 1920, 1080], ["vertical.flv", 1080, 1920], ["recovered.flv", 1920, 1080], ["vertical-recovered.flv", 1080, 1920], [`rec/${started.id}.mp4`, 1920, 1080], [`rec/${started.id}-portrait.mp4`, 1080, 1920]]) {
    const file = join(work, name), p = probe(file);
    assert(statSync(file).size > 10000, `${name} missing output`);
    assert(p.streams.some((s) => s.codec_name === "h264" && s.width === width && s.height === height), `${name} wrong video`);
    assert(p.streams.some((s) => s.codec_name === "aac"), `${name} missing AAC audio`);
    console.log(name, width, height, statSync(file).size, "bytes");
  }
  for (const [suffix, expected] of [["", [17, 34, 51]], ["-portrait", [85, 51, 34]]]) {
    const pixel = execFileSync("ffmpeg", ["-v", "error", "-ss", "2", "-i", join(work, "rec", `${started.id}${suffix}.mp4`), "-vf", "crop=2:2:0:0", "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]);
    assert(expected.every((value, i) => Math.abs(pixel[i] - value) <= 8), "recorded scenes are not independent");
  }
  assert(!errors.length, errors.join("\n"));
  console.log("DUAL FORMAT E2E OK: two programs, three destinations, automatic and manual recovery, two MP4s");
} catch (e) { failed = true; console.error(e.message); for (const p of procs) { if (p.log()) console.error(p.log().slice(-1000)); } }
finally {
  await browser?.close(); for (const p of procs) p.kill("SIGTERM");
  console.log("Artifacts:", work); process.exit(failed ? 1 : 0);
}
