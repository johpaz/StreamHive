#!/usr/bin/env bun
// Publica una versión de StreamHive con un solo comando:
//
//   bun scripts/release.mjs 1.0.0              versión de la app de escritorio
//   bun scripts/release.mjs 1.0.0 --sessions   y además la imagen del servidor de sesiones
//   bun scripts/release.mjs 1.0.0 --dry-run    solo comprueba y muestra lo que haría
//
// Comprueba que master esté limpio, al día con GitHub y con el CI en verde; pone el número en
// los cuatro proyectos (y sus archivos de bloqueo), crea el commit y la etiqueta vX.Y.Z y lo sube.
// GitHub Actions compila los instaladores (Linux, Windows, macOS experimental) y publica la
// Release con ellos (.github/workflows/desktop.yml). Con --sessions sube también sessions-vX.Y.Z,
// que construye la imagen Docker del servidor de sesiones (.github/workflows/sessions-image.yml).
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const version = args.find((a) => !a.startsWith("--"));
const dryRun = flag("--dry-run");
const withSessions = flag("--sessions");
const skipCi = flag("--skip-ci");
const yes = flag("--yes");

const fail = (message) => {
  console.error(`\n✗ ${message}`);
  process.exit(1);
};
const run = (cmd, argv, options = {}) =>
  execFileSync(cmd, argv, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
const git = (...argv) => run("git", argv);
const has = (cmd) => spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;

if (!version || flag("--help") || flag("-h")) {
  console.log(`Uso: bun scripts/release.mjs <versión> [--sessions] [--dry-run] [--skip-ci] [--yes]

  <versión>    número X.Y.Z, por ejemplo 1.0.0
  --sessions   publica también la imagen del servidor de sesiones (sessions-vX.Y.Z)
  --dry-run    comprueba todo y muestra los cambios sin escribir ni subir nada
  --skip-ci    no exige que el último CI de master esté en verde
  --yes        no pide confirmación`);
  process.exit(version ? 0 : 1);
}
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`"${version}" no es un número de versión X.Y.Z (por ejemplo 1.0.0)`);
const tag = `v${version}`;
const sessionsTag = `sessions-v${version}`;
const tags = withSessions ? [tag, sessionsTag] : [tag];

console.log(`StreamHive ${version}${dryRun ? " (simulación)" : ""}\n`);

// 1. Repositorio en orden.
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== "master") fail(`Estás en la rama "${branch}". Las versiones se publican desde master.`);
// output/ guarda el paquete local generado; no forma parte de la versión.
const dirty = git("status", "--porcelain")
  .split("\n")
  .filter((l) => l && !l.slice(3).startsWith("output/"));
if (dirty.length) fail(`Hay cambios sin confirmar:\n${dirty.join("\n")}\nHaz commit o descártalos antes de publicar.`);
console.log("✓ master sin cambios pendientes");
try {
  git("fetch", "--quiet", "--tags", "origin");
} catch {
  fail("No se pudo contactar con GitHub (git fetch origin).");
}
const [behind, ahead] = git("rev-list", "--left-right", "--count", "origin/master...HEAD").split(/\s+/).map(Number);
if (behind) fail(`Tu master va ${behind} commit(s) por detrás de GitHub. Ejecuta git pull primero.`);
console.log(ahead ? `✓ al día con GitHub (+${ahead} commit(s) por subir)` : "✓ al día con GitHub");
for (const t of tags) {
  if (git("tag", "--list", t)) fail(`La etiqueta ${t} ya existe. Elige otro número.`);
  if (git("ls-remote", "--tags", "origin", `refs/tags/${t}`)) fail(`La etiqueta ${t} ya existe en GitHub.`);
}
console.log(`✓ ${tags.join(" y ")} disponible${tags.length > 1 ? "s" : ""}`);

// 2. El CI del último commit, en verde.
const head = git("rev-parse", "HEAD");
if (skipCi) console.log("! CI sin comprobar (--skip-ci)");
else if (!has("gh")) console.log("! gh no está instalado: no se comprueba el CI. Revísalo en la pestaña Actions.");
else if (ahead) console.log("! hay commits sin subir: su CI se comprobará en GitHub al subirlos");
else {
  let runs = [];
  try {
    runs = JSON.parse(
      run("gh", ["run", "list", "--workflow", "ci.yml", "--branch", "master", "--limit", "10", "--json", "headSha,status,conclusion,url"]),
    );
  } catch {
    fail("No se pudo consultar el CI con gh. ¿Has iniciado sesión (gh auth login)? O usa --skip-ci.");
  }
  const ci = runs.find((r) => r.headSha === head);
  if (!ci) fail("No hay ejecución de CI para el último commit. Espera a que aparezca en Actions o usa --skip-ci.");
  if (ci.status !== "completed") fail(`El CI del último commit sigue en marcha: ${ci.url}\nEspera a que termine.`);
  if (ci.conclusion !== "success") fail(`El CI del último commit no pasó (${ci.conclusion}): ${ci.url}`);
  console.log("✓ CI del último commit en verde");
}

