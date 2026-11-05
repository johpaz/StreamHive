// Coste (en Chromium) de sacar fotogramas SIN comprimir del canvas hacia otro proceso, frente a codificarlos con MediaRecorder.
import { _electron as electron } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "sh-raw-"));
let received = 0;
const server = Bun.serve({ port: 0, fetch(req, s) { return s.upgrade(req) ? undefined : new Response("ok"); }, websocket: { message(ws, m) { received += m.byteLength ?? m.length; }, open() {}, close() {} } });
const app = await electron.launch({ executablePath: process.env.E2E_PACKAGED, args: [], env: { ...process.env, TMPDIR: "/tmp", STREAMHIVE_E2E: "1", STREAMHIVE_PORT: "8812", STREAMHIVE_LK_PORT: "7950", STREAMHIVE_RECORDINGS: join(work, "rec"), XDG_CONFIG_HOME: join(work, "config") }, timeout: 60000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usage = (pid, s) => new Promise((res) => { let o = ""; const p = spawn("python3", [join(root, "scripts/proc-usage.py"), "--root", String(pid), "--seconds", String(s), "--detail"]); p.stdout.on("data", (d) => (o += d)); p.on("close", () => res(JSON.parse(o).procesos)); });
try {
  await new Promise((res, rej) => { const t = setTimeout(() => rej(Error("sin READY")), 30000); app.process().stdout.on("data", (d) => { if (/STREAMHIVE_READY/.test(String(d))) { clearTimeout(t); res(); } }); });
  const page = await app.firstWindow();
  await page.getByRole("heading", { name: "Mi estudio" }).waitFor({ timeout: 20000 });
  for (const format of ["NV12", "I420", "RGBA"]) {
    received = 0;
    const ok = await page.evaluate(async ({ port, format }) => {
      const c = document.createElement("canvas"); c.width = 1920; c.height = 1080; c.id = "rb"; document.body.append(c);
      const x = c.getContext("2d"); let n = 0;
      window.__draw = setInterval(() => { n++; for (let i = 0; i < 40; i++) { x.fillStyle = `hsl(${(n * 3 + i * 9) % 360},70%,50%)`; x.fillRect((i * 97 + n * 13) % 1800, (i * 53 + n * 7) % 1000, 220, 160); } }, 33);
      const ws = new WebSocket(`ws://127.0.0.1:${port}`); ws.binaryType = "arraybuffer"; await new Promise((r) => (ws.onopen = r)); window.__ws = ws;
      let buf; window.__frames = 0; window.__err = "";
      window.__send = setInterval(async () => {
        try { const f = new VideoFrame(c, { timestamp: performance.now() * 1000 }); buf ??= new Uint8Array(f.allocationSize({ format })); await f.copyTo(buf, { format }); f.close(); if (ws.bufferedAmount < 3e7) ws.send(buf); window.__frames++; }
        catch (e) { window.__err = String(e).slice(0, 80); }
      }, 33);
      await new Promise((r) => setTimeout(r, 1200));
      return !window.__err;
    }, { port: server.port, format });
    if (!ok) { console.log(format.padEnd(5), "no soportado:", await page.evaluate(() => window.__err)); await page.evaluate(() => { clearInterval(window.__draw); clearInterval(window.__send); document.getElementById("rb")?.remove(); }); continue; }
    await sleep(1500); received = 0;
    const rows = await usage(app.process().pid, 10);
    const mb = received / 10 / 1e6, fr = await page.evaluate(() => window.__frames);
    console.log(format.padEnd(5), `${rows.reduce((a, r) => a + r.nucleos, 0).toFixed(2)} núcleos en Electron | ${mb.toFixed(0)} MB/s enviados (${(mb / 3.11).toFixed(0)} fps equiv.)`);
    await page.evaluate(() => { clearInterval(window.__draw); clearInterval(window.__send); window.__ws.close(); document.getElementById("rb")?.remove(); });
    await sleep(800);
  }
} finally { await app.close().catch(() => {}); server.stop(true); }
