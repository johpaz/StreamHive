// Banco de pruebas de capacidad de la app Electron real: 0..5 invitados sintéticos en directo.
// Mide con el propio monitor (/api/v1/resources) y comprueba el MP4 resultante.
// Los invitados corren en ESTA máquina (sus navegadores consumen CPU que en la realidad estaría en otros equipos),
// por eso se informa por separado: "StreamHive" = suma de procesos propios, "máquina" = CPU total.
// Uso: E2E_PACKAGED=/ruta/streamhive-desktop CHROMIUM_PATH=/ruta/chrome bun scripts/electron-bench.mjs [segundos-por-escenario]
import { _electron as electron, chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "sh-bench-"));
const secs = Number(process.argv[2] || 20);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw Error(m); };
const guests = Number(process.env.BENCH_GUESTS || 5);
const rows = [];
let app, browser, sink, failed = false;
try {
  const sinkFile = join(work, "sink.flv");
  sink = spawn("ffmpeg", ["-v", "error", "-listen", "1", "-i", "rtmp://127.0.0.1:19352/live/key", "-c", "copy", "-y", sinkFile], { stdio: "ignore" });
  const rec = join(work, "rec");
  let exe = process.env.E2E_PACKAGED || join(root, "desktop/electron/node_modules/electron/dist/electron");
  if (process.env.BENCH_CPUS) {
    // Limita la app a N núcleos (p. ej. "0-3") para emular un equipo modesto; los invitados quedan libres.
    const wrapper = join(work, "limited.sh");
    writeFileSync(wrapper, `#!/bin/sh\nexec taskset -c ${process.env.BENCH_CPUS} "${exe}" "$@"\n`, { mode: 0o755 });
    exe = wrapper;
  }
  const video = process.env.BENCH_VIDEO ? { STREAMHIVE_FAKE_VIDEO_FILE: process.env.BENCH_VIDEO } : {};
  app = await electron.launch({
    executablePath: exe,
    args: process.env.E2E_PACKAGED ? ["--no-sandbox"] : ["--no-sandbox", join(root, "desktop/electron")],
    env: { ...process.env, ...video, TMPDIR: "/tmp", STREAMHIVE_FAKE_MEDIA: "1", STREAMHIVE_E2E: "1", STREAMHIVE_PORT: "8794", STREAMHIVE_LK_PORT: "7950", STREAMHIVE_RECORDINGS: rec, XDG_CONFIG_HOME: join(work, "config") },
    timeout: 60000,
  });
  const info = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(Error("sin STREAMHIVE_READY")), 30000);
    app.process().stdout.on("data", (d) => { const m = String(d).match(/STREAMHIVE_READY (.*)/); if (m) { clearTimeout(t); res(JSON.parse(m[1])); } });
  });
  const origin = info.base;
  const page = await app.firstWindow();
  // Entrada automática: no debe aparecer ninguna pantalla de contraseña.
  await page.getByRole("heading", { name: "Mi estudio" }).waitFor({ timeout: 20000 });
  assert((await page.getByLabel("Contraseña de administrador").count()) === 0, "apareció la pantalla de contraseña");
  await page.getByRole("button", { name: "Probar dispositivos", exact: true }).click();
  await page.getByRole("button", { name: "Probar cámara y micrófono" }).click();
  await page.getByText("Micrófono activo · habla para comprobar el nivel").waitFor();
  await page.getByRole("button", { name: "Conectar cámara y audio" }).click();
  await page.getByText("Sala conectada", { exact: true }).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Añadir Anfitrión", exact: true }).click();
  const post = (path, data, method = "POST") => page.request.fetch(`${origin}${path}`, { method, headers: { Origin: origin }, data });
  assert((await post("/api/v1/destination", { url: "rtmp://127.0.0.1:19352/live", key: "key" }, "PUT")).ok(), "destino");

  const measure = async (label, n, duration = secs) => {
    const samples = [];
    // Misma medición que para OBS: tiempo de CPU y memoria PSS de todo el árbol de procesos de la app.
    const usage = new Promise((res) => {
      let out = "";
      const pr = spawn("python3", [join(root, "scripts/proc-usage.py"), "--root", String(app.process().pid), "--seconds", String(duration)]);
      pr.stdout.on("data", (d) => (out += d)); pr.on("close", () => { try { res(JSON.parse(out)); } catch { res(null); } });
    });
    const t0 = Date.now();
    while (Date.now() - t0 < duration * 1000) {
      const r = await (await page.request.get(`${origin}/api/v1/resources`)).json();
      if (r.ready) samples.push(r);
      await sleep(2000);
    }
    const avg = (f) => samples.reduce((a, s) => a + f(s), 0) / Math.max(1, samples.length);
    const max = (f) => Math.max(...samples.map(f));
    const own = (s) => Object.values(s.sample.groups).reduce((a, g) => a + g.cpu, 0);
    const ownMem = (s) => Object.values(s.sample.groups).reduce((a, g) => a + g.mem, 0);
    const enc = samples.at(-1)?.encoder || {};
    const renderer = app.windows().find((w) => w.url().includes("/render?"));
    const cap = renderer ? await renderer.evaluate(() => window.__streamhiveCapture || null).catch(() => null) : null;
    const proc = await usage;
    const recibido = renderer ? await renderer.evaluate(() => [...document.querySelectorAll('.camera-tile video')].map((v) => `${v.videoWidth}x${v.videoHeight}`)).catch(() => null) : null;
    const ram = samples.map(ownMem);
    const k = Math.max(1, Math.floor(ram.length / 5));
    const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    const row = {
      ram_crecimiento_mb: ram.length >= 10 ? Math.round((mean(ram.slice(-k)) - mean(ram.slice(0, k))) / 1e6) : null,
      nucleos: samples[0]?.sample.cpus, nucleos_streamhive: +(avg(own) * (samples[0]?.sample.cpus || 1) / 100).toFixed(2),
      proc, recibido, escenario: label, invitados: n, muestras: samples.length,
      cpu_streamhive_pct: +avg(own).toFixed(1), cpu_streamhive_max: +max(own).toFixed(1),
      cpu_maquina_pct: +avg((s) => s.sample.cpu).toFixed(1), cpu_maquina_max: +max((s) => s.sample.cpu).toFixed(1),
      ram_streamhive_mb: Math.round(avg(ownMem) / 1e6), ram_maquina_pct: +avg((s) => s.sample.mem_used * 100 / s.sample.mem_total).toFixed(1),
      grupos: Object.fromEntries(Object.entries(samples.at(-1)?.sample.groups || {}).map(([k, g]) => [k, +g.cpu.toFixed(1)])),
      enc_fps: enc.fps, enc_speed: enc.speed, enc_drop: enc.drop_frames, enc_kbps: enc.bitrate,
      compositor: cap && { dibujados: cap.frames, ms_medio: +cap.avgMs.toFixed(1), ms_max: +cap.maxMs.toFixed(1), lentos: cap.slow },
      consejo: samples.at(-1)?.advice,
    };
    rows.push(row);
    console.log(JSON.stringify(row));
  };

  assert((await post("/api/v1/broadcast/start", {})).ok(), "start");
  await sleep(6000);
  await measure("en directo, solo anfitrión", 0);

  const browser2 = await chromium.launch({
    headless: false, executablePath: process.env.CHROMIUM_PATH, env: { ...process.env, TMPDIR: "/tmp" },
    args: ["--headless=new", "--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", ...(process.env.BENCH_VIDEO ? [`--use-file-for-fake-video-capture=${process.env.BENCH_VIDEO}`] : [])],
  });
  browser = browser2;
  for (let i = 1; i <= guests; i++) {
    const name = `Invitado ${i}`;
    const inv = await (await post("/api/v1/invitations", {})).json();
    const ctx = await browser.newContext({ viewport: { width: 640, height: 480 } });
    const gp = await ctx.newPage();
    await gp.goto(inv.url.replace(/^https?:\/\/[^/]+/, origin));
    await gp.getByLabel("Tu nombre", { exact: true }).fill(name);
    await gp.getByRole("button", { name: "Entrar a la sala de espera" }).click();
    await gp.getByRole("heading", { name: "Ya estás en la sala de espera" }).waitFor();
    await page.locator(".waiting-list").getByRole("button", { name: "Admitir", exact: true }).first().click();
    await gp.getByRole("button", { name: "Conectar cámara y audio" }).click();
    await gp.locator(".connection.good").waitFor({ state: "attached", timeout: 30000 });
    await page.getByRole("button", { name: `Añadir ${name}`, exact: true }).click();
    await sleep(4000);
    await measure(`en directo, ${i} invitado${i > 1 ? "s" : ""} en pantalla`, i);
  }
  if (Number(process.env.BENCH_SOAK) > 0) await measure(`resistencia ${process.env.BENCH_SOAK}s con ${guests} invitados`, guests, Number(process.env.BENCH_SOAK));
  const studio = await (await page.request.get(`${origin}/api/v1/studio`)).json();
  assert((await post("/api/v1/broadcast/stop", {})).ok(), "stop");
  for (let i = 0; i < 120; i++) { const b = (await (await page.request.get(`${origin}/api/v1/studio`)).json()).broadcast; if (/complete|error/.test(b?.status)) break; await sleep(250); }
  const mp4 = join(rec, `${studio.broadcast.id}.mp4`);
  assert(existsSync(mp4), "sin MP4");
  const pr = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets,width,height:format=duration", "-of", "json", mp4]).toString());
  const dur = Number(pr.format.duration), pk = Number(pr.streams[0].nb_read_packets);
  const summary = { mp4_bytes: statSync(mp4).size, duracion_s: +dur.toFixed(1), fotogramas: pk, fps_reales: +(pk / dur).toFixed(1), resolucion: `${pr.streams[0].width}x${pr.streams[0].height}`, rtmp_bytes: existsSync(sinkFile) ? statSync(sinkFile).size : 0 };
  console.log("RESUMEN", JSON.stringify(summary));
  writeFileSync(join(work, "bench.json"), JSON.stringify({ rows, summary }, null, 2));
  console.log("resultados:", join(work, "bench.json"));
} catch (e) { failed = true; console.error("BENCH FALLÓ:", e.message); if (rows.length) writeFileSync(join(work, "bench-parcial.json"), JSON.stringify(rows, null, 2)); }
finally { await browser?.close().catch(() => {}); await app?.close().catch(() => {}); sink?.kill(); process.exit(failed ? 1 : 0); }
