// ¿Puede el Chromium de la app usar la GPU para codificar/decodificar vídeo? Estado de la GPU + coste de CPU de MediaRecorder H.264.
// Uso: E2E_PACKAGED=<exe> CHR_FLAGS="--enable-features=..." bun scripts/chromium-hw-probe.mjs
import { _electron as electron } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "sh-hw-"));
const flags = (process.env.CHR_FLAGS || "").split(/\s+/).filter(Boolean);
const app = await electron.launch({ executablePath: process.env.E2E_PACKAGED, args: flags, env: { ...process.env, TMPDIR: "/tmp", STREAMHIVE_E2E: "1", STREAMHIVE_PORT: "8810", STREAMHIVE_LK_PORT: "7948", STREAMHIVE_RECORDINGS: join(work, "rec"), XDG_CONFIG_HOME: join(work, "config") }, timeout: 60000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usage = (pid, s) => new Promise((res) => { let o = ""; const p = spawn("python3", [join(root, "scripts/proc-usage.py"), "--root", String(pid), "--seconds", String(s), "--detail"]); p.stdout.on("data", (d) => (o += d)); p.on("close", () => res(JSON.parse(o).procesos)); });
try {
  await new Promise((res, rej) => { const t = setTimeout(() => rej(Error("sin READY")), 30000); app.process().stdout.on("data", (d) => { if (/STREAMHIVE_READY/.test(String(d))) { clearTimeout(t); res(); } }); });
  const page = await app.firstWindow();
  await page.getByRole("heading", { name: "Mi estudio" }).waitFor({ timeout: 20000 });
  const info = await app.evaluate(async ({ app }) => ({ chrome: process.versions.chrome, electron: process.versions.electron, gpu: app.getGPUFeatureStatus() }));
  console.log(`Chromium ${info.chrome} / Electron ${info.electron} | flags: ${flags.join(" ") || "(ninguno)"}`);
  console.log("estado GPU:", JSON.stringify(Object.fromEntries(Object.entries(info.gpu).filter(([k]) => /video|rasterization|canvas|webgl|gpu_comp/.test(k)))));
  const caps = await page.evaluate(async () => {
    const out = {};
    for (const [k, cfg] of Object.entries({ "H264 1080p": { codec: "avc1.640028", width: 1920, height: 1080, bitrate: 6e6, framerate: 30 }, "VP8 1080p": { codec: "vp8", width: 1920, height: 1080, bitrate: 6e6, framerate: 30 } })) {
      try { const hw = await VideoEncoder.isConfigSupported({ ...cfg, hardwareAcceleration: "prefer-hardware" }); const sw = await VideoEncoder.isConfigSupported({ ...cfg, hardwareAcceleration: "prefer-software" }); out[k] = { hw: hw.supported, sw: sw.supported }; } catch (e) { out[k] = "error " + e.message.slice(0, 40); }
    }
    for (const [k, cfg] of Object.entries({ "H264 dec": { codec: "avc1.640028", codedWidth: 1920, codedHeight: 1080 }, "VP8 dec": { codec: "vp8", codedWidth: 1920, codedHeight: 1080 }, "VP9 dec": { codec: "vp09.00.40.08", codedWidth: 1920, codedHeight: 1080 } })) {
      try { const hw = await VideoDecoder.isConfigSupported({ ...cfg, hardwareAcceleration: "prefer-hardware" }); out[k] = { hw: hw.supported }; } catch (e) { out[k] = "error"; }
    }
    return out;
  });
  console.log("WebCodecs:", JSON.stringify(caps));
  // Coste de CPU de MediaRecorder H.264 con un canvas animado (igual que el compositor)
  await page.evaluate(() => {
    const c = document.createElement("canvas"); c.width = 1920; c.height = 1080; c.id = "mb"; document.body.append(c);
    const x = c.getContext("2d"); let n = 0;
    window.__t = setInterval(() => { n++; for (let i = 0; i < 40; i++) { x.fillStyle = `hsl(${(n * 3 + i * 9) % 360},70%,50%)`; x.fillRect((i * 97 + n * 13) % 1800, (i * 53 + n * 7) % 1000, 220, 160); } }, 33);
    window.__rec = new MediaRecorder(c.captureStream(30), { mimeType: "video/webm;codecs=h264", videoBitsPerSecond: 16e6 }); window.__bytes = 0; window.__rec.ondataavailable = (e) => { window.__bytes += e.data.size; }; window.__rec.start(250);
  });
  await sleep(2500);
  const rows = await usage(app.process().pid, 10);
  const byType = {}; for (const r of rows) byType[r.tipo === "main/otro" ? r.comando : r.tipo] = (byType[r.tipo === "main/otro" ? r.comando : r.tipo] || 0) + r.nucleos;
  console.log("MediaRecorder H.264 1080p30:", rows.reduce((a, r) => a + r.nucleos, 0).toFixed(2), "núcleos en total |", Object.entries(byType).filter(([, v]) => v > 0.01).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", "));
} finally { await app.close().catch(() => {}); }
