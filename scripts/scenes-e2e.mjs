// Drives the scenes panel on the real `dev` launcher: saving, seeing, using, updating and deleting.
// Uses isolated settings and a local RTMP receiver; never reads a real stream key.
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "sh-scenes-"));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const assert = (ok, message) => { if (!ok) throw Error(message); };
const free = () => new Promise(r => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const children = [];
const launch = (cmd, args, env) => {
  const p = spawn(cmd, args, { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; for (const out of [p.stdout, p.stderr]) out.on("data", d => { log = (log + d).slice(-5000); });
  p.log = () => log; children.push(p); return p;
};
let browser, success = false;
try {
  const [api, web, lk, tcp, udp, rtmp] = await Promise.all(Array.from({ length: 6 }, free));
  const origin = `http://localhost:${web}`, secret = randomBytes(32).toString("hex");
  const env = { ...process.env }; delete env.ENGINE;
  const config = join(work, "livekit.yaml");
  writeFileSync(config, `port: ${lk}\nbind_addresses: [127.0.0.1]\nrtc:\n  tcp_port: ${tcp}\n  udp_port: ${udp}\n  use_external_ip: false\nkeys:\n  localtest: ${secret}\n`);
  launch(join(root, "runtime/bin/livekit-server"), ["--config", config, "--node-ip", "127.0.0.1"], env);
  const launcher = launch(process.execPath, ["scripts/dev.mjs"], { ...env, STREAMHIVE_REVIEW_DIR: work, STREAMHIVE_API_PORT: String(api), STREAMHIVE_PORT: String(web), LIVEKIT_INTERNAL_URL: `http://127.0.0.1:${lk}`, LIVEKIT_PUBLIC_URL: `ws://localhost:${lk}`, LIVEKIT_API_KEY: "localtest", LIVEKIT_API_SECRET: secret });
  for (let i = 0; ; i++) {
    try { if ((await fetch(origin)).ok) break; } catch {}
    assert(i < 600 && launcher.exitCode === null, "local launcher unavailable: " + launcher.log()); await sleep(100);
  }
  assert(launcher.log().includes("Motor de salida: ffmpeg"), "launcher did not default to FFmpeg");
  const { ADMIN_PASSWORD } = JSON.parse(readFileSync(join(work, "secrets.json")));
  browser = await chromium.launch({ headless: true, executablePath: env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(origin); await page.getByLabel("Contraseña de administrador").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Abrir mi estudio" }).click(); await page.getByRole("heading", { name: "Mi estudio" }).waitFor();
  const request = async (path, data) => {
    const r = await page.request.post(origin + "/api/v1" + path, { headers: { Origin: origin }, data });
    assert(r.ok(), path + ": " + await r.text()); return r.json();
  };
  await page.getByRole("button", { name: /Estudio en vivo/ }).click();
  const studio = async () => (await page.request.get(origin + "/api/v1/studio")).json();
  const panel = page.locator(".scene-controls");
  const list = panel.getByRole("list", { name: "Escenas guardadas" });
  const look = async (patch) => {
    const { program } = await studio();
    const r = await page.request.put(origin + "/api/v1/program", { headers: { Origin: origin }, data: { ...program, ...patch } });
    assert(r.ok(), "program: " + await r.text()); await sleep(600);
  };
  const save = async (name) => {
    await panel.getByLabel("Nombre de la escena").fill(name);
    await panel.getByRole("button", { name: "Guardar escena actual" }).click();
    await page.getByText(`Escena «${name}» guardada`).waitFor();
  };
  const card = (name) => list.locator("li").filter({ hasText: name });

  // Sin escenas se explica qué hacer.
  await panel.getByText("Aún no tienes escenas en 16:9").waitFor();

  // Lo guardado se ve: nombre, diseño, cámaras y que es lo que está al aire.
  await look({ identities: ["host"], background: "#224466" });
  await save("Entrevista");
  await card("Entrevista").getByText("Cuadrícula · 16:9").waitFor();
  await card("Entrevista").getByText("1 cámara: Anfitrión").waitFor();
  await card("Entrevista").getByText("En el programa").waitFor();
  await page.screenshot({ path: join(work, "scene-saved.png") });
  console.log("OK saved scene shows what it contains");

  // Cambiar el programa la libera; usarla restaura el montaje guardado.
  await look({ identities: [], background: "#884422" });
  await card("Entrevista").getByRole("button", { name: "Usar escena Entrevista" }).waitFor();
  await save("Vacía");
  await card("Vacía").getByText("Escena vacía").waitFor();
  await page.screenshot({ path: join(work, "scene-two.png") });
  await card("Entrevista").getByRole("button", { name: "Usar escena Entrevista" }).click();
  await card("Entrevista").getByText("En el programa").waitFor();
  const used = (await studio()).program;
  assert(used.background === "#224466" && used.identities[0] === "host", "scene not restored: " + JSON.stringify(used));
  console.log("OK using a scene restores the program");

  // Actualizar reemplaza su contenido sin cambiarle el nombre.
  await look({ background: "#336633" });
  await card("Entrevista").getByRole("button", { name: "Actualizar escena Entrevista" }).click();
  await card("Entrevista").getByRole("button", { name: "Cancelar" }).click();
  assert((await studio()).scenes.find(s => s.name === "Entrevista").program.background === "#224466", "cancel changed the scene");
  await card("Entrevista").getByRole("button", { name: "Actualizar escena Entrevista" }).click();
  await card("Entrevista").getByRole("button", { name: "Sí, reemplazar" }).click();
  await card("Entrevista").getByText("En el programa").waitFor();
  assert((await studio()).scenes.find(s => s.name === "Entrevista").program.background === "#336633", "scene not updated");
  console.log("OK updating a scene replaces it");

  // Las escenas del otro formato no desaparecen sin avisar.
  await panel.getByLabel("Composición", { exact: true }).selectOption("portrait");
  await panel.getByText("Tienes 2 escenas en 16:9").waitFor();
  await panel.getByText("Aún no tienes escenas en 9:16").waitFor();
  await panel.getByRole("button", { name: "Ver 16:9" }).click();
  await card("Entrevista").waitFor();

  // Eliminar pide confirmación y no toca el programa.
  const before = (await studio()).program.background;
  await card("Vacía").getByRole("button", { name: "Eliminar escena Vacía" }).click();
  await card("Vacía").getByRole("button", { name: "Sí, eliminar" }).click();
  await card("Vacía").waitFor({ state: "detached" });
  assert((await studio()).program.background === before, "deleting a scene changed the program");

  // Sobrevive a recargar la app.
  await page.reload();
  await card("Entrevista").waitFor();
  console.log("OK other format, delete and reload");
  const box = await panel.boundingBox();
  assert(box.height < 330, "scenes panel pushes the stage away: " + box.height);
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(300);
  await panel.screenshot({ path: join(work, "scene-phone.png") });
  const fits = await panel.evaluate(e => e.getBoundingClientRect().right <= innerWidth && [...e.querySelectorAll("*")].every(c => c.closest(".scene-list") || c.getBoundingClientRect().right <= innerWidth + 1));
  assert(fits, "scenes panel overflows at phone width");
  assert(!errors.length, errors.join("\n")); success = true;
  console.log("SCENES E2E OK: scenes are visible, reusable, editable");
} catch (e) { console.error(e.message); for (const p of children) console.error(p.log()); }
finally {
  await browser?.close();
  for (const p of children) try { process.kill(-p.pid, "SIGTERM"); } catch {}
  await sleep(1000);
  for (const p of children) try { process.kill(-p.pid, "SIGKILL"); } catch {}
  console.log("Artifacts:", work); process.exit(success ? 0 : 1);
}
