// Fotogramas por segundo REALES que llegan al navegador por cámara y resolución (no los declarados).
import { _electron as electron } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "sh-fps-"));
const app = await electron.launch({
  executablePath: process.env.E2E_PACKAGED || join(root, "desktop/electron/node_modules/electron/dist/electron"),
  args: process.env.E2E_PACKAGED ? [] : [join(root, "desktop/electron")],
  env: { ...process.env, TMPDIR: "/tmp", STREAMHIVE_E2E: "1", STREAMHIVE_PORT: "8804", STREAMHIVE_LK_PORT: "7941", STREAMHIVE_RECORDINGS: join(work, "rec"), XDG_CONFIG_HOME: join(work, "config") },
  timeout: 60000,
});
try {
  await new Promise((res, rej) => { const t = setTimeout(() => rej(Error("sin READY")), 30000); app.process().stdout.on("data", (d) => { if (/STREAMHIVE_READY/.test(String(d))) { clearTimeout(t); res(); } }); });
  const page = await app.firstWindow();
  await page.getByRole("heading", { name: "Mi estudio" }).waitFor({ timeout: 20000 });
  const out = await page.evaluate(async () => {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput" && d.deviceId && d.deviceId !== "default");
    const res = [];
    for (const cam of cams) {
      const row = { nombre: cam.label, modos: {} };
      for (const [w, h] of [[640, 480], [1280, 720], [1920, 1080], [2560, 1440], [3840, 2160]]) {
        let s;
        try { s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: cam.deviceId }, width: { exact: w }, height: { exact: h }, frameRate: { ideal: 60 } } }); }
        catch (e) { row.modos[`${w}x${h}`] = `no (${e.name})`; continue; }
        const v = document.createElement("video"); v.muted = true; v.srcObject = s; await v.play();
        let n = 0; const t0 = performance.now(); let first = 0;
        await new Promise((done) => { const tick = (_, m) => { n++; if (!first) first = performance.now(); if (performance.now() - t0 < 4000) v.requestVideoFrameCallback(tick); else done(); }; v.requestVideoFrameCallback(tick); });
        const secs = (performance.now() - first) / 1000;
        row.modos[`${w}x${h}`] = `${(n / secs).toFixed(1)} fps reales (declara ${Math.round(s.getVideoTracks()[0].getSettings().frameRate)})`;
        s.getTracks().forEach((t) => t.stop()); v.srcObject = null;
        await new Promise((x) => setTimeout(x, 400));
      }
      res.push(row);
    }
    return res;
  });
  for (const c of out) { console.log(c.nombre); for (const [k, v] of Object.entries(c.modos)) console.log("   ", k, "->", v); }
} finally { await app.close().catch(() => {}); }
