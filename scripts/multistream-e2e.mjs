// E2E multiplataforma en la app Electron real: añade destinos DESDE LA INTERFAZ (un preset y dos personalizados),
// emite a la vez a dos servidores RTMP locales + un tercero caído a propósito, y comprueba que una plataforma
// caída no corta a las demás ni la grabación, y que las claves jamás se muestran.
import { _electron as electron } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "sh-multi-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw Error(m); };
const secs = Number(process.argv[2] || 12);
const KEYS = ["clave-secreta-A", "clave-secreta-B", "clave-secreta-CAIDA", "clave-secreta-YT"];
const sinks = [];
let app, failed = false;
const sink = (port, file) => spawn("ffmpeg", ["-v", "error", "-listen", "1", "-i", `rtmp://127.0.0.1:${port}/live/${port === 29361 ? KEYS[0] : port === 29362 ? KEYS[1] : KEYS[2]}`, "-c", "copy", "-y", file], { stdio: "ignore" });
try {
  const fileA = join(work, "a.flv"), fileB = join(work, "b.flv");
  sinks.push(sink(29361, fileA), sink(29362, fileB));
  app = await electron.launch({
    executablePath: process.env.E2E_PACKAGED || join(root, "desktop/electron/node_modules/electron/dist/electron"),
    args: process.env.E2E_PACKAGED ? ["--no-sandbox"] : ["--no-sandbox", join(root, "desktop/electron")],
    env: { ...process.env, TMPDIR: "/tmp", STREAMHIVE_FAKE_MEDIA: "1", STREAMHIVE_E2E: "1", STREAMHIVE_PORT: "28799", STREAMHIVE_LK_PORT: "27990", STREAMHIVE_RECORDINGS: join(work, "rec"), XDG_CONFIG_HOME: join(work, "config") },
    timeout: 60000,
  });
  const origin = "http://localhost:28799";
  app.process().stderr.on("data", (d) => { const line = String(d); if (/\[livekit\]|\[backend\]/.test(line)) console.error(line.slice(0, 1000)); });
  const page = await app.firstWindow();
  page.on("pageerror", (e) => console.error("Error web:", e.message));
  await page.waitForURL(`${origin}/`, { timeout: 30000 });
  console.log("app lista; comprobando escenas y destinos");
  await page.getByRole("heading", { name: "Mi estudio" }).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Probar dispositivos", exact: true }).click();
  await page.getByRole("button", { name: "Probar cámara y micrófono" }).click();
  await page.getByText("Micrófono activo · habla para comprobar el nivel").waitFor();
  await page.getByRole("button", { name: "Conectar cámara y audio" }).click();
  await page.getByText("Sala conectada", { exact: true }).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Añadir Anfitrión", exact: true }).click();

  // Guarda composiciones independientes y comprueba que recuperar una escena no pisa la otra.
  await page.getByLabel("Nombre de la escena").fill("Entrevista horizontal");
  await page.getByRole("button", { name: "Guardar escena actual" }).click();
  await page.getByRole("button", { name: "Entrevista horizontal", exact: true }).waitFor();
  console.log("escena horizontal guardada; cambiando formato");
  await page.getByLabel("Composición", { exact: true }).selectOption("portrait");
  await page.getByRole("button", { name: "Copiar desde 16:9", exact: true }).click();
  await page.getByLabel("Nombre de la escena").fill("Entrevista vertical");
  await page.getByRole("button", { name: "Guardar escena actual" }).click();
  await page.getByRole("button", { name: "Entrevista vertical", exact: true }).waitFor();
  assert(await page.locator(".stage.format-portrait").count() === 1, "sin vista vertical");

  await page.getByLabel("Composición", { exact: true }).selectOption("landscape");
  await page.getByRole("button", { name: "Entrevista horizontal", exact: true }).click({ force: true });

  console.log("escenas de ambos formatos verificadas; configurando destinos");
  // --- Añadir destinos desde la interfaz de Configuración
  await page.getByRole("button", { name: /Configuración/ }).first().click();
  await page.getByRole("heading", { name: "Destinos de transmisión" }).waitFor();
  const addCustom = async (name, port, key, format = "landscape") => {
    await page.getByLabel("Plataforma").selectOption("custom");
    await page.getByLabel("Nombre", { exact: true }).fill(name);
    await page.getByLabel("Formato de salida").selectOption(format);
    await page.getByLabel("URL RTMP / RTMPS").fill(`rtmp://127.0.0.1:${port}/live`);
    await page.getByLabel("Clave de transmisión").fill(key);
    await page.getByRole("button", { name: "Añadir destino" }).click();
    await page.getByRole("list", { name: "Destinos de transmisión" }).getByText(name, { exact: true }).waitFor();
  };
  // Kick como canal propio: pide la URL de su servidor (aquí, un servidor RTMP local).
  await page.getByLabel("Plataforma").selectOption("kick");
  assert((await page.locator("body").innerText()).includes("panel de emisión de tu canal de Kick"), "no se muestra la ayuda de Kick");
  const canales = await page.getByLabel("Plataforma").locator("option").allTextContents();
  for (const n of ["YouTube", "Twitch", "Facebook", "Kick", "X", "Instagram", "TikTok", "LinkedIn"]) assert(canales.includes(n), `falta el canal ${n}`);
  await page.getByLabel("URL del servidor de Kick").fill("rtmp://127.0.0.1:29361/live");
  await page.getByLabel("Clave de transmisión").fill(KEYS[0]);
  await page.getByRole("button", { name: "Añadir destino" }).click();
  await page.getByRole("list", { name: "Destinos de transmisión" }).getByText("Kick", { exact: true }).waitFor();
  console.log("canales disponibles:", canales.join(" | "));
  await addCustom("Servidor B", 29362, KEYS[1], "portrait");
  await addCustom("Servidor caído", 29363, KEYS[2]); // nadie escucha aquí
  await page.getByLabel("Plataforma").selectOption("youtube");
  await page.getByLabel("Clave de transmisión").fill(KEYS[3]);
  await page.getByRole("button", { name: "Añadir destino" }).click();
  await page.getByRole("list", { name: "Destinos de transmisión" }).getByText("YouTube", { exact: true }).waitFor();
  // YouTube real quedaría activo: lo desactivamos para no emitir fuera de esta máquina.
  await page.getByLabel("Emitir a YouTube").click();
  await page.waitForFunction(() => !document.querySelector('input[aria-label="Emitir a YouTube"]').checked);
  const shown = await page.locator("body").innerText();
  assert(KEYS.every((k) => !shown.includes(k)), "una clave de transmisión se muestra en la interfaz");
  assert(shown.includes("127.0.0.1") && shown.includes("a.rtmps.youtube.com"), "la lista no muestra los servidores");
  await page.screenshot({ path: join(work, "destinos.png"), timeout: 3000 }).catch(() => {}); // ventana oculta en pruebas

  // --- Emitir
  const post = (path, data) => page.request.fetch(`${origin}${path}`, { method: "POST", headers: { Origin: origin }, data });
  const start = await post("/api/v1/broadcast/start", {});
  assert(start.ok(), "start: " + (await start.text()));
  await sleep(secs * 1000);
  const studio = await (await page.request.get(`${origin}/api/v1/studio`)).json();
  console.log("estado:", studio.broadcast?.status, "| destinos activos:", studio.destinations.filter((d) => d.enabled).map((d) => d.name).join(", "));
  assert(studio.broadcast?.status === "reconnecting", "no se informa del destino caído: " + studio.broadcast?.status);
  const states = Object.fromEntries(studio.destinations.map((d) => [d.name, d.status]));
  assert(states.Kick === "live" && states["Servidor B"] === "live" && states["Servidor caído"] === "reconnecting", "estados por destino incorrectos: " + JSON.stringify(states));
  // La salida ausente vuelve sin reiniciar el directo ni la grabación.
  const fileC = join(work, "c.flv");
  sinks.push(sink(29363, fileC));
  const waitState = async (name, state) => {
    for (let i = 0; i < 40; i++) {
      const current = await (await page.request.get(`${origin}/api/v1/studio`)).json();
      if (current.destinations.find((d) => d.name === name)?.status === state) return current;
      await sleep(500);
    }
    throw Error(`El destino ${name} no llegó a ${state}`);
  };
  await waitState("Servidor caído", "live");
  // Corta solo la vertical y recupera manualmente esa salida.
  sinks[1].kill();
  await waitState("Servidor B", "reconnecting");
  const recoveredB = join(work, "b-recovered.flv");
  sinks.push(sink(29362, recoveredB));
  const rowB = page.getByRole("list", { name: "Destinos de transmisión" }).locator("li").filter({ hasText: "Servidor B" });
  await rowB.getByRole("button", { name: "Reintentar", exact: true }).click({ force: true });
  const recovered = await waitState("Servidor B", "live");
  assert(recovered.broadcast.id === studio.broadcast.id, "se reinició la emisión al recuperar una salida");
  assert(recovered.destinations.find((d) => d.name === "Kick")?.status === "live", "la horizontal cayó con la vertical");
  await sleep(3000);
  assert((await post("/api/v1/broadcast/stop", {})).ok(), "stop");
  for (let i = 0; i < 100; i++) { const b = (await (await page.request.get(`${origin}/api/v1/studio`)).json()).broadcast; if (/complete|error/.test(b?.status)) break; await sleep(250); }
  await sleep(800);
  const probe = (f) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height", "-of", "json", f]).toString()).streams;
  for (const [n, f] of [["A", fileA], ["B", fileB], ["B recuperado", recoveredB], ["C recuperado", fileC]]) {
    assert(existsSync(f) && statSync(f).size > 10000, `el servidor ${n} no recibió datos`);
    const st = probe(f);
    assert(st.some((s) => s.codec_name === "h264" && s.height === (n.startsWith("B") ? 1920 : 1080)) && st.some((s) => s.codec_type === "audio"), `el servidor ${n} no recibió vídeo+audio`);
    console.log(`servidor ${n}: ${statSync(f).size} bytes`, JSON.stringify(st.map((s) => s.codec_name)));
  }
  const mp4 = join(work, "rec", `${studio.broadcast.id}.mp4`);
  assert(existsSync(mp4) && statSync(mp4).size > 10000, "la grabación local se perdió");
  const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4]).toString());
  assert(dur > secs * 0.6, `grabación demasiado corta: ${dur}s`);
  const verticalMp4 = join(work, "rec", `${studio.broadcast.id}-portrait.mp4`);
  const verticalStreams = probe(verticalMp4);
  assert(verticalStreams.some((s) => s.width === 1080 && s.height === 1920), "MP4 vertical incorrecto");
  assert(probe(mp4).some((s) => s.width === 1920 && s.height === 1080), "MP4 horizontal incorrecto");
  console.log("grabaciones horizontal y vertical:", statSync(mp4).size, statSync(verticalMp4).size, "bytes;", dur.toFixed(1), "s");
  console.log("captura:", join(work, "destinos.png"));
  console.log("MULTISTREAM E2E OK");
} catch (e) {
  failed = true; console.error("MULTISTREAM E2E FALLÓ:", e.message);
  if (app) { const page = await app.firstWindow(); await page.screenshot({ path: join(work, "failure.png"), timeout: 3000 }).catch(() => {}); console.error("Captura del fallo:", join(work, "failure.png")); }
}
finally { await app?.close().catch(() => {}); sinks.forEach((s) => s.kill()); process.exit(failed ? 1 : 0); }
