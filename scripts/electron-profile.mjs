// Perfil de CPU por proceso de la app Electron en tres estados: estudio inactivo, cámara en el programa y en directo.
import { _electron as electron } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "sh-prof-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secs = Number(process.argv[2] || 15);
let app, sink;
const measure = (pid) => new Promise((res) => { let out = ""; const p = spawn("python3", [join(root, "scripts/proc-usage.py"), "--root", String(pid), "--seconds", String(secs), "--detail"]); p.stdout.on("data", (d) => (out += d)); p.on("close", () => res(JSON.parse(out).procesos)); });
async function report(state) {
  const pid = app.process().pid;
  const wins = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => [w.webContents.getOSProcessId(), w.webContents.getURL().replace(/\?.*/, "").replace(/^https?:\/\/[^/]+/, "") || "/"]));
  const roleOf = new Map(wins.map(([p, u]) => [p, u.startsWith("/render") ? "compositor (ventana /render)" : "estudio (ventana principal)"]));
  const rows = await measure(pid);
  const tot = rows.reduce((a, r) => a + r.nucleos, 0);
  const pss = rows.reduce((a, r) => a + r.pss_mb, 0);
  console.log(`\n== ${state}: ${tot.toFixed(2)} núcleos | ${pss} MB PSS | ${rows.length} procesos`);
  const grp = {}, mem = {};
  for (const r of rows) {
    const k = roleOf.get(r.pid) || (r.comando === "livekit-server" ? "LiveKit" : r.comando.startsWith("streamhive-back") ? "backend (Rust)" : r.comando === "ffmpeg" ? "ffmpeg" : r.comando.startsWith("streamhive-desk") ? "Electron: navegador, GPU, red, audio (sin las 2 ventanas)" : r.tipo);
    grp[k] = (grp[k] || 0) + r.nucleos; mem[k] = (mem[k] || 0) + r.pss_mb;
  }
  for (const [k, v] of Object.entries(grp).sort((a, b) => b[1] - a[1])) console.log(`   ${v.toFixed(2).padStart(5)} núcl ${String(mem[k]).padStart(4)} MB  ${k}`);
}
try {
  sink = spawn("ffmpeg", ["-v", "error", "-listen", "1", "-i", "rtmp://127.0.0.1:19391/live/k", "-c", "copy", "-y", join(work, "s.flv")], { stdio: "ignore" });
  app = await electron.launch({ executablePath: process.env.E2E_PACKAGED, args: (process.env.CHR_FLAGS || "").split(/\s+/).filter(Boolean), env: { ...process.env, TMPDIR: "/tmp", STREAMHIVE_FAKE_MEDIA: "1", STREAMHIVE_FAKE_VIDEO_FILE: process.env.BENCH_VIDEO || "", STREAMHIVE_E2E: "1", STREAMHIVE_PORT: "8808", STREAMHIVE_LK_PORT: "7946", STREAMHIVE_RECORDINGS: join(work, "rec"), XDG_CONFIG_HOME: join(work, "config") }, timeout: 60000 });
  const info = await new Promise((res, rej) => { const t = setTimeout(() => rej(Error("sin READY")), 30000); app.process().stdout.on("data", (d) => { const m = String(d).match(/STREAMHIVE_READY (.*)/); if (m) { clearTimeout(t); res(JSON.parse(m[1])); } }); });
  const page = await app.firstWindow(); const origin = info.base;
  await page.getByRole("heading", { name: "Mi estudio" }).waitFor({ timeout: 20000 });
  await sleep(3000); await report("A) estudio inactivo, sin cámara");
  await page.getByRole("button", { name: "Probar dispositivos", exact: true }).click();
  await page.getByRole("button", { name: "Probar cámara y micrófono" }).click();
  await page.getByText("Micrófono activo · habla para comprobar el nivel").waitFor();
  await page.getByRole("button", { name: "Conectar cámara y audio" }).click();
  await page.getByText("Sala conectada", { exact: true }).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Añadir Anfitrión", exact: true }).click();
  await sleep(3000); await report("B) cámara del anfitrión en el programa, sin emitir");
  const post = (path, data) => page.request.fetch(`${origin}${path}`, { method: "POST", headers: { Origin: origin }, data });
  await page.request.fetch(`${origin}/api/v1/destination`, { method: "PUT", headers: { Origin: origin }, data: { url: "rtmp://127.0.0.1:19391/live", key: "k" } });
  if (!(await post("/api/v1/broadcast/start", {})).ok()) throw Error("start");
  await sleep(8000);
  if (process.env.PROFILE_RENDER_SIZE) {
    const [w, h] = process.env.PROFILE_RENDER_SIZE.split("x").map(Number);
    await app.evaluate(({ BrowserWindow }, [w, h]) => { const win = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("/render")); win?.setContentSize(w, h); }, [w, h]);
    await sleep(3000);
  }
  await report(`C) en directo (compositor + codificación)${process.env.PROFILE_RENDER_SIZE ? " con ventana del compositor a " + process.env.PROFILE_RENDER_SIZE : ""}`);
  await post("/api/v1/broadcast/stop", {});
} catch (e) { console.error("PERFIL FALLÓ:", e.message.split("\n")[0]); }
finally { await app?.close().catch(() => {}); sink?.kill(); process.exit(0); }
