// Focus mode and start/pause/end slates, end to end: real buttons, two real compositors,
// local RTMP receivers and the resulting MP4s (timer frames, silent mic, audible music).
import { chromium } from "playwright";
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const work = process.env.E2E_OUT || mkdtempSync(join(tmpdir(), "sh-slates-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (ok, message) => { if (!ok) throw Error(message); };
const free = () => new Promise((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const children = [];
const launch = (cmd, args, env = process.env) => { const p = spawn(cmd, args, { cwd: root, env, detached: true, stdio: ["ignore", "ignore", "pipe"] }); children.push(p); return p; };
const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";
let browser, success = false;
try {
  const [api, lk, tcp, udp, a, b] = await Promise.all(Array.from({ length: 6 }, free));
  const origin = `http://localhost:${api}`, pass = randomBytes(12).toString("hex"), secret = randomBytes(32).toString("hex");
  const config = join(work, "lk.yaml");
  writeFileSync(config, `port: ${lk}\nbind_addresses: [127.0.0.1]\nrtc:\n  tcp_port: ${tcp}\n  udp_port: ${udp}\n  use_external_ip: false\nkeys:\n  slates: ${secret}\n`);
  launch(join(root, "runtime/bin/livekit-server"), ["--config", config, "--node-ip", "127.0.0.1"]);
  for (const [n, f] of [[a, "h.flv"], [b, "v.flv"]]) launch(ffmpeg, ["-v", "error", "-listen", "1", "-i", `rtmp://127.0.0.1:${n}/live/test`, "-c", "copy", "-y", join(work, f)]);
  launch(join(root, "target/release/streamhive"), [], {
    ...process.env, ENGINE: "ffmpeg", FFMPEG_BIN: ffmpeg, DATA_DIR: join(work, "data"), RECORDINGS_DIR: join(work, "rec"),
    LISTEN_ADDR: `127.0.0.1:${api}`, STATIC_DIR: join(root, "frontend/dist"), PUBLIC_ORIGIN: origin,
    RENDERER_URL: `${origin}/render`, LIVEKIT_INTERNAL_URL: `http://127.0.0.1:${lk}`, LIVEKIT_PUBLIC_URL: `ws://localhost:${lk}`,
    LIVEKIT_API_KEY: "slates", LIVEKIT_API_SECRET: secret, ADMIN_PASSWORD: pass, SESSION_SECRET: secret, MASTER_KEY: randomBytes(32).toString("base64"),
  });
  for (let i = 0; ; i++) { try { if ((await fetch(`${origin}/healthz`)).ok) break; } catch {} assert(i < 100, "backend unavailable"); await sleep(100); }
  const song = join(work, "song.mp3");
  execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=20", "-ac", "2", "-y", song]);
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage(); page.setDefaultTimeout(30000);
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  await page.getByLabel("Contraseña de administrador").fill(pass);
  await page.getByRole("button", { name: "Abrir mi estudio" }).click();
  await page.getByRole("heading", { name: "Mi estudio" }).waitFor();
  const request = async (path, body, method = "POST") => {
    const r = await page.request.fetch(`${origin}/api/v1${path}`, { method, headers: { Origin: origin }, data: body });
    assert(r.ok(), `${method} ${path}: ${await r.text()}`); return r.json();
  };
  const studio = () => page.request.get(`${origin}/api/v1/studio`).then((r) => r.json());
  const until = async (label, check, timeout = 45000) => {
    let s;
    for (const end = Date.now() + timeout; Date.now() < end;) { s = await studio(); if (await check(s)) return s; await sleep(200); }
    throw Error(`${label}: ${JSON.stringify({ b: s?.broadcast, d: s?.destinations, a: s?.active_slate })}`);
  };
  for (const [name, n, format] of [["Horizontal", a, "landscape"], ["Vertical", b, "portrait"]])
    await request("/destinations", { platform: "custom", name, url: `rtmp://127.0.0.1:${n}/live`, key: "test", format });

  // Sidebar folds to a rail and remembers it.
  const widthOf = (selector) => page.locator(selector).evaluate((el) => el.getBoundingClientRect().width);
  assert(await widthOf(".sidebar") > 150, "sidebar should start open");
  await page.getByRole("button", { name: "Plegar barra lateral" }).click();
  assert(await widthOf(".sidebar") < 70, "sidebar did not fold");
  await page.screenshot({ path: join(work, "sidebar-folded.png") });
  await page.reload(); await page.getByRole("heading", { name: "Mi estudio" }).waitFor();
  assert(await widthOf(".sidebar") < 70, "sidebar state not remembered");
  await page.getByRole("button", { name: "Abrir barra lateral" }).click();
  console.log("OK sidebar folds and remembers");

  // Configure the three slates with the real form.
  await page.getByRole("button", { name: /Configuración/ }).first().click();
  const editor = page.locator(".slates-editor");
  await editor.waitFor();
  const save = async () => {
    await editor.getByRole("button", { name: "Guardar pantalla" }).click();
    await editor.getByRole("button", { name: "Guardar pantalla" }).and(page.locator(":disabled")).waitFor();
  };
  await editor.getByRole("textbox", { name: "Título", exact: true }).fill("Arrancamos ya");
  await editor.getByLabel("Subtítulo").fill("Prueba de pantallas");
  await editor.getByLabel("Minutos").fill("0"); await editor.getByLabel("Segundos").fill("30");
  await editor.locator(".slate-preview .slate-timer").getByText("00:30").waitFor();
  await page.screenshot({ path: join(work, "editor.png"), fullPage: true });
  await save();
  await editor.getByRole("tab", { name: "Pausa" }).click();
  await editor.getByLabel("Minutos").fill("0"); await editor.getByLabel("Segundos").fill("4");
  await editor.getByLabel("Subir música").setInputFiles(song);
  await editor.getByRole("combobox", { name: "Música de fondo" }).locator("option", { hasText: "song" }).waitFor({ state: "attached" });
  assert(await editor.getByRole("combobox", { name: "Música de fondo" }).inputValue(), "uploaded song was not selected");
  await save();
  await editor.getByRole("tab", { name: "Fin" }).click();
  await editor.getByLabel("Segundos").fill("3");
  await editor.getByLabel("finalizar el directo y también la grabación").check();
  await save();
  const configured = (await studio()).slates;
  assert(configured.start.title === "Arrancamos ya" && configured.pause.music_asset && configured.end.auto_on_timer_end, "slates not saved");
  const songId = configured.pause.music_asset;
  const del = await page.request.delete(`${origin}/api/v1/assets/${songId}`, { headers: { Origin: origin } });
  assert(!del.ok(), "song in use could be deleted");
  console.log("OK slates configured from the form; music is protected");

  // Host on air with a real (fake-device) microphone and camera.
  await page.getByRole("button", { name: /Estudio en vivo/ }).click();
  await page.getByRole("button", { name: "Conectar cámara y audio" }).click();
  for (let i = 0; i < 100 && !(await page.locator(".studio-preview").count()); i++) await sleep(100);
  await sleep(2500);
  let state = await studio();
  await request("/program", { ...state.program, layout: "grid", identities: ["host"], microphones_enabled: true }, "PUT");
  state = await studio();
  await request("/program?format=portrait", { ...state.portrait_program, layout: "grid", identities: ["host"], microphones_enabled: true }, "PUT");
  await page.locator(".camera-tile").first().waitFor();
  assert(!(await page.locator(".app-shell.focus-mode").count()), "focus before the session");

  // Going live: focus opens by itself and Inicio is on air.
  const bar = page.locator(".workspace-broadcast-bar");
  await bar.getByRole("button", { name: "Iniciar directo", exact: true }).click();
  await page.locator(".app-shell.focus-mode").waitFor();
  state = await until("start slate", (s) => s.active_slate?.kind === "start");
  await until("both destinations live", (s) => s.destinations.every((d) => d.status === "live"));
  assert(!(await page.locator(".sidebar").isVisible()) && !(await page.locator(".topbar").isVisible()), "chrome still visible in focus");
  assert(await page.locator(".stage .slate-title").innerText() === "Arrancamos ya", "preview does not show the slate");
  assert(!(await page.locator(".stage .camera-tile").count()), "cameras under the slate");
  const renderers = () => page.frames().filter((f) => f.url().includes("/render?"));
  assert(renderers().length === 2, "expected two compositors");
  for (const frame of renderers()) {
    await frame.locator(".slate-title").waitFor();
    assert(!(await frame.locator(".camera-tile").count()) && !(await frame.locator("audio").count()), "program audio or cameras in compositor under slate");
  }
  await bar.getByRole("button", { name: "Grabar", exact: true }).click();
  const recordingClick = Date.now();
  await bar.getByRole("button", { name: "Detener grabación" }).waitFor();
  console.log("OK going live opens focus with Inicio in both formats");

  // Layout: the dock never covers the stage and nothing makes the page scroll.
  const layout = async (viewport) => {
    await page.setViewportSize(viewport);
    await sleep(300);
    const stage = await page.locator(".studio-preview .stage").boundingBox();
    const dock = await bar.boundingBox();
    const main = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, width: document.documentElement.scrollWidth }));
    assert(stage.y + stage.height <= dock.y, `dock covers stage at ${viewport.width}x${viewport.height}: ${JSON.stringify({ stage, dock })}`);
    assert(dock.y + dock.height <= viewport.height + 1, `dock off screen at ${viewport.width}x${viewport.height}: ${JSON.stringify(dock)}`);
    assert(main.height <= viewport.height + 1 && main.width <= viewport.width + 1, `page scrolls at ${viewport.width}x${viewport.height}: ${JSON.stringify(main)}`);
    await page.screenshot({ path: join(work, `focus-${viewport.width}.png`) });
    return stage;
  };
  const opened = await layout({ width: 1280, height: 720 });
  await layout({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Cerrar panel" }).click();
  const closed = await layout({ width: 1280, height: 720 });
  assert(closed.width >= opened.width, "closing the panel should not shrink the stage");
  await page.getByRole("button", { name: "Abrir panel" }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const [tab, text] of [["Fuentes", ".source-deck"], ["Ajustes", ".workspace-inspector"], ["Escenas", ".scene-compact"]]) {
    await page.locator(".focus-panel").getByRole("tab", { name: tab }).click();
    await page.locator(`.focus-panel ${text}`).waitFor();
    await page.screenshot({ path: join(work, `panel-${tab}.png`) });
  }
  console.log("OK focus layout at 1440x900 and 1280x720, panel opens and closes");

  // A person in the waiting room is always visible and reachable; guests learn they are off air.
  const { url } = await request("/invitations", {});
  const guestContext = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  const guest = await guestContext.newPage(); guest.setDefaultTimeout(30000);
  await guest.goto(url.replace(/^https?:\/\/[^/]+/, origin));
  await guest.getByLabel("Tu nombre").fill("Ana");
  await guest.getByRole("button", { name: /sala de espera/ }).click();
  await page.locator(".focus-waiting").waitFor();
  await page.screenshot({ path: join(work, "focus-waiting.png") });
  await page.locator(".focus-waiting").click();
  await page.locator(".focus-panel .waiting-list").getByRole("button", { name: "Admitir" }).click();
  await guest.getByText("ahora no estás al aire").waitFor();
  await guest.screenshot({ path: join(work, "guest-off-air.png") });
  await page.locator(".focus-panel").getByRole("tab", { name: "Escenas" }).click();
  console.log("OK waiting room reachable in focus; guest told they are off air");

  // Timeline in the recording. Start: timer advances and the microphone stays out.
  const marks = {};
  const timerAt = async (frame) => frame.locator(".slate-timer").innerText();
  const before = await timerAt(renderers()[0]);
  marks.startSlate = [Date.now()];
  await sleep(7000);
  marks.startSlate.push(Date.now());
  const after = await timerAt(renderers()[0]);
  assert(before !== after, `timer stuck: ${before}`);
  // Back to the program: camera and microphone return.
  assert((await bar.locator(".slate-return small").innerText()).includes("Conversación · 1 cámara"), "no notice of what comes back");
  await page.screenshot({ path: join(work, "focus-slate.png") });
  await bar.getByRole("button", { name: "Volver al programa" }).click();
  await until("slate hidden", (s) => !s.active_slate);
  await page.locator(".stage .camera-tile").first().waitFor();
  for (const frame of renderers()) { await frame.locator(".camera-tile").waitFor(); await frame.locator("audio").first().waitFor({ state: "attached" }); }
  marks.program = [Date.now()];
  await sleep(7000);
  marks.program.push(Date.now());
  await page.screenshot({ path: join(work, "focus-program.png") });
  // Pause: background music on air, manual at zero by default.
  await bar.getByRole("button", { name: "Pantalla de pausa" }).click();
  await until("pause", (s) => s.active_slate?.kind === "pause");
  for (const frame of renderers()) await frame.locator("audio.slate-music").waitFor({ state: "attached" });
  marks.music = [Date.now()];
  await sleep(7000);
  marks.music.push(Date.now());
  state = await studio();
  assert(state.active_slate?.kind === "pause", "manual slate left the air by itself at zero");
  await page.screenshot({ path: join(work, "focus-pause-zero.png") });
  await bar.getByRole("button", { name: "Volver al programa" }).click();
  await until("back", (s) => !s.active_slate);

  // Leaving focus lasts for this session, also after a reload; slate controls stay available.
  await page.getByRole("button", { name: "Salir del foco" }).click();
  await page.locator(".workspace-heading").waitFor();
  assert(await page.locator(".sidebar").isVisible(), "sidebar did not return");
  await page.reload();
  await page.getByRole("heading", { name: "Mi estudio" }).waitFor();
  await sleep(1000);
  assert(!(await page.locator(".app-shell.focus-mode").count()), "focus came back after leaving it");
  console.log("OK leaving focus lasts until the next session");
  await page.getByRole("button", { name: "Modo foco" }).click();
  await page.locator(".app-shell.focus-mode").waitFor();

  // End with automatic close: finishes live and recording, then focus closes.
  const stopping = Date.now();
  await bar.getByRole("button", { name: "Pantalla de fin" }).click();
  await until("automatic end", (s) => s.broadcast?.status === "complete", 60000);
  assert(Date.now() - stopping >= 2500, "automatic end did not wait for the timer");
  await until("slate cleared", (s) => !s.active_slate);
  await page.locator(".workspace-heading").waitFor();
  assert(!(await page.locator(".app-shell.focus-mode").count()), "focus should close with the session");
  console.log("OK automatic end closes the session, the slate and focus");
  const recordingEnd = stopping;

  // Inspect the recordings.
  await sleep(1500);
  const files = readdirSync(join(work, "rec")).filter((f) => f.endsWith(".mp4"));
  assert(files.length === 2, "expected two recordings: " + files);
  const landscape = join(work, "rec", files.find((f) => !f.includes("portrait")));
  const portrait = join(work, "rec", files.find((f) => f.includes("portrait")));
  const duration = (file) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString());
  const volume = (file, from, seconds) => {
    const out = spawnSync(ffmpeg, ["-hide_banner", "-ss", String(from), "-t", String(seconds), "-i", file, "-af", "volumedetect", "-vn", "-f", "null", "-"], { encoding: "utf8" }).stderr;
    return Number(/max_volume: (-?[\d.]+) dB/.exec(out)?.[1] ?? -120);
  };
  const frame = (file, at, name) => {
    const path = join(work, name);
    execFileSync(ffmpeg, ["-v", "error", "-ss", String(at), "-i", file, "-frames:v", "1", "-y", path]);
    return createHash("sha1").update(readFileSync(path)).digest("hex");
  };
  for (const [name, file] of [["landscape", landscape], ["portrait", portrait]]) {
    // Align wall clock with the file: it ends when the session ends.
    const total = duration(file);
    const wall = (Date.now() - recordingClick) / 1000;
    const at = (ms) => (ms - recordingClick) / 1000;
    const window = ([from, to]) => [at(from) + 2.5, Math.max(1, at(to) - at(from) - 3.5)];
    assert(total > wall - 15, `${name} recording too short: ${total} vs ${wall}`);
    const silent = volume(file, ...window(marks.startSlate));
    const voice = volume(file, ...window(marks.program));
    const music = volume(file, ...window(marks.music));
    console.log(`${name}: slate ${silent} dB, program ${voice} dB, music ${music} dB`);
    assert(silent < -60, `${name}: microphone on air during the slate (${silent} dB)`);
    assert(voice > -50, `${name}: microphone did not return (${voice} dB)`);
    assert(music > -40, `${name}: music not on air (${music} dB)`);
    const [from] = window(marks.startSlate);
    assert(frame(file, from, `${name}-timer-a.png`) !== frame(file, from + 3, `${name}-timer-b.png`), `${name}: timer frozen in the recording`);
    frame(file, window(marks.program)[0], `${name}-program.png`);
    frame(file, window(marks.music)[0], `${name}-pause.png`);
  }
  assert(recordingEnd > recordingClick, "clock");
  assert(!errors.length, "page errors: " + errors.join("; "));
  success = true;
  console.log("SLATES E2E OK", work);
} finally {
  await browser?.close().catch(() => {});
  for (const p of children) { try { process.kill(-p.pid, "SIGKILL"); } catch {} }
  if (!success) console.log("work dir:", work);
}
process.exit(success ? 0 : 1);
