// Fotogramas por segundo REALES que entrega cada cámara al navegador (Chromium sin ventana, cámaras reales).
// Uso: CHROMIUM_PATH=<chrome> bun scripts/camera-fps.mjs
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: false, executablePath: process.env.CHROMIUM_PATH, env: { ...process.env, TMPDIR: "/tmp" }, args: ["--headless=new", "--no-sandbox"] });
try {
  const ctx = await browser.newContext({ permissions: ["camera"] });
  const page = await ctx.newPage();
  await page.route("http://localhost:1/", (r) => r.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }));
  await page.goto("http://localhost:1/");
  const out = await page.evaluate(async () => {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput" && d.deviceId && d.deviceId !== "default");
    const res = [];
    for (const cam of cams) {
      const row = { nombre: cam.label || cam.deviceId.slice(0, 8), modos: {} };
      for (const [w, h] of [[640, 480], [1280, 720], [1920, 1080], [2560, 1440], [3840, 2160]]) {
        let s;
        try { s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: cam.deviceId }, width: { exact: w }, height: { exact: h }, frameRate: { ideal: 60 } } }); }
        catch (e) { row.modos[`${w}x${h}`] = `no (${e.name})`; continue; }
        const v = document.createElement("video"); v.muted = true; v.srcObject = s; document.body.append(v); await v.play();
        let n = 0, first = 0, last = 0; const t0 = performance.now();
        await new Promise((done) => { const tick = () => { n++; last = performance.now(); if (!first) first = last; if (last - t0 < 5000) v.requestVideoFrameCallback(tick); else done(); }; v.requestVideoFrameCallback(tick); });
        row.modos[`${w}x${h}`] = `${((n - 1) / ((last - first) / 1000)).toFixed(1)} fps`;
        s.getTracks().forEach((t) => t.stop()); v.remove();
        await new Promise((x) => setTimeout(x, 500));
      }
      res.push(row);
    }
    return res;
  });
  for (const c of out) { console.log(c.nombre); for (const [k, v] of Object.entries(c.modos)) console.log("   ", k, "->", v); }
} finally { await browser.close(); }
