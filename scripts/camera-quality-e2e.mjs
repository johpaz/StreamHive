// Prueba con la CÁMARA REAL: emite con 720p, 1080p y 4K cambiando la calidad desde el diálogo y mide
// qué resolución entrega la cámara y cuál llega al compositor. Guarda un fotograma de cada tramo.
import { _electron as electron } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "sh-camq-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw Error(m); };
const seg = Number(process.argv[2] || 9);
let app, sink, failed = false;
try {
  const sinkFile = join(work, "sink.flv");
  sink = spawn("ffmpeg", ["-v", "error", "-listen", "1", "-i", "rtmp://127.0.0.1:19371/live/k", "-c", "copy", "-y", sinkFile], { stdio: "ignore" });
  app = await electron.launch({
    executablePath: process.env.E2E_PACKAGED || join(root, "desktop/electron/node_modules/electron/dist/electron"),
    args: process.env.E2E_PACKAGED ? [] : [join(root, "desktop/electron")],
    env: { ...process.env, TMPDIR: "/tmp", STREAMHIVE_E2E: "1", STREAMHIVE_PORT: "8802", STREAMHIVE_LK_PORT: "7998", STREAMHIVE_RECORDINGS: join(work, "rec"), XDG_CONFIG_HOME: join(work, "config") },
    timeout: 60000,
  });
  const info = await new Promise((res, rej) => { const t = setTimeout(() => rej(Error("sin READY")), 30000); app.process().stdout.on("data", (d) => { const m = String(d).match(/STREAMHIVE_READY (.*)/); if (m) { clearTimeout(t); res(JSON.parse(m[1])); } }); });
  const origin = info.base;
  const page = await app.firstWindow();
  await page.getByRole("heading", { name: "Mi estudio" }).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Probar dispositivos", exact: true }).click();
  await page.getByRole("button", { name: "Probar cámara y micrófono" }).click();
  await page.getByText("Micrófono activo · habla para comprobar el nivel").waitFor();
  await page.getByRole("button", { name: "Conectar cámara y audio" }).click();
  await page.getByText("Sala conectada", { exact: true }).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Añadir Anfitrión", exact: true }).click();
  const post = (path, data, method = "POST") => page.request.fetch(`${origin}${path}`, { method, headers: { Origin: origin }, data });
  assert((await post("/api/v1/destinations", { platform: "custom", name: "local", url: "rtmp://127.0.0.1:19371/live", key: "k" })).ok(), "destino");
  assert((await post("/api/v1/broadcast/start", {})).ok(), "start");
  let renderer;
  for (let i = 0; i < 60 && !renderer; i++) { renderer = app.windows().find((w) => w.url().includes("/render?")); if (!renderer) await sleep(250); }
  assert(renderer, "sin compositor");
  const readDialog = async () => {
    await page.getByRole("button", { name: "Calidad de cámara" }).click();
    const dlg = page.getByRole("dialog", { name: "Calidad de cámara" });
    await dlg.waitFor();
    const facts = await dlg.locator(".quality-facts").innerText();
    return { dlg, facts: facts.replace(/\s+/g, " ") };
  };
  const received = () => renderer.evaluate(() => { const v = document.querySelector(".camera-tile video"); return v ? `${v.videoWidth}x${v.videoHeight}` : "sin vídeo"; });
  const rows = [];
  const t0 = Date.now();
  const marks = [];
  for (const [label, radio] of [["actual (Automática)", null], ["720p · 30 fps", "720p · 30 fps"], ["1080p · 30 fps", "1080p · 30 fps"], ["4K · 30 fps", "4K · 30 fps"]]) {
    if (radio) {
      const { dlg } = await readDialog();
      await dlg.getByLabel(new RegExp(radio.replace(/[·]/g, "."))).check();
      await dlg.getByRole("button", { name: "Aplicar" }).click();
      await dlg.waitFor({ state: "detached", timeout: 30000 });
      await sleep(3500);
    }
    await sleep(seg * 1000);
    const { dlg, facts } = await readDialog();
    await page.keyboard.press("Escape");
    await dlg.waitFor({ state: "detached" }).catch(() => {});
    const row = { calidad: label, cámara: facts, enCompositor: await received() };
    marks.push([label, (Date.now() - t0) / 1000 - 2]);
    rows.push(row); console.log(JSON.stringify(row));
  }
  assert((await post("/api/v1/broadcast/stop", {})).ok(), "stop");
  const studio = await (await page.request.get(`${origin}/api/v1/studio`)).json();
  for (let i = 0; i < 100; i++) { const b = (await (await page.request.get(`${origin}/api/v1/studio`)).json()).broadcast; if (/complete|error/.test(b?.status)) break; await sleep(250); }
  const mp4 = join(work, "rec", `${studio.broadcast.id}.mp4`);
  assert(existsSync(mp4), "sin MP4");
  const startLive = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4]).toString()) - (Date.now() - t0) / 1000;
  for (const [label, at] of marks) {
    const f = join(work, `q-${label.replace(/\W+/g, "_")}.png`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(Math.max(0, at + Math.max(0, startLive))), "-i", mp4, "-frames:v", "1", f]);
    console.log("fotograma", label, "->", f);
  }
  console.log("CAMERA QUALITY E2E OK");
} catch (e) { failed = true; console.error("CAMERA QUALITY E2E FALLÓ:", e.message.split("\n")[0]); }
finally { await app?.close().catch(() => {}); sink?.kill(); process.exit(failed ? 1 : 0); }
