// StreamHive Desktop (Electron). Arranca LiveKit + backend (ENGINE=ffmpeg) como procesos locales,
// abre el estudio y, durante un directo, una ventana oculta con el compositor.
// Todo escucha en localhost y los datos viven en el directorio de usuario: no hay nube.
const { app, BrowserWindow, ipcMain, session, desktopCapturer, dialog, shell, Menu } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const dgram = require("node:dgram");
const os = require("node:os");
const path = require("node:path");

// --version responde sin arrancar nada. El resto de la app va tras el bloqueo: dos instancias sobre el mismo
// directorio de datos pisarían livekit.yaml y compartirían la base SQLite. El bloqueo es por userData, así que
// las pruebas E2E (con su propio XDG_CONFIG_HOME) pueden convivir con la app abierta.
const versionOnly = process.argv.slice(1).some((arg) => arg === "--version" || arg === "-v");
const primary = !versionOnly && app.requestSingleInstanceLock();
if (versionOnly) console.log(app.getVersion());
if (!primary) app.exit(0);

let LIVEKIT_PORT = Number(process.env.STREAMHIVE_LK_PORT || 0);
const exe = process.platform === "win32" ? ".exe" : "";
const children = [];
const windowIcon = app.isPackaged
  ? path.join(process.resourcesPath, "icon.png")
  : path.join(__dirname, "build", "icon.png");
if (process.platform === "win32") app.setAppUserModelId("app.streamhive.desktop");
if (process.platform === "linux") {
  app.setDesktopName("streamhive-desktop.desktop");
  app.commandLine.appendSwitch("class", "streamhive-desktop");
}
let base = "", mainWindow = null, rendererWindows = new Map(), autologinToken = null, adminPassword = "", lanMode = false;

if (process.env.STREAMHIVE_FAKE_MEDIA) {
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
}
// Solo pruebas: vídeo sintético con movimiento real (y4m/mjpeg) en lugar del patrón por defecto.
if (process.env.STREAMHIVE_FAKE_MEDIA && process.env.STREAMHIVE_FAKE_VIDEO_FILE)
  app.commandLine.appendSwitch("use-file-for-fake-video-capture", process.env.STREAMHIVE_FAKE_VIDEO_FILE);
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const hex = (n) => crypto.randomBytes(n).toString("hex");
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on("error", reject);
  });
