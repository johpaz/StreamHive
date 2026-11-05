// Ajustes de imagen que expone cada cámara al navegador (exposición, balance de blancos, brillo...). Solo lectura.
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: false, executablePath: process.env.CHROMIUM_PATH, env: { ...process.env, TMPDIR: "/tmp" }, args: ["--headless=new", "--no-sandbox"] });
try {
  const ctx = await browser.newContext({ permissions: ["camera"] });
  const page = await ctx.newPage();
  await page.route("http://localhost:1/", (r) => r.fulfill({ contentType: "text/html", body: "<html></html>" }));
  await page.goto("http://localhost:1/");
  const out = await page.evaluate(async () => {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput" && d.deviceId && d.deviceId !== "default");
    const res = [];
    for (const cam of cams) {
      const s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: cam.deviceId }, width: 1920, height: 1080 } });
      const t = s.getVideoTracks()[0], caps = t.getCapabilities(), set = t.getSettings();
      const keys = ["exposureMode", "exposureTime", "exposureCompensation", "whiteBalanceMode", "colorTemperature", "brightness", "contrast", "saturation", "sharpness", "focusMode", "zoom", "backlightCompensation"];
      res.push({ nombre: cam.label, ajustes: Object.fromEntries(keys.filter((k) => k in caps || k in set).map((k) => [k, { actual: set[k], opciones: Array.isArray(caps[k]) ? caps[k] : caps[k] && typeof caps[k] === "object" ? `${caps[k].min}..${caps[k].max}` : caps[k] }])) });
      s.getTracks().forEach((x) => x.stop());
      await new Promise((r) => setTimeout(r, 400));
    }
    return res;
  });
  for (const c of out) { console.log(c.nombre); for (const [k, v] of Object.entries(c.ajustes)) console.log(`   ${k.padEnd(22)} actual=${String(v.actual).padEnd(12)} opciones=${JSON.stringify(v.opciones)}`); }
} finally { await browser.close(); }
