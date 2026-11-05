// Diagnóstico de cámara real: capacidades, resoluciones que entrega de verdad y qué pide la app por defecto.
import { _electron as electron } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "sh-cam-"));
const app = await electron.launch({
  executablePath: process.env.E2E_PACKAGED || join(root, "desktop/electron/node_modules/electron/dist/electron"),
  args: process.env.E2E_PACKAGED ? [] : [join(root, "desktop/electron")],
  env: { ...process.env, TMPDIR: "/tmp", STREAMHIVE_E2E: "1", STREAMHIVE_PORT: "8801", STREAMHIVE_LK_PORT: "7995", STREAMHIVE_RECORDINGS: join(work, "rec"), XDG_CONFIG_HOME: join(work, "config") },
  timeout: 60000,
});
try {
  await new Promise((res, rej) => { const t = setTimeout(() => rej(Error("sin READY")), 30000); app.process().stdout.on("data", (d) => { if (/STREAMHIVE_READY/.test(String(d))) { clearTimeout(t); res(); } }); });
  const page = await app.firstWindow();
  await page.getByRole("heading", { name: "Mi estudio" }).waitFor({ timeout: 20000 });
  if (process.env.CAM_REVERSE) await page.evaluate(() => { window.__reverse = true; });
  const out = await page.evaluate(async () => {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput" && d.deviceId !== "default" && d.deviceId !== "");
    if (window.__reverse) cams.reverse();
    const res = [];
    for (const cam of cams) {
      const r = { nombre: cam.label };
      try {
        let s;
        for (let intento = 1; intento <= 3 && !s; intento++) {
          try { s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: cam.deviceId } } }); }
          catch (e) { r[`intento${intento}`] = `${e.name}: ${e.message}`; await new Promise((x) => setTimeout(x, 1500)); }
        }
        if (!s) throw new Error("no se pudo abrir tras 3 intentos");
        const t = s.getVideoTracks()[0];
        const cap = t.getCapabilities();
        r.capacidades = { w: [cap.width?.min, cap.width?.max], h: [cap.height?.min, cap.height?.max], fps: [cap.frameRate?.min, cap.frameRate?.max] };
        r.pordefecto = (({ width, height, frameRate }) => `${width}x${height}@${Math.round(frameRate)}`)(t.getSettings());
        r.escalera = {};
        for (const [w, h, f] of [[3840, 2160, 30], [2560, 1440, 30], [1920, 1080, 60], [1920, 1080, 30], [1280, 720, 60], [1280, 720, 30], [640, 480, 30]]) {
          try { await t.applyConstraints({ width: { exact: w }, height: { exact: h }, frameRate: { ideal: f } }); const g = t.getSettings(); r.escalera[`${w}x${h}@${f}`] = `${g.width}x${g.height}@${Math.round(g.frameRate)}`; }
          catch (e) { r.escalera[`${w}x${h}@${f}`] = `no (${e.name})`; }
        }
        s.getTracks().forEach((x) => x.stop());
      } catch (e) { r.error = `${e.name}: ${e.message}`; }
      res.push(r);
    }
    return res;
  });
  console.log(JSON.stringify(out, null, 1));
} finally { await app.close().catch(() => {}); }
