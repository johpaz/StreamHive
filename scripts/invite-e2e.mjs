// The "Invitar personas" button picks a link guests can actually open:
// - desktop app on localhost without a sessions server: no localhost link, it asks to set the server up;
// - browser on localhost: a link marked as "only this device";
// - with the sessions server connected: the server's domain, creating the remote session if needed.
// The link is masked (domain + /join/•••) until "Mostrar".
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "sh-invite-e2e-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (ok, message) => { if (!ok) throw Error(message); };
const free = () => new Promise((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const children = [];
const start = (file, env) => { const p = spawn(file, [], { env: { ...process.env, ...env }, stdio: "ignore" }); children.push(p); return p; };
const ready = async (origin) => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`${origin}/healthz`)).ok) return; } catch {} await sleep(100); } throw Error(`${origin} did not start`); };
const bin = process.env.BIN_DIR || join(root, "target/debug");
let browser, success = false;
try {
  const [cloudPort, appPort] = await Promise.all([free(), free()]);
  const cloud = `http://localhost:${cloudPort}`, app = `http://localhost:${appPort}`;
  const pass = randomBytes(20).toString("hex");
  start(join(bin, "streamhive-sessions"), { PUBLIC_URL: cloud, LISTEN_ADDR: `127.0.0.1:${cloudPort}`, DATA_DIR: join(work, "cloud") });
  start(join(bin, "streamhive"), {
    ENGINE: "ffmpeg", DATA_DIR: join(work, "desktop"), RECORDINGS_DIR: join(work, "rec"), STATIC_DIR: join(root, "frontend/dist"),
    LISTEN_ADDR: `127.0.0.1:${appPort}`, PUBLIC_ORIGIN: app, RENDERER_URL: `${app}/render`, ADMIN_PASSWORD: pass,
    SESSION_SECRET: randomBytes(32).toString("hex"), MASTER_KEY: randomBytes(32).toString("base64"), LIVEKIT_INTERNAL_URL: "http://127.0.0.1:1",
  });
  await Promise.all([ready(cloud), ready(app)]);
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  const errors = [];
  const open = async (desktop) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"] });
    // Same shape as desktop/electron/preload.js; only its presence matters here.
    if (desktop) await ctx.addInitScript(() => { window.streamhiveDesktop = { openRenderer: async () => {}, closeRenderer: async () => {}, enter: async () => false }; });
    const page = await ctx.newPage(); page.setDefaultTimeout(15000);
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(app);
    await page.getByLabel("Contraseña de administrador").fill(pass);
    await page.getByRole("button", { name: "Abrir mi estudio" }).click();
    return page;
  };
  const banner = (page) => page.locator(".invite-banner");
  const link = (page) => page.getByLabel("Enlace de invitación");
  const localPosts = [];

  // 1. Browser on localhost: the link is created but marked as only for this device, masked.
  const web = await open(false);
  await web.getByRole("heading", { name: "Mi estudio" }).waitFor();
  web.on("request", (r) => { if (r.url().endsWith("/api/v1/invitations") && r.method() === "POST") localPosts.push(r.url()); });
  await web.getByRole("button", { name: "＋ Invitar personas" }).click();
  await banner(web).getByText("Enlace de prueba (solo este equipo)").waitFor();
  assert((await link(web).textContent()) === `${app}/join/•••••••`, "local link not masked: " + (await link(web).textContent()));
  await banner(web).getByRole("button", { name: "Mostrar" }).click();
  assert((await link(web).textContent()).startsWith(`${app}/join/`) && !(await link(web).textContent()).includes("•"), "Mostrar does not reveal the link");
  console.log("OK browser on localhost: test link, masked, Mostrar reveals it");

  // 2. Desktop app on localhost without a sessions server: no localhost link, it points to the setup.
  await web.request.put(`${app}/api/v1/profile`, { headers: { Origin: app }, data: { name: "Ana", studio: "", title: "Anfitriona" } });
  const desk = await open(true);
  await desk.getByRole("heading", { name: "Mi estudio" }).waitFor();
  const before = localPosts.length;
  desk.on("request", (r) => { if (r.url().endsWith("/api/v1/invitations") && r.method() === "POST") localPosts.push(r.url()); });
  await desk.getByRole("button", { name: "＋ Invitar personas" }).click();
  await banner(desk).getByText("Conecta tu servidor de sesiones para invitar").waitFor();
  assert(localPosts.length === before, "desktop created a localhost invitation");
  await banner(desk).getByRole("button", { name: "Configurar servidor" }).click();
  const panel = desk.getByRole("region", { name: "Servidor de sesiones", exact: true });
  await panel.waitFor();
  console.log("OK desktop without server: no localhost link, opens Servidor de sesiones");

  // 3. With the server connected (no remote session yet): the main button gives the server's link.
  await panel.getByLabel("URL del servidor VPS").fill(cloud);
  await panel.getByRole("button", { name: "Guardar y conectar", exact: true }).click();
  for (let i = 0; ; i++) {
    const r = await (await desk.request.get(`${app}/api/v1/remote-server`)).json();
    if (r.status === "connected") break;
    assert(i < 100, "server did not connect: " + JSON.stringify(r)); await sleep(200);
  }
  await desk.getByRole("button", { name: "Estudio en vivo" }).first().click();
  await desk.getByRole("button", { name: "＋ Invitar personas" }).click();
  await banner(desk).getByText(/Enlace de tu servidor de sesiones/).waitFor();
  assert((await link(desk).textContent()) === `${cloud}/join/•••••••`, "server link not masked: " + (await link(desk).textContent()));
  await banner(desk).getByRole("button", { name: "Copiar enlace" }).click();
  await banner(desk).getByText("Enlace copiado").waitFor();
  const url = await desk.evaluate(() => navigator.clipboard.readText());
  assert(url.startsWith(`${cloud}/join/`) && url.length > `${cloud}/join/`.length + 10, "copied link is not the server's: " + url);
  assert(localPosts.length === before, "a localhost invitation was created with the server connected");
  console.log("OK with the server: link of", cloud, "masked; Copiar gives the full link");

  // The copied link works: the guest reaches the server's waiting room and the host sees them.
  const guest = await (await browser.newContext()).newPage(); guest.setDefaultTimeout(15000);
  guest.on("pageerror", (e) => errors.push(e.message));
  await guest.goto(url);
  await guest.getByLabel("Tu nombre").fill("Invitada VPS");
  await guest.getByRole("button", { name: "Solicitar entrada" }).click();
  await guest.getByText("Esperando al anfitrión", { exact: true }).waitFor();
  await desk.getByRole("list", { name: "Invitados remotos" }).getByText("Invitada VPS").waitFor();
  console.log("OK the guest opens the link and the host sees them waiting");

  // A second invitation reuses the remote session that was created.
  const sessions = async () => (await (await desk.request.get(`${app}/api/v1/remote-server`)).json()).snapshot?.session?.id;
  const sid = await sessions();
  await banner(desk).getByRole("button", { name: "Cerrar invitación" }).click();
  await desk.getByRole("button", { name: "＋ Invitar personas" }).click();
  await banner(desk).getByText(/Enlace de tu servidor de sesiones/).waitFor();
  assert((await sessions()) === sid, "a second invitation opened another remote session");
  console.log("OK a second invitation reuses the remote session");
  assert(!errors.length, "page errors: " + errors.join("; "));
  success = true;
  console.log("INVITE E2E OK");
} finally {
  await browser?.close().catch(() => {});
  for (const p of children) try { p.kill("SIGKILL"); } catch {}
  if (!success) console.log("work dir:", work);
}
process.exit(success ? 0 : 1);
