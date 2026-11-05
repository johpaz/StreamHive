// A guest shares their screen through the real flow: joins, waits, is admitted, connects
// camera and audio, presses "Compartir pantalla"; the host sees it under Fuentes → Pantallas,
// puts it on the program and records. The screen must be in the MP4 frames.
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const work = process.env.E2E_OUT || mkdtempSync(join(tmpdir(), "sh-guest-screen-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (ok, message) => { if (!ok) throw Error(message); };
const free = () => new Promise((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const children = [];
const launch = (cmd, args, env = process.env) => { const p = spawn(cmd, args, { cwd: root, env, detached: true, stdio: "ignore" }); children.push(p); return p; };
const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";
// The guest's "screen": magenta with a moving white bar, so it is easy to find in a frame.
const fakeScreen = () => {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = Object.assign(document.createElement("canvas"), { width: 1280, height: 720 });
    const g = canvas.getContext("2d");
    const draw = () => {
      g.fillStyle = "#ff00ff"; g.fillRect(0, 0, 1280, 720);
      g.fillStyle = "#ffffff"; g.fillRect((performance.now() / 4) % 1280, 300, 80, 120);
    };
    draw(); setInterval(draw, 33);
    return canvas.captureStream(30);
  };
};
let browser, success = false;
try {
  const [api, lk, tcp, udp] = await Promise.all(Array.from({ length: 4 }, free));
  const origin = `http://localhost:${api}`, pass = randomBytes(12).toString("hex"), secret = randomBytes(32).toString("hex");
  const config = join(work, "lk.yaml");
  writeFileSync(config, `port: ${lk}\nbind_addresses: [127.0.0.1]\nrtc:\n  tcp_port: ${tcp}\n  udp_port: ${udp}\n  use_external_ip: false\nkeys:\n  screen: ${secret}\n`);
  launch(join(root, "runtime/bin/livekit-server"), ["--config", config, "--node-ip", "127.0.0.1"]);
  launch(join(root, "target/release/streamhive"), [], {
    ...process.env, ENGINE: "ffmpeg", FFMPEG_BIN: ffmpeg, DATA_DIR: join(work, "data"), RECORDINGS_DIR: join(work, "rec"),
    LISTEN_ADDR: `127.0.0.1:${api}`, STATIC_DIR: join(root, "frontend/dist"), PUBLIC_ORIGIN: origin,
    RENDERER_URL: `${origin}/render`, LIVEKIT_INTERNAL_URL: `http://127.0.0.1:${lk}`, LIVEKIT_PUBLIC_URL: `ws://localhost:${lk}`,
    LIVEKIT_API_KEY: "screen", LIVEKIT_API_SECRET: secret, ADMIN_PASSWORD: pass, SESSION_SECRET: secret, MASTER_KEY: randomBytes(32).toString("base64"),
  });
  for (let i = 0; ; i++) { try { if ((await fetch(`${origin}/healthz`)).ok) break; } catch {} assert(i < 100, "backend unavailable"); await sleep(100); }
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
  const studio = () => page.request.get(`${origin}/api/v1/studio`).then((r) => r.json());
  // The host sees guests' cameras and screens once connected to the room.
  await page.getByRole("button", { name: "Conectar cámara y audio" }).click();
  await page.locator(".connection.good").waitFor({ state: "attached" });
  const { url } = await (await page.request.post(`${origin}/api/v1/invitations`, { headers: { Origin: origin } })).json();

  const guestCtx = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ["camera", "microphone"] });
  await guestCtx.addInitScript(fakeScreen);
  const guest = await guestCtx.newPage(); guest.setDefaultTimeout(20000);
  guest.on("pageerror", (e) => errors.push("guest: " + e.message));
  await guest.goto(url);
  await guest.getByLabel("Tu nombre", { exact: true }).fill("Sara");
  await guest.getByRole("button", { name: "Entrar a la sala de espera" }).click();
  await guest.getByRole("heading", { name: "Ya estás en la sala de espera" }).waitFor();
  const guestId = (await (await guest.request.get(`${origin}/api/v1/me`)).json()).id;
  await page.locator(".waiting-list").getByRole("button", { name: "Admitir", exact: true }).click();
  await guest.getByRole("button", { name: "Conectar cámara y audio" }).click();
  await guest.locator(".connection.good").waitFor({ state: "attached" });
  const share = guest.getByRole("button", { name: "Compartir pantalla" });
  await share.click();
  await guest.getByRole("button", { name: "Dejar de compartir" }).waitFor();
  console.log("OK the guest shares the screen with the real button");

  // The host finds it under Fuentes → Pantallas and puts it on the program.
  await page.getByRole("tab", { name: /Pantallas/ }).click();
  const card = page.locator(".screen-source").filter({ hasText: "Pantalla de Sara" });
  await card.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll(".screen-source video")].some((v) => v.videoWidth > 0));
  await card.getByRole("button", { name: "Mostrar en programa" }).click();
  for (let i = 0; i < 50 && (await studio()).program.screen !== guestId; i++) await sleep(100);
  const program = (await studio()).program;
  assert(program.screen === guestId && program.layout === "screen", "screen not on the program: " + JSON.stringify(program));
  await page.waitForFunction(() => [...document.querySelectorAll(".studio-preview .screen-area video")].some((v) => v.videoWidth > 0));
  await page.locator(".studio-preview").screenshot({ path: join(work, "preview.png") });
  console.log("OK the host sees it in Pantallas and the preview");

  // Recording only: the guest's screen must be in the file.
  const started = await page.request.post(`${origin}/api/v1/recording/start`, { headers: { Origin: origin } });
  assert(started.ok(), "recording/start: " + (await started.text()));
  for (let i = 0; i < 150 && !(await studio()).broadcast?.recording?.status?.match?.(/recording|active|live/); i++) await sleep(200);
  await sleep(7000);
  await page.request.post(`${origin}/api/v1/broadcast/stop?all=true`, { headers: { Origin: origin } });
  for (let i = 0; i < 100 && (await studio()).broadcast?.status !== "complete"; i++) await sleep(200);
  await sleep(1000);
  const files = readdirSync(join(work, "rec")).filter((f) => f.endsWith(".mp4"));
  assert(files.length >= 1, "no MP4 recorded");
  const file = join(work, "rec", files[0]);
  const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString());
  execFileSync(ffmpeg, ["-v", "error", "-ss", String(Math.max(0, duration - 2)), "-i", file, "-frames:v", "1", "-y", join(work, "frame.png")]);
  const raw = execFileSync(ffmpeg, ["-v", "error", "-ss", String(Math.max(0, duration - 2)), "-i", file, "-frames:v", "1", "-vf", "scale=64:36", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  let magenta = 0;
  for (let i = 0; i < raw.length; i += 3) if (raw[i] > 190 && raw[i + 1] < 90 && raw[i + 2] > 190) magenta++;
  const share_ = magenta / (raw.length / 3);
  console.log(`frame: ${(share_ * 100).toFixed(1)}% of the image is the guest's screen (${join(work, "frame.png")})`);
  assert(share_ > 0.15, "the guest's screen is not in the recording");
  assert(!errors.length, "page errors: " + errors.join("; "));
  success = true;
  console.log("GUEST SCREEN E2E OK", work);
} finally {
  await browser?.close().catch(() => {});
  for (const p of children) { try { process.kill(-p.pid, "SIGKILL"); } catch {} }
  if (!success) console.log("work dir:", work);
}
process.exit(success ? 0 : 1);
