// Microbenchmark: CPU del compositor según cómo se codifica el flujo intermedio (MediaRecorder) en este Electron.
import { _electron as electron } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "sh-mb-"));
const app = await electron.launch({ executablePath: process.env.E2E_PACKAGED, args: [], env: { ...process.env, TMPDIR: "/tmp", STREAMHIVE_E2E: "1", STREAMHIVE_PORT: "8809", STREAMHIVE_LK_PORT: "7947", STREAMHIVE_RECORDINGS: join(work, "rec"), XDG_CONFIG_HOME: join(work, "config") }, timeout: 60000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usage = (pid, s) => new Promise((res) => { let o = ""; const p = spawn("python3", [join(root, "scripts/proc-usage.py"), "--root", String(pid), "--seconds", String(s), "--detail"]); p.stdout.on("data", (d) => (o += d)); p.on("close", () => res(JSON.parse(o).procesos)); });
try {
  await new Promise((res, rej) => { const t = setTimeout(() => rej(Error("sin READY")), 30000); app.process().stdout.on("data", (d) => { if (/STREAMHIVE_READY/.test(String(d))) { clearTimeout(t); res(); } }); });
  const page = await app.firstWindow();
  await page.getByRole("heading", { name: "Mi estudio" }).waitFor({ timeout: 20000 });
  console.log("códecs que acepta MediaRecorder:", JSON.stringify(await page.evaluate(() => ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm;codecs=h264,opus", "video/webm;codecs=avc1,opus", "video/mp4;codecs=avc1,mp4a.40.2", "video/webm;codecs=av01,opus"].map((m) => [m, MediaRecorder.isTypeSupported(m)]))));
  const pid = app.process().pid;
  const cases = [["h264 8 Mb/s", "video/webm;codecs=h264,opus", 8e6], ["h264 16 Mb/s", "video/webm;codecs=h264,opus", 16e6], ["h264 30 Mb/s", "video/webm;codecs=h264,opus", 30e6], ["vp8 8 Mb/s (referencia)", "video/webm;codecs=vp8,opus", 8e6]];
  for (const [label, mime, bps] of cases) {
    if (mime && !(await page.evaluate((m) => MediaRecorder.isTypeSupported(m), mime))) { console.log(label.padEnd(26), "no soportado"); continue; }
    await page.evaluate(({ mime, bps }) => {
      const c = document.createElement("canvas"); c.width = 1920; c.height = 1080; c.id = "mb"; document.body.append(c);
      const x = c.getContext("2d"); let n = 0;
      window.__mbTimer = setInterval(() => { n++; for (let i = 0; i < 40; i++) { x.fillStyle = `hsl(${(n * 3 + i * 9) % 360},70%,50%)`; x.fillRect((i * 97 + n * 13) % 1800, (i * 53 + n * 7) % 1000, 220, 160); } x.fillStyle = "#fff"; x.font = "48px sans-serif"; x.fillText("frame " + n, 60, 90); }, 33);
      if (mime) { const s = c.captureStream(30); window.__rec = new MediaRecorder(s, { mimeType: mime, videoBitsPerSecond: bps }); window.__bytes = 0; window.__rec.ondataavailable = (e) => { window.__bytes += e.data.size; }; window.__rec.start(250); }
    }, { mime, bps });
    await sleep(2500);
    const rows = await usage(pid, 10);
    const bytes = await page.evaluate(() => { clearInterval(window.__mbTimer); window.__rec?.state === "recording" && window.__rec.stop(); document.getElementById("mb")?.remove(); return window.__bytes || 0; });
    const tot = rows.reduce((a, r) => a + r.nucleos, 0);
    console.log(label.padEnd(26), `${tot.toFixed(2)} núcleos en total`, mime ? `| salida real ≈ ${(bytes * 8 / 12.5 / 1e6).toFixed(1)} Mb/s` : "");
    await sleep(1000);
  }
} finally { await app.close().catch(() => {}); }
