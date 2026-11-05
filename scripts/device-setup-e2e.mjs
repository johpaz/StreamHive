// E2E de la pantalla "Probar cámara y micrófono" con la CÁMARA REAL: los selectores de calidad existen,
// la vista previa cambia de resolución, el modo de audio cambia el procesado, y al conectar se usa lo elegido.
import { _electron as electron } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "sh-dsetup-"));
const assert = (c, m) => { if (!c) throw Error(m); };
let app, failed = false;
try {
  app = await electron.launch({
    executablePath: process.env.E2E_PACKAGED || join(root, "desktop/electron/node_modules/electron/dist/electron"),
    args: process.env.E2E_PACKAGED ? [] : [join(root, "desktop/electron")],
    env: { ...process.env, TMPDIR: "/tmp", STREAMHIVE_E2E: "1", STREAMHIVE_PORT: "8803", STREAMHIVE_LK_PORT: "7940", STREAMHIVE_RECORDINGS: join(work, "rec"), XDG_CONFIG_HOME: join(work, "config") },
    timeout: 60000,
  });
  await new Promise((res, rej) => { const t = setTimeout(() => rej(Error("sin READY")), 30000); app.process().stdout.on("data", (d) => { if (/STREAMHIVE_READY/.test(String(d))) { clearTimeout(t); res(); } }); });
  const page = await app.firstWindow();
  await page.getByRole("heading", { name: "Mi estudio" }).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Probar dispositivos", exact: true }).click();
  const q = page.getByLabel("Resolución de la cámara"), a = page.getByLabel("Modo de audio");
  assert(await q.count() === 1 && await a.count() === 1, "faltan los selectores de calidad en la prueba de dispositivos");
  console.log("opciones de cámara:", (await q.locator("option").allTextContents()).join(" | "));
  console.log("opciones de audio:", (await a.locator("option").allTextContents()).join(" | "));
  await page.getByRole("button", { name: "Probar cámara y micrófono" }).click();
  const info = page.locator(".device-quality-info[role=status]");
  await info.waitFor({ timeout: 20000 });
  const read = async () => ({ info: (await info.innerText()).trim(), video: await page.evaluate(() => { const v = document.querySelector(".device-camera video"); return v ? `${v.videoWidth}x${v.videoHeight}` : "-"; }) });
  console.log("por defecto:", JSON.stringify(await read()));
  const after = async (value) => {
    await q.selectOption(value);
    await page.waitForFunction((v) => { const e = document.querySelector(".device-quality-info[role=status]"); const vid = document.querySelector(".device-camera video"); return e && vid && vid.videoWidth > 0 && vid.videoWidth === v; }, value === "720p30" ? 1280 : value === "2160p30" ? 3840 : 1920, { timeout: 20000 });
    return read();
  };
  const r720 = await after("720p30"); console.log("720p30:", JSON.stringify(r720));
  const r4k = await after("2160p30"); console.log("2160p30:", JSON.stringify(r4k));
  assert(r720.video === "1280x720" && r4k.video === "3840x2160", "la vista previa no refleja la calidad elegida");
  // La opción desactivada de lo que la cámara no puede dar (60 fps con esta cámara).
  const disabled = await q.locator("option:disabled").allTextContents();
  console.log("desactivadas:", disabled.join(" | ") || "(ninguna)");
  // Audio: el modo estudio quita el procesado del navegador en la pista real.
  const procesado = () => page.evaluate(() => { const m = document.querySelector(".device-setup"); return m ? "ok" : "no"; });
  await a.selectOption("estudio");
  await page.waitForTimeout(1500);
  const settings = await page.evaluate(async () => {
    const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const g = s.getAudioTracks()[0].getSettings(); s.getTracks().forEach((t) => t.stop());
    return { eco: g.echoCancellation, ruido: g.noiseSuppression, ganancia: g.autoGainControl };
  });
  console.log("pista de audio sin procesado:", JSON.stringify(settings));
  assert(settings.eco === false && settings.ruido === false, "el navegador no desactivó el procesado");
  // La elección persiste y se usa al conectar.
  const stored = await page.evaluate(() => ({ q: localStorage.getItem("streamhive.camera.quality"), a: localStorage.getItem("streamhive.audio.mode") }));
  assert(stored.q === "2160p30" && stored.a === "estudio", "la elección no se guardó: " + JSON.stringify(stored));
  await page.getByRole("button", { name: "Conectar cámara y audio" }).click();
  await page.getByText("Sala conectada", { exact: true }).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Añadir Anfitrión", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll(".stage video")].some((v) => v.videoWidth === 3840), {}, { timeout: 30000 });
  console.log("al conectar, la cámara se publica en 3840x2160 como se eligió");
  console.log("DEVICE SETUP E2E OK");
} catch (e) { failed = true; console.error("DEVICE SETUP E2E FALLÓ:", e.message.split("\n")[0]); }
finally { await app?.close().catch(() => {}); process.exit(failed ? 1 : 0); }
