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
  // Every capture track handed out, to check they all stop when the host removes the guest.
  const tracks = (window.__tracks = []);
  const keep = (stream) => { tracks.push(...stream.getTracks()); return stream; };
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  // Like a real browser before the permission: devices listed without their names.
  const list = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
  let granted = false;
  navigator.mediaDevices.enumerateDevices = async () =>
    (await list()).map((d) => (granted ? d : { kind: d.kind, deviceId: d.deviceId, groupId: d.groupId, label: "" }));
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    granted = true;
    const stream = new MediaStream();
    if (constraints?.audio) for (const t of (await real({ audio: constraints.audio })).getAudioTracks()) stream.addTrack(t);
    if (constraints?.video) for (const t of canvas("#ff00ff").getVideoTracks()) stream.addTrack(t);
    return keep(stream);
  };
  navigator.mediaDevices.getDisplayMedia = async () => keep(canvas("#00ffff"));
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
  // Without permissions granted in advance: like a real browser, device names start hidden.
  const guestCtx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  await guestCtx.addInitScript(fakeDevices);
  const guest = await guestCtx.newPage(); guest.setDefaultTimeout(20000);
  guest.on("pageerror", (e) => errors.push("guest: " + e.message));
  await guest.goto(invite);
  await guest.getByLabel("Tu nombre").fill("Sara");
  await guest.getByRole("button", { name: "Solicitar entrada" }).click();
  await guest.getByText("Esperando al anfitrión", { exact: true }).waitFor();
  // The host is told: alert with the name, and Sara in the studio's waiting list (like local guests).
  const alert = page.locator(".arrival-alert");
  await alert.getByText("Sara quiere entrar").waitFor();
  await page.locator(".waiting-list").getByText("Sara").waitFor();
  assert((await get("/studio")).participants.some((p) => p.name === "Sara" && p.status === "waiting" && p.id.startsWith("g-")), "server guest not waiting in the studio");
  await alert.getByRole("button", { name: "Admitir" }).click();
  await guest.locator(".guest-studio").waitFor();
  let guestId;
  for (let i = 0; !(guestId = (await get("/studio")).participants.find((p) => p.name === "Sara" && p.status === "admitted")?.id); i++) { assert(i < 50, "admitted guest not in the studio"); await sleep(100); }
  assert(guestId.startsWith("g-"), "guest id: " + guestId);
  console.log("OK alert + studio waiting list; admitted from the alert → participant of the studio", guestId);

  // 4. With the portal's own buttons: camera, microphone and screen.
  const media = guest.locator(".guest-studio");
  // The guest's studio: host status, the host's stage, the room and the chat docked beside.
  await media.getByText("Anfitrión conectado", { exact: true }).waitFor();
  await media.locator(".stage").waitFor();
  await media.locator(".gs-people").getByText(/Anfitrión|Host/).waitFor();
  assert(await media.locator(".studio-chat-docked .chat-window").isVisible(), "chat not docked in the guest studio");
  console.log("OK guest studio: host online, stage, room list and docked chat");
  const realNames = (select) => select.locator("option").evaluateAll((os) => os.map((o) => o.textContent.trim()).filter((t) => t && !/^(Micrófono|Cámara|Altavoz) \d+$|^Dispositivo predeterminado$|^Elige /.test(t)));
  await media.getByRole("button", { name: "Probar dispositivos" }).click();
  const testMic = media.getByLabel("Micrófono de prueba");
  for (let i = 0; !(await realNames(testMic)).length; i++) { assert(i < 50, "device test shows generic names: " + (await testMic.textContent())); await sleep(100); }
  console.log("OK device test shows real names:", (await realNames(testMic)).join(", "), "|", (await realNames(media.getByLabel("Cámara de prueba"))).join(", "));
  await media.getByRole("button", { name: "Cerrar prueba" }).click();
  await media.getByRole("button", { name: "Encender cámara y micrófono" }).click();
  await media.getByRole("button", { name: "Apagar cámara" }).waitFor();
  await media.getByRole("button", { name: "Dispositivos" }).click();
  const liveMic = media.locator(".guest-devices select").first();
  await liveMic.waitFor();
  assert((await realNames(liveMic)).length, "live device picker without names");
  console.log("OK device picker in the room:", await media.locator(".guest-devices label").allTextContents());
  await media.getByRole("button", { name: "Silenciar" }).waitFor();
  await guest.waitForFunction(() => [...document.querySelectorAll(".gs-self video")].some((v) => v.videoWidth > 0));
  await guest.screenshot({ path: join(work, "portal.png") });
  await guest.setViewportSize({ width: 390, height: 844 });
  await guest.screenshot({ path: join(work, "portal-phone.png"), fullPage: true });
  await guest.setViewportSize({ width: 1000, height: 800 });
  for (let i = 0; !(await get("/studio")).participants.find((p) => p.id === guestId)?.connected; i++) { assert(i < 100, "guest never shown as connected"); await sleep(200); }
  // Several reconcile rounds later (every 5 s) the guest is still in the room: the studio never
  // kicks server guests, the server authorizes them.
  await sleep(12000);
  assert((await get("/studio")).participants.find((p) => p.id === guestId)?.connected, "server guest kicked from the room");
  assert(await media.getByRole("button", { name: "Apagar cámara" }).isVisible(), "guest portal left the room");
  console.log("OK the guest stays in the room across reconcile rounds");
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
  // The guest sees the host's stage change: on the program, with their own camera in it.
  await media.getByText("Estás en el programa", { exact: true }).waitFor();
  await guest.waitForFunction(() => [...document.querySelectorAll(".guest-studio .stage video")].some((v) => v.videoWidth > 0));
  await guest.screenshot({ path: join(work, "guest-studio.png") });
  await guest.setViewportSize({ width: 390, height: 844 });
  await guest.screenshot({ path: join(work, "guest-studio-phone.png"), fullPage: true });
  await guest.setViewportSize({ width: 1000, height: 800 });
  console.log("OK the guest's stage follows the host's program");
  const started = await post("/recording/start", {});
  assert(started.ok(), "recording/start: " + (await started.text()));
  const toggle = await post("/remote-server/media", { enabled: false }, "PUT");
  assert(toggle.status() === 400, "media switched during a recording");
  // Someone arrives during the recording, in focus mode: alert visible, rejected from the studio.
  await page.locator(".app-shell.focus-mode").waitFor();
  const otherCtx = await browser.newContext();
  const other = await otherCtx.newPage(); other.setDefaultTimeout(20000);
  await other.goto(invite);
  await other.getByLabel("Tu nombre").fill("Beto");
  await other.getByRole("button", { name: "Solicitar entrada" }).click();
  await page.locator(".arrival-alert").getByText("Beto quiere entrar").waitFor();
  await page.screenshot({ path: join(work, "alert-focus.png") });
  await page.locator(".arrival-alert").getByRole("button", { name: "Ver" }).click();
  await page.getByRole("button", { name: "Rechazar Beto" }).click();
  await other.getByText("Solicitud rechazada", { exact: true }).waitFor();
  for (let i = 0; (await get("/studio")).participants.some((p) => p.name === "Beto"); i++) { assert(i < 50, "rejected guest still in the studio"); await sleep(100); }
  console.log("OK during the recording (focus mode): alert, Ver opens the waiting list, rejected on the server");
  await sleep(4000);
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

  // 6. Guests are temporary: when the session ends they all leave (camera and microphone off at
  // once), the lists empty and the old link stops working.
  await guest.getByText(/Tu entrada fue retirada|El anfitrión te sacó de la sala/).waitFor();
  await guest.waitForFunction(() => window.__tracks.length > 0 && window.__tracks.every((t) => t.readyState === "ended"));
  for (let i = 0; (await get("/studio")).participants.some((p) => p.id.startsWith("g-")); i++) { assert(i < 50, "server guests left in the studio after the session"); await sleep(100); }
  const ended = (await get("/remote-server")).snapshot;
  assert(!ended.participants.length && !ended.invitations.length, "server list not empty after the session: " + JSON.stringify(ended));
  if (await page.locator(".app-shell.focus-mode").count()) await page.getByRole("button", { name: "Salir del foco" }).click();
  const remoteList = page.getByRole("region", { name: "Invitados del servidor", exact: true });
  await remoteList.getByText("Nadie espera ni está en la sala.").waitFor();
  const lateCtx = await browser.newContext();
  const late = await lateCtx.newPage(); late.setDefaultTimeout(20000);
  const knock = async (p, link, name) => { await p.goto(link); await p.getByLabel("Tu nombre").fill(name); await p.getByRole("button", { name: "Solicitar entrada" }).click(); };
  await knock(late, invite, "Tarde");
  await late.getByRole("alert").getByText(/caducó o fue revocada/).waitFor();
  console.log("OK the session ended: everyone retired, tracks stopped, lists empty, old link dead");

  // 7. "Retirar" in "Invitados del servidor" takes one guest out and off the list.
  const fresh = (await (await post("/remote-session/invitations", {})).json()).url;
  const carlaCtx = await browser.newContext();
  const carla = await carlaCtx.newPage(); carla.setDefaultTimeout(20000);
  await knock(carla, fresh, "Carla");
  await remoteList.getByRole("listitem").filter({ hasText: "Carla" }).getByRole("button", { name: "Admitir", exact: true }).click();
  await carla.locator(".guest-studio").waitFor();
  await remoteList.getByRole("listitem").filter({ hasText: "Carla" }).getByRole("button", { name: "Retirar", exact: true }).click();
  await carla.getByText(/Tu entrada fue retirada|El anfitrión te sacó de la sala/).waitFor();
  await remoteList.getByText("Carla").waitFor({ state: "detached" });
  for (let i = 0; (await get("/studio")).participants.some((p) => p.name === "Carla"); i++) { assert(i < 20, "Carla still in the studio"); await sleep(100); }
  console.log("OK Retirar: out of the server, the room, the studio and the list");

  // 8. "Retirar a todos" in Fuentes → Participantes: whoever waits or is inside, and every link.
  const danCtx = await browser.newContext();
  const dan = await danCtx.newPage(); dan.setDefaultTimeout(20000);
  await knock(dan, fresh, "Dani");
  await dan.getByText("Esperando al anfitrión", { exact: true }).waitFor();
  await remoteList.getByText("Dani").waitFor();
  await page.getByRole("tab", { name: /Participantes/ }).click();
  page.once("dialog", (d) => { assert(/1 invitado/.test(d.message()), "confirm: " + d.message()); void d.accept(); });
  await page.locator(".source-deck").getByRole("button", { name: "Retirar a todos" }).click();
  await dan.getByText(/Tu entrada fue retirada|Solicitud rechazada/).waitFor();
  await remoteList.getByText("Nadie espera ni está en la sala.").waitFor();
  const emptied = (await get("/remote-server")).snapshot;
  assert(!emptied.participants.length && !emptied.invitations.length, "list not empty: " + JSON.stringify(emptied));
  assert(!(await get("/studio")).participants.length, "guests left in the studio");
  await page.screenshot({ path: join(work, "cleaned.png") });
  console.log("OK Retirar a todos: everyone out, lists empty, links revoked");
  assert(!errors.length, "page errors: " + errors.join("; "));
  success = true;
  console.log("REMOTE MEDIA E2E OK", work);
} finally {
  await browser?.close().catch(() => {});
  for (const p of children) { try { process.kill(-p.pid, "SIGKILL"); } catch {} }
  if (!success) console.log("work dir:", work);
}
process.exit(success ? 0 : 1);