// Each desktop instance needs its own HTTP, RTC TCP and RTC UDP ports.
// Reserve all three together while checking to avoid conflicting with the web launcher.
async function mediaPort() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = await freePort();
    if (port > 65533) continue;
    const http = net.createServer(), tcp = net.createServer(), udp = dgram.createSocket("udp4");
    try {
      const results = await Promise.allSettled([
        new Promise((resolve, reject) => { http.once("error", reject); http.listen(port, "0.0.0.0", resolve); }),
        new Promise((resolve, reject) => { tcp.once("error", reject); tcp.listen(port + 1, "0.0.0.0", resolve); }),
        new Promise((resolve, reject) => { udp.once("error", reject); udp.bind(port + 2, "0.0.0.0", resolve); }),
      ]);
      if (results.some(result => result.status === "rejected")) continue;
      return port;
    } catch {
      // Try another triple; a configured explicit port is preserved separately.
    } finally {
      for (const server of [http, tcp]) if (server.listening) server.close();
      try { udp.close(); } catch {}
    }
  }
  throw Error("No se encontraron puertos libres para el motor multimedia");
}
const waitFor = async (port, tries = 150) => {
  for (let i = 0; i < tries; i++) {
    const ok = await new Promise((r) => { const c = net.connect(port, "127.0.0.1", () => { c.destroy(); r(true); }); c.on("error", () => r(false)); });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Puerto ${port} no disponible`);
};

/** Rutas de los binarios: empaquetado (resources/bin) o desarrollo (repo). */
function binaries() {
  const bundled = path.join(process.resourcesPath, "bin");
  if (app.isPackaged || fs.existsSync(path.join(bundled, `streamhive-backend${exe}`)))
    return { dir: bundled, backend: `streamhive-backend${exe}`, livekit: `livekit-server${exe}`, ffmpeg: `ffmpeg${exe}`, web: path.join(process.resourcesPath, "web") };
  const root = path.resolve(__dirname, "../..");
  return {
    dir: root, backend: path.join("target/release", `streamhive${exe}`), livekit: path.join("runtime/bin", `livekit-server${exe}`),
    ffmpeg: process.env.FFMPEG_BIN || "ffmpeg", web: path.join(root, "frontend/dist"),
  };
}

function secrets(dir) {
  const file = path.join(dir, "secrets.json");
  try { return { ...JSON.parse(fs.readFileSync(file, "utf8")), first: false }; } catch {}
  const s = { admin_password: hex(10), session_secret: hex(32), master_key: crypto.randomBytes(32).toString("base64"), livekit_key: "sh" + hex(6), livekit_secret: hex(32) };
  fs.writeFileSync(file, JSON.stringify(s), { mode: 0o600 });
  return { ...s, first: true };
}

function lanIp() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === "IPv4" && !i.internal) return i.address;
}

function launch(cmd, args, env, name) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let log = ""; const keep = (d) => { log = (log + d).slice(-4000); };
  p.stdout.on("data", keep); p.stderr.on("data", keep);
  p.on("exit", (code) => { if (!quitting && code) console.error(`[${name}] terminó con código ${code}\n${log}`); });
  p.log = () => log; children.push(p); return p;
}
let quitting = false;
const killAll = () => { quitting = true; for (const c of children) try { c.kill("SIGTERM"); } catch {} };

async function start() {
  if (!LIVEKIT_PORT) LIVEKIT_PORT = await mediaPort();
  const data = app.getPath("userData");
  const recordings = process.env.STREAMHIVE_RECORDINGS || path.join(app.getPath("videos"), "StreamHive");
  fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(recordings, { recursive: true });
  const sec = secrets(data);
  const bin = binaries();
  const apiPort = Number(process.env.STREAMHIVE_PORT || (await freePort()));
  base = `http://localhost:${apiPort}`;

  const lkConfig = path.join(data, "livekit.yaml");
  fs.writeFileSync(lkConfig, `port: ${LIVEKIT_PORT}\nbind_addresses:\n  - 127.0.0.1\nrtc:\n  tcp_port: ${LIVEKIT_PORT + 1}\n  udp_port: ${LIVEKIT_PORT + 2}\n  use_external_ip: false\nkeys:\n  ${sec.livekit_key}: ${sec.livekit_secret}\n`);
  launch(path.join(bin.dir, bin.livekit), ["--config", lkConfig, "--node-ip", process.env.STREAMHIVE_LAN === "1" && lanIp() ? lanIp() : "127.0.0.1"], {}, "livekit");

  const env = {
    ENGINE: "ffmpeg", FFMPEG_BIN: bin.ffmpeg.includes(path.sep) || path.isAbsolute(bin.ffmpeg) ? (path.isAbsolute(bin.ffmpeg) ? bin.ffmpeg : path.join(bin.dir, bin.ffmpeg)) : bin.ffmpeg,
    DATA_DIR: data, RECORDINGS_DIR: recordings, LISTEN_ADDR: `127.0.0.1:${apiPort}`, STATIC_DIR: bin.web,
    PUBLIC_ORIGIN: base, RENDERER_URL: `${base}/render`,
    LIVEKIT_INTERNAL_URL: `http://127.0.0.1:${LIVEKIT_PORT}`, LIVEKIT_PUBLIC_URL: "auto", // cuelga del origen del estudio (/lk), válido para localhost, LAN HTTPS y túneles
    LIVEKIT_API_KEY: sec.livekit_key, LIVEKIT_API_SECRET: sec.livekit_secret,
    STREAMHIVE_APP_PID: String(process.pid),
    ADMIN_PASSWORD: sec.admin_password, SESSION_SECRET: sec.session_secret, MASTER_KEY: sec.master_key,
  };
  // Opt-in: invitados desde la LAN. Sin HTTPS los navegadores no dan cámara/micro fuera de localhost.
  // El acceso desde la red va SOLO por HTTPS (CA propia en userData/tls); el HTTP plano sigue en localhost.
  lanMode = process.env.STREAMHIVE_LAN === "1" && Boolean(lanIp());
  if (lanMode) {
    const ip = lanIp(), tlsPort = Number(process.env.STREAMHIVE_TLS_PORT || 8443), lan = `https://${ip}:${tlsPort}`;
    Object.assign(env, { TLS_PORT: String(tlsPort), TLS_NAMES: `${ip},localhost,127.0.0.1`, EXTRA_ORIGINS: lan, INVITE_ORIGIN: lan });
  }
  // Entrada automática: solo en modo escritorio local. Con acceso LAN la contraseña sigue siendo obligatoria.
  autologinToken = lanMode ? null : hex(32);
  if (autologinToken) env.DESKTOP_AUTOLOGIN_TOKEN = autologinToken;
  adminPassword = sec.admin_password;
  const backend = launch(path.join(bin.dir, bin.backend), [], env, "backend");
  try { await waitFor(apiPort); } catch (e) { throw new Error(`${e.message}\n${backend.log()}`); }
  return { sec, apiPort };
}

/** Canjea el token por la sesión de administrador en la sesión de las ventanas de la app. */
async function enter() {
  if (!autologinToken) return false;
  try {
    const r = await session.defaultSession.fetch(`${base}/api/v1/desktop/enter?token=${autologinToken}`, { credentials: "include" });
    return r.status === 204;
  } catch { return false; }
}
function showPassword() {
  dialog.showMessageBox(mainWindow, { title: "StreamHive", message: "Contraseña de administrador", detail: `${adminPassword}\n\nSolo hace falta si abres el estudio desde otro navegador o equipo.` });
}

function openRenderer(rel) {
  const format = new URL(rel, base).searchParams.get("format") === "portrait" ? "portrait" : "landscape";
  const previous = rendererWindows.get(format);
  if (previous && !previous.isDestroyed()) return;
  const width = format === "portrait" ? 1080 : 1920, height = format === "portrait" ? 1920 : 1080;
  const rendererWindow = new BrowserWindow({
    width, height, show: false, frame: false, useContentSize: true, enableLargerThanScreen: true, paintWhenInitiallyHidden: true,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true },
  });
  rendererWindows.set(format, rendererWindow);
  rendererWindow.setContentSize(width, height);
  rendererWindow.webContents.setFrameRate(30);
  rendererWindow.on("closed", () => { rendererWindows.delete(format); });
  void rendererWindow.loadURL(base + rel);
}

