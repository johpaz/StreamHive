// E2E del acceso de invitados por la red local con HTTPS propio (STREAMHIVE_LAN=1) en la app Electron real.
// Comprueba: contexto seguro, señalización por /lk sobre wss, media por la IP de la LAN, y que la CA
// descargada en /ca.pem es la que da confianza al certificado (conexión TLS verificada, sin ignorar errores).
// El navegador del invitado usa ignoreHTTPSErrors solo porque no puede instalar la CA en el sistema.
import { _electron as electron, chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import tls from "node:tls";

const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "sh-lan-"));
const ip = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
if (!ip) throw Error("Sin IP de LAN");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw Error(m); };
const tlsPort = 8447, apiPort = 8797;
let app, browser, failed = false;
const logs = [];
try {
  app = await electron.launch({
    executablePath: process.env.E2E_PACKAGED || join(root, "desktop/electron/node_modules/electron/dist/electron"),
    args: process.env.E2E_PACKAGED ? ["--no-sandbox"] : ["--no-sandbox", join(root, "desktop/electron")],
    env: { ...process.env, TMPDIR: "/tmp", STREAMHIVE_FAKE_MEDIA: "1", STREAMHIVE_E2E: "1", STREAMHIVE_LAN: "1", STREAMHIVE_PORT: String(apiPort), STREAMHIVE_TLS_PORT: String(tlsPort), STREAMHIVE_LK_PORT: "7970", STREAMHIVE_RECORDINGS: join(work, "rec"), XDG_CONFIG_HOME: join(work, "config") },
    timeout: 60000,
  });
  const info = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(Error("sin STREAMHIVE_READY")), 30000);
    app.process().stdout.on("data", (d) => { const m = String(d).match(/STREAMHIVE_READY (.*)/); if (m) { clearTimeout(t); res(JSON.parse(m[1])); } });
  });
  const page = await app.firstWindow();
  const origin = info.base; // http://localhost: la ventana del anfitrión sigue en local
  // En modo LAN no hay entrada automática: debe pedir la contraseña.
  await page.getByLabel("Contraseña de administrador").fill(info.password);
  await page.getByRole("button", { name: "Abrir mi estudio" }).click();
  await page.getByRole("heading", { name: "Mi estudio" }).waitFor();
  await page.getByRole("button", { name: "Probar dispositivos", exact: true }).click();
  await page.getByRole("button", { name: "Probar cámara y micrófono" }).click();
  await page.getByText("Micrófono activo · habla para comprobar el nivel").waitFor();
  await page.getByRole("button", { name: "Conectar cámara y audio" }).click();
  await page.getByText("Sala conectada", { exact: true }).waitFor({ timeout: 20000 });
  const post = (path, data) => page.request.fetch(`${origin}${path}`, { method: "POST", headers: { Origin: origin }, data });
  const inv = await (await post("/api/v1/invitations", {})).json();
  console.log("invitación:", inv.url.replace(/join\/.*/, "join/…"), "| CA:", inv.ca_url);
  assert(inv.url.startsWith(`https://${ip}:${tlsPort}/join/`), "la invitación no apunta al HTTPS de la LAN");
  assert(inv.ca_url === `https://${ip}:${tlsPort}/ca.pem`, "falta el enlace de la CA");

  // 1) La CA descargada valida de verdad el certificado del servidor (lo que hará el dispositivo del invitado).
  const ca = await new Promise((res, rej) => {
    const c = tls.connect({ host: ip, port: tlsPort, rejectUnauthorized: false }, () => { c.write(`GET /ca.pem HTTP/1.0\r\nHost: ${ip}\r\n\r\n`); });
    let b = ""; c.on("data", (d) => (b += d)); c.on("end", () => res(b.split("\r\n\r\n")[1])); c.on("error", rej);
  });
  assert(ca.includes("BEGIN CERTIFICATE"), "ca.pem no es un certificado");
  await new Promise((res, rej) => {
    const s = tls.connect({ host: ip, port: tlsPort, ca }, () => { console.log("TLS verificado con la CA descargada, sujeto:", s.getPeerCertificate().subject?.CN); s.end(); res(); });
    s.on("error", rej);
  });
  await new Promise((res, rej) => {
    const s = tls.connect({ host: ip, port: tlsPort }, () => { s.end(); rej(Error("el certificado se aceptó sin la CA")); });
    s.on("error", (e) => { console.log("sin la CA, el sistema lo rechaza:", e.code); res(); });
  });

  // 2) Invitado por HTTPS en la LAN: cámara, wss por /lk y media.
  browser = await chromium.launch({
    headless: false, executablePath: process.env.CHROMIUM_PATH, env: { ...process.env, TMPDIR: "/tmp" },
    args: ["--headless=new", "--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 640, height: 480 } });
  const gp = await ctx.newPage();
  const errors = []; gp.on("pageerror", (e) => errors.push(e.message));
  gp.on("console", (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 200)}`));
  gp.on("requestfailed", (r) => logs.push(`[requestfailed] ${r.url().slice(0, 120)} ${r.failure()?.errorText}`));
  const wsUrls = []; gp.on("websocket", (w) => wsUrls.push(w.url().replace(/\?.*/, "")));
  await gp.goto(inv.url);
  assert(await gp.evaluate(() => isSecureContext), "el invitado no está en contexto seguro");
  await gp.getByLabel("Tu nombre", { exact: true }).fill("Invitada LAN");
  await gp.getByRole("button", { name: "Entrar a la sala de espera" }).click();
  await gp.getByRole("heading", { name: "Ya estás en la sala de espera" }).waitFor();
  await page.locator(".waiting-list").getByRole("button", { name: "Admitir", exact: true }).first().click();
  await gp.getByRole("button", { name: "Conectar cámara y audio" }).click();
  await gp.locator(".connection.good").waitFor({ state: "attached", timeout: 30000 });
  console.log("websockets del invitado:", [...new Set(wsUrls)].join(", "));
  assert(wsUrls.some((u) => u.startsWith(`wss://${ip}:${tlsPort}/lk/rtc`)), "la señalización no fue por wss://…/lk/rtc");
  await page.getByRole("button", { name: "Añadir Invitada LAN", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll(".stage video")].some((v) => v.videoWidth > 0), {}, { timeout: 30000 });
  console.log("el anfitrión recibe el vídeo del invitado por la LAN");
  // 3) La ruta /lk no expone nada más que la señalización.
  const bad = await fetch(`http://localhost:${apiPort}/lk/twirp/livekit.RoomService/ListRooms`);
  assert(bad.status === 404, "el proxy expone rutas de la API de LiveKit");
  // 4) El HTTP plano no es accesible desde la LAN (solo localhost).
  const lanPlain = await fetch(`http://${ip}:${apiPort}/healthz`, { signal: AbortSignal.timeout(3000) }).then(() => true, () => false);
  assert(!lanPlain, "el HTTP sin cifrar está abierto en la LAN");
  if (errors.length) console.log("errores de página:", errors.slice(0, 3));
  console.log("LAN HTTPS E2E OK");
} catch (e) { failed = true; console.error("LAN E2E FALLÓ:", e.message.split("\n")[0]); console.error(logs.filter((l) => /ice|ICE|candidate|fail|disconnect|error|timeout|transport|dtls|publish/i.test(l)).slice(-14).join("\n")); }
finally { await browser?.close().catch(() => {}); await app?.close().catch(() => {}); process.exit(failed ? 1 : 0); }
