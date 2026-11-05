// Camera and audio through the sessions server (phase 2): the studio has NO local LiveKit.
// The host connects to the server's LiveKit, a guest invited by the server's link is admitted,
// publishes their camera and appears in Fuentes → Participantes; the host puts them on the program and
// records: the guest's camera must be in the MP4. Removing them from the studio removes them
// everywhere. The guest uses the real portal of the server: "Conectar cámara y audio" and
// "Compartir pantalla" (camera and screen are canvases, magenta and cyan, to find them in frames).
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "sh-remote-media-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (ok, message) => { if (!ok) throw Error(message); };
const free = () => new Promise((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const children = [];
const start = (file, args, env) => { const p = spawn(file, args, { cwd: root, env: { ...process.env, ...env }, detached: true, stdio: "ignore" }); children.push(p); return p; };
const ready = async (url) => { for (let i = 0; i < 150; i++) { try { if ((await fetch(url)).ok) return; } catch {} await sleep(100); } throw Error(`${url} did not start`); };
const bin = process.env.BIN_DIR || join(root, "target/debug");
const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";
// The guest's devices: a magenta camera (plus the fake microphone) and a cyan screen.
const fakeDevices = () => {
  const canvas = (color) => {
    const c = Object.assign(document.createElement("canvas"), { width: 640, height: 360 });
    const g = c.getContext("2d");
    const draw = () => { g.fillStyle = color; g.fillRect(0, 0, 640, 360); g.fillStyle = "#fff"; g.fillRect((performance.now() / 5) % 640, 150, 40, 60); };
    draw(); setInterval(draw, 33);
    return c.captureStream(30);
  };
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const stream = new MediaStream();
    if (constraints?.audio) for (const t of (await real({ audio: constraints.audio })).getAudioTracks()) stream.addTrack(t);
    if (constraints?.video) for (const t of canvas("#ff00ff").getVideoTracks()) stream.addTrack(t);
    return stream;
  };
  navigator.mediaDevices.getDisplayMedia = async () => canvas("#00ffff");
};
let browser, success = false;
try {
  const [cloudPort, lk, udp, tcp, api, dead] = await Promise.all(Array.from({ length: 6 }, free));
  const cloud = `http://localhost:${cloudPort}`, origin = `http://localhost:${api}`;
  const serverEnv = {
    PUBLIC_URL: cloud, LISTEN_ADDR: `127.0.0.1:${cloudPort}`, DATA_DIR: join(work, "cloud"),
    LIVEKIT_URL: `http://127.0.0.1:${lk}`, MEDIA_UDP_PORT: String(udp), MEDIA_TCP_PORT: String(tcp), MEDIA_PUBLIC_IP: "127.0.0.1",
  };
  execFileSync(join(bin, "streamhive-sessions"), ["migrate"], { env: { ...process.env, ...serverEnv }, stdio: "ignore" });
  start(join(root, "runtime/bin/livekit-server"), ["--config", join(work, "cloud/livekit.yaml")], {});
  start(join(bin, "streamhive-sessions"), [], serverEnv);
  const pass = randomBytes(12).toString("hex"), secret = randomBytes(32).toString("hex");
  start(join(bin, "streamhive"), [], {
    ENGINE: "ffmpeg", FFMPEG_BIN: ffmpeg, DATA_DIR: join(work, "desktop"), RECORDINGS_DIR: join(work, "rec"),
    LISTEN_ADDR: `127.0.0.1:${api}`, STATIC_DIR: join(root, "frontend/dist"), PUBLIC_ORIGIN: origin, RENDERER_URL: `${origin}/render`,
    // No local LiveKit at all: everything must go through the server.
    LIVEKIT_INTERNAL_URL: `http://127.0.0.1:${dead}`, LIVEKIT_PUBLIC_URL: `ws://127.0.0.1:${dead}`,
    LIVEKIT_API_KEY: "unused", LIVEKIT_API_SECRET: secret, ADMIN_PASSWORD: pass, SESSION_SECRET: secret, MASTER_KEY: randomBytes(32).toString("base64"),
  });
  await Promise.all([ready(`${cloud}/healthz`), ready(`${origin}/healthz`)]);
  for (let i = 0; !(await (await fetch(`${cloud}/api/v1/meta`)).json()).media_ready; i++) { assert(i < 100, "server LiveKit not ready"); await sleep(100); }

  browser = await chromium.launch({
    headless: true, executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  const errors = [];
  const host = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ["camera", "microphone"] });
  const page = await host.newPage(); page.setDefaultTimeout(20000);
  page.on("pageerror", (e) => errors.push("host: " + e.message));
  await page.goto(origin);
  await page.getByLabel("Contraseña de administrador").fill(pass);
  await page.getByRole("button", { name: "Abrir mi estudio" }).click();
  await page.getByRole("heading", { name: "Mi estudio" }).waitFor();
  const get = async (path) => { const r = await page.request.get(`${origin}/api/v1${path}`); const t = await r.text(); try { return JSON.parse(t); } catch { throw Error(`GET ${path}: ${r.status()} ${t.slice(0, 200)}`); } };
  const post = (path, data, method = "POST") => page.request.fetch(`${origin}/api/v1${path}`, { method, headers: { Origin: origin }, data });

  // 1. Configure the server: media detected and on by default.
  await page.getByRole("button", { name: /Configuración/ }).first().click();
  const panel = page.getByRole("region", { name: "Servidor de sesiones", exact: true });
  await panel.getByLabel("URL del servidor VPS").fill(cloud);
  await panel.getByRole("button", { name: "Guardar y conectar", exact: true }).click();
  for (let i = 0; ; i++) { const r = await get("/remote-server"); if (r.status === "connected" && r.media_active) break; assert(i < 100, "media not active: " + JSON.stringify(r)); await sleep(200); }
  await panel.getByText("Cámara y audio por el servidor").waitFor();
  assert(await panel.getByRole("checkbox", { name: /Usar el servidor para cámara y audio/ }).isChecked(), "toggle not on");
  const token = await (await post("/token", {})).json();
  assert(token.url === `ws://localhost:${cloudPort}/lk`, "studio token not from the server: " + token.url);
  console.log("OK the server has media: the studio uses it (", token.url, ")");

  // 2. The host connects their camera to the server's LiveKit.
  await page.getByRole("button", { name: "Estudio en vivo" }).first().click();
  await page.getByRole("button", { name: "Conectar cámara y audio" }).click();
  await page.locator(".connection.good").waitFor({ state: "attached" });
  assert((await get("/status")).livekit === true, "health: server room not reachable");
  console.log("OK host connected through the server");

  // 3. A guest with the server's link, admitted in "Invitados del servidor".
  const created = page.waitForResponse((r) => r.url().endsWith("/api/v1/remote-session/invitations") && r.request().method() === "POST");
  await page.getByRole("button", { name: "＋ Invitar personas" }).click();
  const invite = (await (await created).json()).url;
  assert(invite.startsWith(`${cloud}/join/`), "invitation not from the server");
  const guestCtx = await browser.newContext({ viewport: { width: 1000, height: 800 }, permissions: ["camera", "microphone"] });
  await guestCtx.addInitScript(fakeDevices);
  const guest = await guestCtx.newPage(); guest.setDefaultTimeout(20000);
  guest.on("pageerror", (e) => errors.push("guest: " + e.message));
  await guest.goto(invite);
  await guest.getByLabel("Tu nombre").fill("Sara");
  await guest.getByRole("button", { name: "Solicitar entrada" }).click();
  await guest.getByText("Esperando al anfitrión", { exact: true }).waitFor();
  const remotePanel = page.getByRole("region", { name: "Invitados del servidor" });
  await remotePanel.getByRole("list", { name: "Invitados remotos" }).locator("li").filter({ hasText: "Sara" }).getByRole("button", { name: "Admitir", exact: true }).click();
  await guest.getByText("Entrada aprobada", { exact: true }).waitFor();
  let guestId;
  for (let i = 0; !(guestId = (await get("/studio")).participants.find((p) => p.name === "Sara" && p.status === "admitted")?.id); i++) { assert(i < 50, "admitted guest not in the studio"); await sleep(100); }
  assert(guestId.startsWith("g-"), "guest id: " + guestId);
  console.log("OK admitted on the server → participant of the studio", guestId);

  // 4. With the portal's own buttons: camera, microphone and screen.
  const media = guest.getByRole("region", { name: "Tu cámara y audio" });
  await media.getByRole("button", { name: "Conectar cámara y audio" }).click();
  await media.getByRole("button", { name: "Apagar cámara" }).waitFor();
  await media.getByRole("button", { name: "Silenciar" }).waitFor();
  await guest.waitForFunction(() => [...document.querySelectorAll(".guest-tile video")].some((v) => v.videoWidth > 0));
  // The host's camera reaches the guest too.
  await guest.locator(".guest-tile").filter({ hasText: "Anfitrión" }).locator("video").waitFor();
  await guest.screenshot({ path: join(work, "portal.png") });
  await guest.setViewportSize({ width: 390, height: 844 });
  await guest.screenshot({ path: join(work, "portal-phone.png"), fullPage: true });
  await guest.setViewportSize({ width: 1000, height: 800 });
  for (let i = 0; !(await get("/studio")).participants.find((p) => p.id === guestId)?.connected; i++) { assert(i < 100, "guest never shown as connected"); await sleep(200); }
  await media.getByRole("button", { name: "Compartir pantalla" }).click();
  await media.getByRole("button", { name: "Dejar de compartir" }).waitFor();
  await page.getByRole("tab", { name: /Pantallas/ }).click();
  await page.locator(".screen-source").filter({ hasText: "Sara" }).waitFor();
  await media.getByRole("button", { name: "Dejar de compartir" }).click();
  await page.getByRole("tab", { name: /Participantes/ }).click();
  console.log("OK the guest connects camera, microphone and screen from the portal; the host sees the screen");

  // 5. In Fuentes → Participantes, on the program, and recorded.
  const deck = page.locator(".source-deck");
  await deck.getByRole("button", { name: "Añadir Sara" }).click();
  for (let i = 0; !(await get("/studio")).program.identities.includes(guestId); i++) { assert(i < 50, "guest not on the program"); await sleep(100); }
  await page.waitForFunction(() => [...document.querySelectorAll(".studio-preview video")].some((v) => v.videoWidth > 0));
  console.log("OK the guest appears in Personas and goes on the program");
  const started = await post("/recording/start", {});
  assert(started.ok(), "recording/start: " + (await started.text()));
  const toggle = await post("/remote-server/media", { enabled: false }, "PUT");
  assert(toggle.status() === 400, "media switched during a recording");
  await sleep(8000);
  await post("/broadcast/stop?all=true", {});
  for (let i = 0; i < 100 && (await get("/studio")).broadcast?.status !== "complete"; i++) await sleep(200);
  await sleep(1000);
  const file = join(work, "rec", readdirSync(join(work, "rec")).find((f) => f.endsWith(".mp4")));
  const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString());
  const at = String(Math.max(0, duration - 2));
  execFileSync(ffmpeg, ["-v", "error", "-ss", at, "-i", file, "-frames:v", "1", "-y", join(work, "frame.png")]);
  const raw = execFileSync(ffmpeg, ["-v", "error", "-ss", at, "-i", file, "-frames:v", "1", "-vf", "scale=64:36", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  let magenta = 0;
  for (let i = 0; i < raw.length; i += 3) if (raw[i] > 190 && raw[i + 1] < 90 && raw[i + 2] > 190) magenta++;
  const share = magenta / (raw.length / 3);
  console.log(`frame: ${(share * 100).toFixed(1)}% is the guest's camera (${join(work, "frame.png")})`);
  assert(share > 0.15, "the guest's camera is not in the recording");

  // 6. Removing them in the studio: out of the server, the room and the studio.
  const removed = await post(`/participants/${guestId}`, { action: "remove" });
  assert(removed.ok(), "remove: " + (await removed.text()));
  await guest.getByText("Tu entrada fue retirada").waitFor();
  await media.waitFor({ state: "detached" });
  assert(!(await get("/studio")).participants.some((p) => p.id === guestId), "still in the studio");
  const server = await get("/remote-server");
  assert(server.snapshot.participants.find((p) => `g-${p.id}` === guestId)?.status === "removed", "not removed on the server");
  console.log("OK removing in the studio removes them from the server and the room");
  assert(!errors.length, "page errors: " + errors.join("; "));
  success = true;
  console.log("REMOTE MEDIA E2E OK", work);
} finally {
  await browser?.close().catch(() => {});
  for (const p of children) { try { process.kill(-p.pid, "SIGKILL"); } catch {} }
  if (!success) console.log("work dir:", work);
}
process.exit(success ? 0 : 1);
