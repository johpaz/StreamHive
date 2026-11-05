// Every composition, 1 to 6 cameras and both formats, measured in the studio preview and in
// the real compositors, plus room and screen quotas with real buttons. Frames come from the MP4s.
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const work = process.env.E2E_OUT || mkdtempSync(join(tmpdir(), "sh-layouts-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (ok, message) => { if (!ok) throw Error(message); };
const free = () => new Promise((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const children = [];
const launch = (cmd, args, env = process.env) => { const p = spawn(cmd, args, { cwd: root, env, detached: true, stdio: "ignore" }); children.push(p); return p; };
const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";
let browser, success = false;
try {
  const [api, lk, tcp, udp, a, b] = await Promise.all(Array.from({ length: 6 }, free));
  const origin = `http://localhost:${api}`, pass = randomBytes(12).toString("hex"), secret = randomBytes(32).toString("hex");
  const config = join(work, "lk.yaml");
  writeFileSync(config, `port: ${lk}\nbind_addresses: [127.0.0.1]\nrtc:\n  tcp_port: ${tcp}\n  udp_port: ${udp}\n  use_external_ip: false\nkeys:\n  layouts: ${secret}\n`);
  launch(join(root, "runtime/bin/livekit-server"), ["--config", config, "--node-ip", "127.0.0.1"]);
  for (const [n, f] of [[a, "h.flv"], [b, "v.flv"]]) launch(ffmpeg, ["-v", "error", "-listen", "1", "-i", `rtmp://127.0.0.1:${n}/live/test`, "-c", "copy", "-y", join(work, f)]);
  launch(join(root, "target/release/streamhive"), [], {
    ...process.env, ENGINE: "ffmpeg", FFMPEG_BIN: ffmpeg, DATA_DIR: join(work, "data"), RECORDINGS_DIR: join(work, "rec"),
    LISTEN_ADDR: `127.0.0.1:${api}`, STATIC_DIR: join(root, "frontend/dist"), PUBLIC_ORIGIN: origin,
    RENDERER_URL: `${origin}/render`, LIVEKIT_INTERNAL_URL: `http://127.0.0.1:${lk}`, LIVEKIT_PUBLIC_URL: `ws://localhost:${lk}`,
    LIVEKIT_API_KEY: "layouts", LIVEKIT_API_SECRET: secret, ADMIN_PASSWORD: pass, SESSION_SECRET: secret, MASTER_KEY: randomBytes(32).toString("base64"),
  });
  for (let i = 0; ; i++) { try { if ((await fetch(`${origin}/healthz`)).ok) break; } catch {} assert(i < 100, "backend unavailable"); await sleep(100); }
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1400 } });
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  await page.getByLabel("Contraseña de administrador").fill(pass);
  await page.getByRole("button", { name: "Abrir mi estudio" }).click();
  await page.getByRole("heading", { name: "Mi estudio" }).waitFor();
  const request = async (path, data, method = "POST") => {
    const r = await page.request.fetch(`${origin}/api/v1${path}`, { method, headers: { Origin: origin }, data });
    assert(r.ok(), `${method} ${path}: ${await r.text()}`); return r.json();
  };
  const studio = () => page.request.get(`${origin}/api/v1/studio`).then((r) => r.json());

  // Quotas with the real controls: nobody is admitted or added above them.
  const deck = page.locator(".source-deck");
  await deck.getByLabel("Cupo de invitados en sala").selectOption("1");
  await deck.getByLabel("Cupo de cámaras en pantalla").selectOption("2");
  await page.getByText("En sala 0/1").first().waitFor();
  const { url } = await request("/invitations", {});
  const token = url.split("/join/")[1];
  const join_ = async (name) => (await (await fetch(`${origin}/api/v1/join`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ token, name }) })).json()).id;
  const ids = ["host"];
  for (const name of ["Ana", "Beto"]) ids.push(await join_(name));
  const waitingList = page.locator(".waiting-list");
  await waitingList.getByRole("button", { name: "Admitir" }).first().click();
  await page.getByText("En sala 1/1").first().waitFor();
  await waitingList.getByText("Cupo de 1 en sala completo").waitFor();
  assert(await waitingList.getByRole("button", { name: "Admitir" }).isDisabled(), "admit allowed above the room quota");
  assert((await studio()).participants.filter((p) => p.status === "waiting").length === 1, "the other guest must stay waiting");
  // Admitting never puts anyone on air.
  assert((await studio()).program.identities.length === 0, "admitting put someone on air");
  await deck.getByLabel("Cupo de invitados en sala").selectOption("5");
  await waitingList.getByRole("button", { name: "Admitir" }).click();
  await page.getByText("En sala 2/5").first().waitFor();
  const add = (name) => deck.getByRole("button", { name: `Añadir ${name}` });
  await add("Anfitrión").click(); await add("Ana").click();
  await page.getByText("En pantalla 2/2").first().waitFor();
  assert(await add("Beto").isDisabled(), "add allowed above the screen quota");
  console.log("OK quotas: room and screen stop at the limit; admitting does not go on air");
  await deck.getByLabel("Cupo de cámaras en pantalla").selectOption("6");
  await page.getByText("En pantalla 2/6").first().waitFor();
  for (const name of ["Carla", "Dani", "Eva"]) { const id = await join_(name); await request(`/participants/${id}`, { action: "admit" }); }
  const all = (await studio()).participants.filter((p) => p.status === "admitted").map((p) => p.id);
  ids.length = 1; ids.push(...all);
  assert(ids.length === 6, "expected six people");

  execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=0x3a5a8c:s=1280x720", "-frames:v", "1", "-y", join(work, "slide.png")]);
  const up = await page.request.post(`${origin}/api/v1/assets`, { headers: { Origin: origin, "Content-Type": "image/png", "X-File-Name": Buffer.from("Contenido").toString("base64") }, data: readFileSync(join(work, "slide.png")) });
  const asset = (await up.json()).id;
  const none = { screen: null, media_asset: null };
  const lead = ids[0];
  const compositions = [
    ["grid", { ...none, layout: "grid", spotlight: null }, (n) => n],
    ["spotlight", { ...none, layout: "spotlight", spotlight: lead }, () => 1],
    ["featured", { ...none, layout: "featured", spotlight: lead }, (n) => n],
    ["side", { layout: "screen", screen: null, media_asset: asset, content_mode: "side", spotlight: lead }, (n) => n],
    ["pip", { layout: "screen", screen: null, media_asset: asset, content_mode: "pip", spotlight: lead }, () => 1],
    ["full", { layout: "screen", screen: null, media_asset: asset, content_mode: "full", spotlight: lead }, () => 0],
  ];
  const measure = (stage) => stage.evaluate((el) => {
    const o = el.getBoundingClientRect();
    const rect = (t) => { const r = t.getBoundingClientRect(); return { l: (r.left - o.left) / o.width * 100, t: (r.top - o.top) / o.height * 100, r: (r.right - o.left) / o.width * 100, b: (r.bottom - o.top) / o.height * 100 }; };
    const grid = el.querySelector(".camera-grid");
    return { cams: [...el.querySelectorAll(".camera-tile")].map(rect), content: el.querySelector(".screen-area") ? rect(el.querySelector(".screen-area")) : null, grid: grid ? rect(grid) : null };
  });
  const check = (label, m, visible, mode) => {
    assert(m.cams.length === visible, `${label}: ${m.cams.length} cameras, expected ${visible}`);
    const eps = 0.3, boxes = [...m.cams, ...(m.content && mode !== "pip" ? [m.content] : [])];
    for (const c of boxes) assert(c.l >= -eps && c.t >= -eps && c.r <= 100 + eps && c.b <= 100 + eps, `${label}: out of the stage ${JSON.stringify(c)}`);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const [p, q] = [boxes[i], boxes[j]];
      assert(p.l >= q.r - eps || q.l >= p.r - eps || p.t >= q.b - eps || q.t >= p.b - eps, `${label}: overlap ${JSON.stringify([p, q])}`);
    }
    if (mode === "pip" && visible) assert(Math.abs(m.grid.b - m.grid.t - (m.cams[0].b - m.cams[0].t)) < 1.2, `${label}: bands around the floating camera ${JSON.stringify(m)}`);
  };
  const setProgram = async (format, patch, n) => {
    const s = await studio();
    await request(`/program?format=${format}`, { ...(format === "portrait" ? s.portrait_program : s.program), ...patch, identities: ids.slice(0, n) }, "PUT");
  };
  // The studio preview, one format at a time.
  const composition = page.locator(".scene-controls").getByLabel("Composición", { exact: true });
  for (const format of ["landscape", "portrait"]) {
    await composition.selectOption(format);
    const stage = page.locator(`.studio-preview .stage.format-${format}`); await stage.waitFor();
    for (const [name, patch, visible] of compositions) for (let n = 1; n <= 6; n++) {
      await setProgram(format, patch, n);
      for (let i = 0; i < 40 && (await stage.locator(".camera-tile").count()) !== visible(n); i++) await sleep(50);
      await sleep(120);
      check(`preview ${format} ${name} ${n}`, await measure(stage), visible(n), name);
      await stage.screenshot({ path: join(work, `${format}-${name}-${n}.png`) });
    }
  }
  console.log("OK preview: every composition with 1 to 6 cameras fits, no overlaps, no bands");
  // The voice notice tells when people are heard without being seen.
  await composition.selectOption("landscape");
  await setProgram("landscape", compositions[1][1], 6);
  await page.locator(".program-status").getByText("1 cámara visible · 6 voces al aire").waitFor();
  await setProgram("landscape", compositions[2][1], 3);
  await page.locator(".program-status").getByText("3 cámaras visibles · 3 voces al aire").waitFor();
  console.log("OK voice notice");

  // The real compositors: same measurements while broadcasting, and frames from the MP4s.
  for (const [name, n, format] of [["H", a, "landscape"], ["V", b, "portrait"]]) await request("/destinations", { platform: "custom", name, url: `rtmp://127.0.0.1:${n}/live`, key: "test", format });
  await request("/slates/start", { title: "Inicio", show_on_go_live: false }, "PUT");
  await request("/broadcast/start?record=true", {});
  for (let i = 0; i < 200; i++) { if ((await studio()).destinations.every((d) => d.status === "live")) break; await sleep(200); }
  assert((await studio()).destinations.every((d) => d.status === "live"), "outputs not live");
  const recordingStart = Date.now();
  const renderers = () => page.frames().filter((f) => f.url().includes("/render?"));
  assert(renderers().length === 2, "expected two compositors");
  const frameOf = (format) => renderers().find((f) => f.url().includes(`format=${format}`)) ?? renderers().find((f) => !f.url().includes("format=portrait"));
  const shots = [];
  for (const [name, patch, visible] of compositions) for (const n of name === "featured" || name === "side" ? [1, 2, 3, 5, 6] : [4]) {
    for (const format of ["landscape", "portrait"]) await setProgram(format, patch, n);
    for (const format of ["landscape", "portrait"]) {
      const f = frameOf(format), stage = f.locator(".stage");
      for (let i = 0; i < 60 && (await stage.locator(".camera-tile").count()) !== visible(n); i++) await sleep(50);
      await sleep(150);
      check(`compositor ${format} ${name} ${n}`, await measure(stage), visible(n), name);
    }
    shots.push({ name, n, at: (Date.now() - recordingStart) / 1000 });
    await sleep(2000);
  }
  console.log("OK compositors: every checked composition fits while broadcasting");
  const stoppedAt = Date.now();
  await request("/broadcast/stop?all=true", {});
  for (let i = 0; i < 100 && (await studio()).broadcast.status !== "complete"; i++) await sleep(200);
  assert((await studio()).broadcast.status === "complete", "session did not finish");
  await sleep(1000);
  const files = readdirSync(join(work, "rec")).filter((f) => f.endsWith(".mp4"));
  assert(files.length === 2, "expected two MP4s");
  for (const file of files) {
    const tag = file.includes("portrait") ? "mp4-portrait" : "mp4-landscape";
    // El archivo empieza antes que el reloj de la prueba: se alinea por su final.
    const total = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", join(work, "rec", file)]).toString());
    const offset = total - (stoppedAt - recordingStart) / 1000;
    for (const shot of shots.filter((s) => ["featured", "side", "pip"].includes(s.name)))
      execFileSync(ffmpeg, ["-v", "error", "-ss", String(shot.at + offset + 1.2), "-i", join(work, "rec", file), "-frames:v", "1", "-vf", "scale=-1:360", "-y", join(work, `${tag}-${shot.name}-${shot.n}.png`)]);
  }
  assert(!errors.length, "page errors: " + errors.join("; "));
  success = true;
  console.log("LAYOUTS E2E OK", work);
} finally {
  await browser?.close().catch(() => {});
  for (const p of children) { try { process.kill(-p.pid, "SIGKILL"); } catch {} }
  if (!success) console.log("work dir:", work);
}
process.exit(success ? 0 : 1);
