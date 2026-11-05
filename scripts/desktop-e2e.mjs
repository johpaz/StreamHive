// Prueba de extremo a extremo del modo escritorio SIN Tauri: backend release (ENGINE=ffmpeg)
// + livekit-server + ffmpeg, con Chromium de Playwright haciendo de webview (host + compositor).
// Uso: bun scripts/desktop-e2e.mjs   (requiere target/release/streamhive y runtime/bin/livekit-server)
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "sh-e2e-"));
const hex = (n) => randomBytes(n).toString("hex");
const api = Number(process.env.E2E_API_PORT || 8791), lkPort = Number(process.env.E2E_LK_PORT || 7890), rtmpPort = 19350;
const origin = `http://localhost:${api}`;
const sec = { pass: hex(10), session: hex(32), master: randomBytes(32).toString("base64"), key: "e2e" + hex(4), secret: hex(32) };
const procs = [];
const run = (cmd, args, env = {}, name = cmd) => {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; p.stdout.on("data", (d) => (log += d)); p.stderr.on("data", (d) => (log += d));
  p.log = () => log; p.name = name; procs.push(p); return p;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw Error(m); };
let browser, failed = false;
try {
  writeFileSync(join(work, "lk.yaml"), `port: ${lkPort}\nrtc:\n  tcp_port: ${lkPort + 1}\n  udp_port: ${lkPort + 2}\n  use_external_ip: false\nkeys:\n  ${sec.key}: ${sec.secret}\n`);
  run(join(root, "runtime/bin/livekit-server"), ["--config", join(work, "lk.yaml"), "--node-ip", "127.0.0.1"], {}, "livekit");
  // Destino RTMP local: ffmpeg actúa de servidor y guarda lo recibido.
  const sinkFile = join(work, "sink.flv");
  const sink = run("ffmpeg", ["-v", "error", "-listen", "1", "-i", `rtmp://127.0.0.1:${rtmpPort}/live/key`, "-c", "copy", "-y", sinkFile], {}, "rtmp-sink");
  const rec = join(work, "rec");
  run(join(root, "target/release/streamhive"), [], {
    ENGINE: "ffmpeg", DATA_DIR: join(work, "data"), RECORDINGS_DIR: rec, LISTEN_ADDR: `127.0.0.1:${api}`,
    STATIC_DIR: join(root, "frontend/dist"), PUBLIC_ORIGIN: origin, RENDERER_URL: `${origin}/render`,
    LIVEKIT_INTERNAL_URL: `http://127.0.0.1:${lkPort}`, LIVEKIT_PUBLIC_URL: `ws://localhost:${lkPort}`,
    LIVEKIT_API_KEY: sec.key, LIVEKIT_API_SECRET: sec.secret, ADMIN_PASSWORD: sec.pass,
    SESSION_SECRET: sec.session, MASTER_KEY: sec.master,
  }, "backend");
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${origin}/healthz`)).ok) break; } catch {}
    assert(i < 100, "El backend no arrancó:\n" + procs.map((p) => p.name + ": " + p.log()).join("\n"));
    await sleep(100);
  }
  browser = await chromium.launch({
    headless: !process.env.CHROMIUM_PATH,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    env: { ...process.env, TMPDIR: "/tmp" }, // rutas de socket de Chromium cortas
    args: [...(process.env.CHROMIUM_PATH ? ["--headless=new"] : []), "--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  await page.getByLabel("Contraseña de administrador").fill(sec.pass);
  await page.getByRole("button", { name: "Abrir mi estudio" }).click();
  await page.getByRole("heading", { name: "Mi estudio" }).waitFor();
  await page.getByRole("button", { name: "Probar dispositivos", exact: true }).click();
  await page.getByRole("button", { name: "Probar cámara y micrófono" }).click();
  await page.getByText("Micrófono activo · habla para comprobar el nivel").waitFor();
  await page.getByRole("button", { name: "Conectar cámara y audio" }).click();
  await page.getByText("Sala conectada", { exact: true }).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Añadir Anfitrión", exact: true }).click();
  const post = (path, data, method = "POST") =>
    page.request.fetch(`${origin}${path}`, { method, headers: { Origin: origin }, data });
  const d = await post("/api/v1/destination", { url: `rtmp://127.0.0.1:${rtmpPort}/live`, key: "key" }, "PUT");
  assert(d.ok(), "destino: " + (await d.text()));
  await sleep(500);
  const start = await post("/api/v1/broadcast/start?record=true", {});
  assert(start.ok(), "start: " + (await start.text()));
  // Lo que hará el shell Tauri: preguntar por la ventana del compositor y abrirla.
  let path;
  for (let i = 0; i < 20 && !path; i++) {
    path = (await (await page.request.get(`${origin}/api/v1/desktop/renderer`)).json()).url;
    if (!path) await sleep(500);
  }
  assert(path, "No se ofreció ventana de compositor");
  // Sin Tauri el estudio monta el compositor en un iframe oculto (DesktopRenderer).
  let renderer;
  for (let i = 0; i < 40 && !renderer; i++) { renderer = page.frames().find((f) => f.url().includes("/render?")); if (!renderer) await sleep(250); }
  assert(renderer, "El estudio no montó el compositor");
  await sleep(3000);
  console.log("renderer:", JSON.stringify(await renderer.evaluate(() => { const r = document.querySelector(".stage")?.getBoundingClientRect(); return { w: innerWidth, h: innerHeight, stage: r && [r.width, r.height], cls: document.documentElement.className }; })));
  await sleep(Number(process.env.E2E_SECONDS || 15) * 1000);
  const status = await (await page.request.get(`${origin}/api/v1/studio`)).json();
  console.log("estado de la emisión:", status.broadcast?.status, status.broadcast?.error || "");
  const stop = await post("/api/v1/broadcast/stop?all=true", {});
  assert(stop.ok(), "stop: " + (await stop.text()));
  const mp4 = join(rec, `${status.broadcast.id}.mp4`);
  for (let i = 0; i < 80 && !(await (await page.request.get(`${origin}/api/v1/studio`)).json()).broadcast?.status.match(/complete|error/); i++) await sleep(250);
  assert(existsSync(mp4), "No existe el MP4 " + mp4);
  const probe = (f) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration", "-of", "json", f]).toString());
  const info = probe(mp4);
  console.log("MP4:", statSync(mp4).size, "bytes", JSON.stringify(info));
  assert(info.streams.some((s) => s.codec_type === "video" && s.width === 1920), "sin vídeo 1920 en el MP4");
  assert(info.streams.some((s) => s.codec_type === "audio"), "sin audio en el MP4");
  assert(Number(info.format.duration) > 5, "MP4 demasiado corto");
  await sleep(500);
  if (existsSync(sinkFile)) console.log("RTMP recibido:", statSync(sinkFile).size, "bytes");
  assert(existsSync(sinkFile) && statSync(sinkFile).size > 10000, "El destino RTMP no recibió datos");
  // Fotograma del medio para inspección visual
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", "5", "-i", mp4, "-frames:v", "1", join(work, "frame.png")]);
  console.log("fotograma:", join(work, "frame.png"));
  if (errors.length) console.log("errores de página:", errors.slice(0, 5));
  console.log("E2E OK");
} catch (e) {
  failed = true; console.error("E2E FALLÓ:", e.message);
  for (const p of procs) console.error(`--- ${p.name}\n${p.log().slice(-1500)}`);
} finally {
  await browser?.close();
  for (const p of procs) p.kill("SIGTERM");
  console.log("directorio de trabajo:", work);
  process.exit(failed ? 1 : 0);
}
