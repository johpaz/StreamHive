// Local review launcher. Production remains managed by compose.yaml.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";
if (process.argv.includes("--smoke-existing")) {
  await import("./browser-smoke.mjs");
  process.exit(0);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = resolve(process.env.STREAMHIVE_REVIEW_DIR || join(root, "runtime", "review"));
const engine = process.env.ENGINE || "ffmpeg";
const frontend = join(root, "frontend");
const apiPort = Number(process.env.STREAMHIVE_API_PORT || 8780);
const webPort = Number(process.env.STREAMHIVE_PORT || 5173);
if (
  ![apiPort, webPort].every(
    (p) => Number.isInteger(p) && p > 0 && p <= 65535,
  ) ||
  apiPort === webPort
)
  throw Error("Puertos locales inválidos");
const webOrigin = `http://localhost:${webPort}`;
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const children = new Set();
let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 5000);
    timer.unref();
  }
  process.exitCode = code;
}
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());
function command(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: root,
      stdio: "inherit",
      ...options,
    });
    children.add(child);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      children.delete(child);
      code === 0
        ? resolve()
        : reject(Error(`${program} exited (${signal || code})`));
    });
  });
}
function server(program, args, options = {}) {
  const child = spawn(program, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  children.add(child);
  child.once("error", (error) => {
    console.error(error.message);
    shutdown(1);
  });
  child.once("exit", (code) => {
    children.delete(child);
    if (!stopping) {
      console.error(`${program} stopped (${code})`);
      shutdown(code || 1);
    }
  });
  return child;
}
async function available(port) {
  await new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(port, "127.0.0.1", () => listener.close(resolve));
  });
}
try {
  if (!["ffmpeg", "egress"].includes(engine)) throw Error("ENGINE debe ser ffmpeg o egress");
  if (engine === "ffmpeg") {
    try {
      await command(process.env.FFMPEG_BIN || "ffmpeg", ["-version"], { stdio: "ignore" });
    } catch {
      throw Error("La emisión local requiere FFmpeg. Instálalo o configura FFMPEG_BIN con su ruta.");
    }
  }
  await available(apiPort);
  await available(webPort);
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  let settings;
  try {
    settings = JSON.parse(
      await readFile(join(runtime, "secrets.json"), "utf8"),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    settings = {
      ADMIN_PASSWORD: `StreamHive-${randomBytes(12).toString("base64url")}`,
      SESSION_SECRET: randomBytes(48).toString("base64url"),
      MASTER_KEY: randomBytes(32).toString("base64"),
    };
    await writeFile(
      join(runtime, "secrets.json"),
      JSON.stringify(settings, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
  }
  await writeFile(
    join(runtime, "login.txt"),
    `URL: ${webOrigin}\nContraseña: ${settings.ADMIN_PASSWORD}\n`,
    { mode: 0o600 },
  );
  try {
    await access(join(frontend, "node_modules", ".bin", "vite"));
  } catch {
    await command("bun", ["install", "--frozen-lockfile"], { cwd: frontend });
  }
  try {
    await access(join(frontend, "public", "livekit-client.umd.js"));
  } catch {
    try {
      await command("bun", ["run", "sdk"], { cwd: frontend });
    } catch {
      console.warn(
        "SDK multimedia no disponible. La interfaz puede revisarse; la conexión de cámara requiere bun run sdk y LiveKit.",
      );
    }
  }
  try {
    await access(join(frontend, "public", "effects", "loader.mjs"));
  } catch {
    try {
      await command("bun", ["run", "effects"], { cwd: frontend });
    } catch {
      console.warn(
        "Los efectos de cámara no están disponibles; el estudio puede funcionar sin ellos.",
      );
    }
  }
  // A verified local LiveKit binary can provide the room without a container runtime.
  if (!process.env.LIVEKIT_INTERNAL_URL) {
    const binary = join(root, "runtime", "bin", "livekit-server");
    try {
      try {
        await access(binary);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await command(process.execPath, [
          join(root, "scripts", "install-livekit.mjs"),
        ]);
      }
      let existing = false;
      try {
        existing = (
          await fetch("http://127.0.0.1:7880", {
            signal: AbortSignal.timeout(1500),
          })
        ).ok;
      } catch {}
      if (!existing) {
        const config = join(runtime, "livekit.json");
        await writeFile(
          config,
          JSON.stringify({ logging: { level: "warn" } }, null, 2) + "\n",
          { mode: 0o600 },
        );
        server(binary, [
          "--dev",
          "--config",
          config,
          "--bind",
          "127.0.0.1",
          "--node-ip",
          "127.0.0.1",
        ]);
        let ready = false;
        for (let attempt = 0; attempt < 40 && !stopping; attempt++) {
          try {
            if ((await fetch("http://127.0.0.1:7880")).ok) {
              ready = true;
              break;
            }
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (!ready) throw Error("LiveKit local no pudo iniciar");
      }
    } catch (error) {
      if (error.code === "ENOENT")
        console.warn("LiveKit no instalado: solo está disponible el panel.");
      else throw error;
    }
  }
  await command("cargo", ["build", "--locked", "--offline", "-p", "streamhive"]);
  const env = {
    ...process.env,
    ...settings,
    ENGINE: engine,
    DATA_DIR: join(runtime, "data"),
    RECORDINGS_DIR: join(runtime, "recordings"),
    PUBLIC_ORIGIN: webOrigin,
    LISTEN_ADDR: `127.0.0.1:${apiPort}`,
    LIVEKIT_INTERNAL_URL:
      process.env.LIVEKIT_INTERNAL_URL || "http://127.0.0.1:7880",
    LIVEKIT_PUBLIC_URL: process.env.LIVEKIT_PUBLIC_URL || "ws://localhost:7880",
    RENDERER_URL: `${webOrigin}/render`,
  };
  server(join(root, "target", "debug", "streamhive"), [], { env });
  let ready = false;
  for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
    try {
      const response = await fetch(`${apiOrigin}/healthz`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw Error(`El backend no pudo iniciar en ${apiOrigin}`);
  server(
    process.execPath,
    [
      join(frontend, "node_modules", "vite", "bin", "vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      String(webPort),
      "--strictPort",
    ],
    {
      cwd: frontend,
      env: { ...process.env, STREAMHIVE_API_TARGET: apiOrigin },
    },
  );
  console.log(
    `\nStreamHive: ${webOrigin}\nCredenciales locales: ${join(runtime, "login.txt")}\nLiveKit: ${env.LIVEKIT_PUBLIC_URL}\nMotor de salida: ${engine}\nCtrl+C detiene los servicios iniciados por este comando.\n`,
  );
  if (process.argv.includes("--smoke")) {
    try {
      await import("./browser-smoke.mjs");
    } catch (error) {
      console.error(`Browser smoke failed: ${error.message}`);
      shutdown(1);
    }
  }
} catch (error) {
  console.error(`No se pudo levantar StreamHive: ${error.message}`);
  shutdown(1);
}