app.on("second-instance", () => {
  if (!mainWindow || process.env.STREAMHIVE_E2E) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

if (primary) app.whenReady().then(async () => {
  const origin = (u) => { try { return new URL(u).origin; } catch { return ""; } };
  const trusted = (wc, url) => origin(url || wc.getURL()) === origin(base);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) =>
    cb(trusted(wc, details.requestingUrl) && ["media", "display-capture", "fullscreen", "clipboard-sanitized-write"].includes(permission)));
  session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin) => origin(requestingOrigin) === origin(base));
  // Compartir pantalla: selector del sistema (macOS/Windows) o la primera pantalla como respaldo.
  session.defaultSession.setDisplayMediaRequestHandler((req, cb) => {
    desktopCapturer.getSources({ types: ["screen", "window"] }).then((s) => cb(s[0] ? { video: s[0], audio: "loopback" } : {}), () => cb({}));
  }, { useSystemPicker: true });

  ipcMain.handle("renderer:open", (e, rel) => {
    if (typeof rel !== "string" || !rel.startsWith("/render?") || origin(e.senderFrame.url) !== origin(base)) return;
    openRenderer(rel + (process.env.STREAMHIVE_RENDER_PARAMS || ""));
  });
  ipcMain.handle("renderer:close", () => { for (const window of rendererWindows.values()) window.close(); });

  let ctx;
  try { ctx = await start(); } catch (e) { dialog.showErrorBox("StreamHive no pudo iniciar", String(e.message || e)); return app.quit(); }
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, title: "StreamHive", icon: windowIcon, backgroundColor: "#101923",
    // Las pruebas automáticas (STREAMHIVE_E2E) no deben abrir ventanas en la pantalla del usuario.
    show: !process.env.STREAMHIVE_E2E,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, backgroundThrottling: !process.env.STREAMHIVE_E2E },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { if (origin(url) !== origin(base)) void shell.openExternal(url); return { action: "deny" }; });
  await enter();
  setInterval(enter, 6 * 3600 * 1000).unref(); // la sesión dura 12 h: se renueva sin que el usuario haga nada
  void mainWindow.loadURL(base);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "StreamHive", submenu: [{ label: "Mostrar contraseña de administrador", click: showPassword }, { type: "separator" }, { role: "quit" }] },
    { label: "Edición", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "Ver", submenu: [{ role: "reload" }, { role: "togglefullscreen" }] },
  ]));
  // Con acceso LAN no hay entrada automática: se muestra la contraseña la primera vez.
  if (!autologinToken && ctx.sec.first && !process.env.STREAMHIVE_FAKE_MEDIA) showPassword();
  if (process.env.STREAMHIVE_E2E) console.log("STREAMHIVE_READY " + JSON.stringify({ base, password: ctx.sec.admin_password }));
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", killAll);
process.on("exit", killAll);
