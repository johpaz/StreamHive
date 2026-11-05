// Vista previa de "Probar cámara y micrófono" con CADA cámara real elegida en el selector: resolución recibida,
// tamaño con que se pinta y un fotograma nativo guardado para inspeccionarlo.
import { _electron as electron } from "playwright";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "sh-prev-"));
const app = await electron.launch({
  executablePath: process.env.E2E_PACKAGED || join(root, "desktop/electron/node_modules/electron/dist/electron"),
  args: process.env.E2E_PACKAGED ? [] : [join(root, "desktop/electron")],
  env: { ...process.env, TMPDIR: "/tmp", STREAMHIVE_E2E: "1", STREAMHIVE_PORT: "8805", STREAMHIVE_LK_PORT: "7942", STREAMHIVE_RECORDINGS: join(work, "rec"), XDG_CONFIG_HOME: join(work, "config") },
  timeout: 60000,
});
try {
  await new Promise((res, rej) => { const t = setTimeout(() => rej(Error("sin READY")), 30000); app.process().stdout.on("data", (d) => { if (/STREAMHIVE_READY/.test(String(d))) { clearTimeout(t); res(); } }); });
  const page = await app.firstWindow();
  await page.getByRole("heading", { name: "Mi estudio" }).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Probar dispositivos", exact: true }).click();
  const camSel = page.getByLabel("Cámara de prueba", { exact: true }), q = page.getByLabel("Resolución de la cámara");
  console.log("cámaras en el selector:", (await camSel.locator("option").allTextContents()).join(" | "));
  for (const camName of ["Live Cam", "Web Camera"]) {
    await camSel.selectOption({ label: camName });
    for (const [value, w] of [["720p30", 1280], ["1080p30", 1920], ["2160p30", 3840]]) {
      await q.selectOption(value);
      await page.getByRole("button", { name: /Probar cámara y micrófono|Comprobando/ }).first().click().catch(() => {});
      await page.waitForFunction((w) => { const v = document.querySelector(".device-camera video"); return v && v.videoWidth === w && v.readyState >= 2; }, w, { timeout: 25000 }).catch(() => {});
      await page.waitForTimeout(1200);
      const r = await page.evaluate(() => {
        const v = document.querySelector(".device-camera video"); const b = v.getBoundingClientRect();
        const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext("2d").drawImage(v, 0, 0);
        return { nativo: `${v.videoWidth}x${v.videoHeight}`, pintadoCSS: `${Math.round(b.width)}x${Math.round(b.height)}`, dpr: devicePixelRatio, objectFit: getComputedStyle(v).objectFit, png: c.toDataURL("image/png").split(",")[1], info: document.querySelector(".device-quality-info[role=status]")?.textContent };
      });
      const file = join(work, `${camName.replace(/\W/g, "")}_${value}.png`);
      writeFileSync(file, Buffer.from(r.png, "base64"));
      console.log(`${camName.padEnd(10)} ${value.padEnd(8)} nativo=${r.nativo} pintado=${r.pintadoCSS} (x${r.dpr}) ${r.info}`);
    }
  }
  console.log("fotogramas en:", work);
} finally { await app.close().catch(() => {}); }