// 3. Número de versión en los cuatro proyectos.
const files = {
  "desktop/electron/package.json": (s) => s.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`),
  "frontend/package.json": (s) => s.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`),
  // La raíz y packages[""] del lock: las dos primeras apariciones.
  "desktop/electron/package-lock.json": (s) => {
    let n = 0;
    return s.replace(/("version":\s*")[^"]+(")/g, (m, a, b) => (n++ < 2 ? `${a}${version}${b}` : m));
  },
  "backend/Cargo.toml": (s) => s.replace(/^(version\s*=\s*")[^"]+(")/m, `$1${version}$2`),
  "sessions/Cargo.toml": (s) => s.replace(/^(version\s*=\s*")[^"]+(")/m, `$1${version}$2`),
  "Cargo.lock": (s) =>
    s.replace(/(name = "streamhive(?:-sessions)?"\nversion = ")[^"]+(")/g, `$1${version}$2`),
};
const current = JSON.parse(readFileSync(join(root, "desktop/electron/package.json"), "utf8")).version;
const changed = [];
for (const [file, bump] of Object.entries(files)) {
  const before = readFileSync(join(root, file), "utf8");
  const after = bump(before);
  if (after !== before) changed.push([file, after]);
}
console.log(
  current === version
    ? `✓ el proyecto ya tiene la versión ${version}`
    : `→ versión ${current} → ${version} en ${changed.map(([f]) => f).join(", ")}`,
);

console.log(`
Se va a:
  ${changed.length ? `1. crear el commit "release: ${tag}" con el número nuevo` : "1. (sin commit: el número ya es el correcto)"}
  2. crear la etiqueta ${tags.join(" y ")}
  3. subir master y la etiqueta a GitHub
  → GitHub Actions compila los instaladores y publica la Release ${tag}${withSessions ? `\n  → y construye la imagen del servidor de sesiones ${version}` : ""}`);

if (dryRun) {
  console.log("\nSimulación: no se ha cambiado ni subido nada.");
  process.exit(0);
}
if (!yes) {
  if (!process.stdin.isTTY) fail("Sin terminal interactiva: añade --yes para confirmar.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`\n¿Publicar ${tag}? Escribe "${version}" para confirmar: `)).trim();
  rl.close();
  if (answer !== version) fail("Cancelado. No se ha cambiado nada.");
}

// 4. Commit, etiquetas y subida.
const touched = changed.map(([file]) => file);
try {
  for (const [file, content] of changed) writeFileSync(join(root, file), content);
  if (touched.length) {
    // Cargo.lock debe seguir siendo coherente con los Cargo.toml.
    const lock = spawnSync("cargo", ["metadata", "--format-version", "1", "--locked", "--no-deps"], {
      cwd: root,
      stdio: ["ignore", "ignore", "pipe"],
      encoding: "utf8",
    });
    if (lock.status !== 0) throw Error(`Cargo.lock no coincide con los Cargo.toml:\n${lock.stderr}`);
    git("add", "--", ...touched);
    git("commit", "-m", `release: ${tag}`, "--", ...touched);
    console.log(`✓ commit release: ${tag}`);
  }
  git("tag", "-a", tag, "-m", `StreamHive ${version}`);
  if (withSessions) git("tag", "-a", sessionsTag, "-m", `Servidor de sesiones ${version}`);
  console.log(`✓ etiqueta ${tags.join(" y ")}`);
} catch (e) {
  // Nada se ha subido: se deja el repositorio como estaba.
  for (const t of tags) spawnSync("git", ["tag", "-d", t], { cwd: root, stdio: "ignore" });
  // Se quita solo el commit de la versión; el resto del árbol (por ejemplo output/) no se toca.
  if (git("log", "-1", "--format=%s") === `release: ${tag}`) git("reset", "--quiet", "HEAD~1");
  if (touched.length) spawnSync("git", ["checkout", "--", ...touched], { cwd: root, stdio: "ignore" });
  fail(`No se pudo preparar la versión: ${e.stderr || e.message}`);
}
const pushed = spawnSync("git", ["push", "--atomic", "origin", "master", ...tags.map((t) => `refs/tags/${t}`)], {
  cwd: root,
  stdio: "inherit",
});
if (pushed.status !== 0) {
  fail(
    `No se pudo subir a GitHub. El commit y la etiqueta quedan en local; cuando se resuelva:\n  git push --atomic origin master ${tags.join(" ")}`,
  );
}
const repo = git("remote", "get-url", "origin").replace(/\.git$/, "").replace(/^git@github\.com:/, "https://github.com/");
console.log(`
✓ Publicado ${tag}.
  Compilación: ${repo}/actions/workflows/desktop.yml
  Release (cuando termine, unos 20–30 min): ${repo}/releases/tag/${tag}${withSessions ? `\n  Imagen del servidor de sesiones: ${repo}/actions/workflows/sessions-image.yml` : ""}`);
