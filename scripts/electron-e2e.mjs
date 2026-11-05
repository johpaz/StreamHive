// E2E de la app Electron REAL (Playwright _electron): arranca sidecars, entra al estudio,
// conecta cámara sintética, emite a un RTMP local, y verifica MP4 + RTMP con ffprobe.
// Uso: bun scripts/electron-e2e.mjs [E2E_SECONDS]   (requiere desktop/electron/node_modules, target/release/streamhive)
import { _electron as electron } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "sh-el-"));
const seconds = Number(process.argv[2] || process.env.E2E_SECONDS || 12);
const rtmpPort = 19351, apiPort = 8793, lkPort = 7930;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw Error(m); };
let app, sink, failed = false;
try {
  const sinkFile = join(work, "sink.flv");
  sink = spawn("ffmpeg", ["-v", "error", "-listen", "1", "-i", `rtmp://127.0.0.1:${rtmpPort}/live/key`, "-c", "copy", "-y", sinkFile], { stdio: "ignore" });
  const rec = join(work, "rec");
  app = await electron.launch({
    // E2E_PACKAGED=/ruta/al/ejecutable prueba la app empaquetada (sidecars de resources/bin).
    executablePath: process.env.E2E_PACKAGED || join(root, "desktop/electron/node_modules/electron/dist/electron"),
    args: process.env.E2E_PACKAGED ? ["--no-sandbox"] : ["--no-sandbox", join(root, "desktop/electron")],
    env: { ...process.env, TMPDIR: "/tmp", STREAMHIVE_FAKE_MEDIA: "1", STREAMHIVE_E2E: "1", STREAMHIVE_PORT: String(apiPort), STREAMHIVE_LK_PORT: process.env.E2E_RANDOM_PORTS ? "" : String(lkPort), STREAMHIVE_RECORDINGS: rec, XDG_CONFIG_HOME: join(work, "config") },
    timeout: 60000,
  });
  const info = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(Error("sin STREAMHIVE_READY")), 30000);
    app.process().stdout.on("data", (d) => { const m = String(d).match(/STREAMHIVE_READY (.*)/); if (m) { clearTimeout(t); res(JSON.parse(m[1])); } });
  });
  const page = await app.firstWindow();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  const origin = info.base;
  // Entrada automática: no debe aparecer ninguna pantalla de contraseña, sino la bienvenida.
  await page.getByRole("heading", { name: "Hola, empecemos." }).waitFor({ timeout: 20000 });
  assert((await page.getByLabel("Contraseña de administrador").count()) === 0, "apareció la pantalla de contraseña");
  // La clave de la app ya existe y es la misma que muestra el menú.
  await page.getByRole("button", { name: "Mostrar" }).click();
  const key = (await page.getByLabel("Clave de acceso de esta app").textContent()).trim();
  assert(key === info.password, "la bienvenida no muestra la clave de esta app");
  await page.getByLabel("Tu nombre").fill("Johana Prueba");
  await page.getByLabel("Nombre del estudio, programa o canal").fill("La Colmena");
  await page.getByRole("button", { name: "Abrir mi estudio →" }).click();
  await page.getByRole("heading", { name: "Mi estudio" }).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: /Tu perfil: Johana Prueba/ }).waitFor();
  // El botón del perfil no cierra la sesión: abre Configuración → Tu perfil.
  await page.getByRole("button", { name: /Tu perfil: Johana Prueba/ }).click();
  await page.getByRole("heading", { name: "Tu perfil" }).waitFor();
  assert((await page.getByText("Cerrar sesión ↗").count()) === 0, "la app de escritorio no debe ofrecer cerrar sesión");
  // Si la sesión se pierde, la app vuelve a entrar sola sin pedir la clave.
  await page.evaluate(() => fetch("/api/v1/logout", { method: "POST" }));
  await page.waitForTimeout(6500);
  assert((await page.getByLabel("Contraseña de administrador").count()) === 0, "pidió la clave tras perder la sesión");
  assert((await page.evaluate(() => fetch("/api/v1/me").then((r) => r.status))) === 200, "no volvió a entrar sola");
  await page.getByRole("button", { name: /Estudio en vivo/ }).first().click();
  await page.getByRole("heading", { name: "Mi estudio" }).waitFor();
  console.log("bienvenida, perfil y entrada automática OK");
  console.log("webrtc en Electron:", await page.evaluate(() => typeof RTCPeerConnection));
  await page.getByRole("button", { name: "Probar dispositivos", exact: true }).click();
  await page.getByRole("button", { name: "Probar cámara y micrófono" }).click();
  await page.getByText("Micrófono activo · habla para comprobar el nivel").waitFor();
  await page.getByRole("button", { name: "Conectar cámara y audio" }).click();
  await page.getByText("Sala conectada", { exact: true }).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Añadir Anfitrión", exact: true }).click();
  const post = (path, data, method = "POST") => page.request.fetch(`${origin}${path}`, { method, headers: { Origin: origin }, data });
  const d = await post("/api/v1/destination", { url: `rtmp://127.0.0.1:${rtmpPort}/live`, key: "key" }, "PUT");
  assert(d.ok(), "destino: " + (await d.text()));
  await sleep(500);
  // La propia UI debe abrir el compositor a través del puente (ventana oculta del shell).
  const start = await post("/api/v1/broadcast/start?record=true", {});
  assert(start.ok(), "start: " + (await start.text()));
  let renderer;
  for (let i = 0; i < 60 && !renderer; i++) { renderer = app.windows().find((w) => w.url().includes("/render?")); if (!renderer) await sleep(250); }
  assert(renderer, "El shell no abrió la ventana del compositor");
  await sleep(3000);
  console.log("compositor:", JSON.stringify(await renderer.evaluate(() => { const r = document.querySelector(".stage")?.getBoundingClientRect(); return { w: innerWidth, h: innerHeight, stage: r && [r.width, r.height] }; })));
  await sleep(seconds * 1000);
  const studio = await (await page.request.get(`${origin}/api/v1/studio`)).json();
  console.log("estado:", studio.broadcast?.status, studio.broadcast?.error || "");
  { const r = await (await page.request.get(`${origin}/api/v1/resources`)).json(); console.log("codificador en uso:", r.encoder?.encoder ?? "(sin datos)"); }
  assert((await post("/api/v1/broadcast/stop?all=true", {})).ok(), "stop");
  for (let i = 0; i < 80; i++) { const b = (await (await page.request.get(`${origin}/api/v1/studio`)).json()).broadcast; if (/complete|error/.test(b?.status)) break; await sleep(250); }
  const mp4 = join(rec, `${studio.broadcast.id}.mp4`);
  assert(existsSync(mp4), "No existe el MP4");
  const out = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration", "-of", "json", mp4]).toString());
  console.log("MP4:", statSync(mp4).size, "bytes", JSON.stringify(out.streams), "duración", out.format.duration);
  // Carpeta de grabaciones: el diálogo nativo se sustituye; el resto es la app real.
  const chosen = join(work, "elegida");
  mkdirSync(chosen);
  await app.evaluate(({ dialog, shell }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    globalThis.__opened = [];
    shell.openPath = async (target) => { globalThis.__opened.push(target); return ""; };
  }, chosen);
  await page.getByRole("button", { name: /Configuración/ }).first().click();
  const panel = page.locator(".recordings-folder");
  await panel.getByText(rec, { exact: true }).waitFor();
  await panel.getByRole("button", { name: "Elegir carpeta…" }).click();
  await panel.getByText(chosen, { exact: true }).waitFor();
  await panel.getByRole("button", { name: "Abrir carpeta" }).click();
  await sleep(300);
  const opened = await app.evaluate(() => globalThis.__opened);
  assert(opened.length === 1 && opened[0] === chosen, "no se abrió la carpeta: " + JSON.stringify(opened));
  const rejected = await page.evaluate((file) => window.streamhiveDesktop.openFolder(file).then(() => false, () => true), mp4);
  assert(rejected, "folder:open aceptó un archivo");
  await panel.getByRole("button", { name: "Usar la predeterminada" }).click();
  await panel.getByText("Carpeta actual (predeterminada)").waitFor();
  console.log("Carpeta de grabaciones: selector y apertura correctos");
  assert(out.streams.some((s) => s.codec_type === "video" && s.height === 1080), "sin vídeo 1080");
  assert(out.streams.some((s) => s.codec_type === "audio"), "sin audio");
  assert(Number(out.format.duration) > seconds * 0.6, "MP4 demasiado corto");
  await sleep(500);
  assert(existsSync(sinkFile) && statSync(sinkFile).size > 10000, "El destino RTMP no recibió datos");
  console.log("RTMP recibido:", statSync(sinkFile).size, "bytes");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", "4", "-i", mp4, "-frames:v", "1", join(work, "frame.png")]);
  console.log("fotograma:", join(work, "frame.png"));
  if (errors.length) console.log("errores de página:", errors.slice(0, 5));
  console.log("ELECTRON E2E OK");
} catch (e) { failed = true; console.error("ELECTRON E2E FALLÓ:", e.message); }
finally { await app?.close().catch(() => {}); sink?.kill(); process.exit(failed ? 1 : 0); }
