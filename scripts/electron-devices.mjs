// Diagnóstico: ¿qué dispositivos ve la app Electron REAL (sin dispositivos falsos)? Uso: E2E_PACKAGED=<exe> bun scripts/electron-devices.mjs
import { _electron as electron } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "sh-dev-"));
const app = await electron.launch({
  executablePath: process.env.E2E_PACKAGED || join(root, "desktop/electron/node_modules/electron/dist/electron"),
  args: process.env.E2E_PACKAGED ? [] : [join(root, "desktop/electron")],
  env: { ...process.env, TMPDIR: "/tmp", STREAMHIVE_E2E: "1", STREAMHIVE_PORT: "8798", STREAMHIVE_LK_PORT: "7980", STREAMHIVE_RECORDINGS: join(work, "rec"), XDG_CONFIG_HOME: join(work, "config") },
  timeout: 60000,
});
try {
  await new Promise((res, rej) => { const t = setTimeout(() => rej(Error("sin READY")), 30000); app.process().stdout.on("data", (d) => { if (/STREAMHIVE_READY/.test(String(d))) { clearTimeout(t); res(); } }); });
  const page = await app.firstWindow();
  await page.getByRole("heading", { name: "Mi estudio" }).waitFor({ timeout: 20000 });
  const probe = () => page.evaluate(async () => {
    const list = async () => (await navigator.mediaDevices.enumerateDevices()).map((d) => `${d.kind}:${d.label || "(sin etiqueta)"}`);
    const out = { secure: isSecureContext, antes: await list() };
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }); out.gum = s.getTracks().map((t) => `${t.kind}:${t.label}`); s.getTracks().forEach((t) => t.stop()); } catch (e) { out.gumError = `${e.name}: ${e.message}`; }
    out.despues = await list();
    return out;
  });
  // Flujo real de la interfaz, sin dispositivos falsos ni "aceptar permisos" automático.
  await page.getByRole("button", { name: "Probar dispositivos", exact: true }).click();
  await page.getByRole("button", { name: "Probar cámara y micrófono" }).click();
  await page.waitForTimeout(4000);
  const ui = await page.evaluate(() => ({
    camaras: [...document.querySelectorAll('select[aria-label="Cámara de prueba"] option')].map((o) => o.textContent),
    microfonos: [...document.querySelectorAll('select[aria-label="Micrófono de prueba"] option')].map((o) => o.textContent),
    video: document.querySelector(".device-camera video")?.videoWidth || 0,
    texto: [...document.querySelectorAll(".device-setup, [class*=device]")].map((e) => e.innerText).join(" | ").replace(/\s+/g, " ").slice(0, 400),
  }));
  console.log("UI:", JSON.stringify(ui));
  await page.screenshot({ path: join(work, "ui.png") });
  console.log("captura:", join(work, "ui.png"));
} finally { await app.close().catch(() => {}); }
