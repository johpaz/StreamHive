// Isolated browser coverage; no camera, microphone, real credentials or destinations.
// Prerequisites: frontend build, guest bundle, cargo build --workspace.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "streamhive-chat-"));
const assert = (ok, msg) => {
  if (!ok) throw Error(msg);
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const free = () =>
  new Promise((r) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });
const port = await free(),
  remotePort = await free();
const origin = `http://localhost:${port}`,
  remoteOrigin = `http://localhost:${remotePort}`;
const children = [],
  errors = [],
  logs = [];
let browser;
const launch = (bin, env) => {
  const p = spawn(join(root, "target/debug", bin), [], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout.on("data", (d) => logs.push(d.toString()));
  p.stderr.on("data", (d) => logs.push(d.toString()));
  children.push(p);
  return p;
};
const ready = async (url) => {
  for (let n = 0; n < 100; n++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await delay(100);
  }
  throw Error(`Unavailable ${url}\n${logs.join("")}`);
};
// A control-only fake suffices: the chat does not depend on multimedia.
const media = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => Response.json({ participants: [] }),
});
try {
  launch("streamhive", {
    DATA_DIR: join(work, "local"),
    RECORDINGS_DIR: join(work, "recordings"),
    STATIC_DIR: join(root, "frontend/dist"),
    LISTEN_ADDR: `127.0.0.1:${port}`,
    PUBLIC_ORIGIN: origin,
    ADMIN_PASSWORD: "isolated-chat-test-password",
    SESSION_SECRET: randomBytes(32).toString("hex"),
    MASTER_KEY: randomBytes(32).toString("base64"),
    LIVEKIT_INTERNAL_URL: `http://127.0.0.1:${media.port}`,
    LIVEKIT_API_KEY: "chat-test",
    LIVEKIT_API_SECRET: randomBytes(32).toString("hex"),
    ENGINE: "egress",
  });
  launch("streamhive-sessions", {
    DATA_DIR: join(work, "remote"),
    LISTEN_ADDR: `127.0.0.1:${remotePort}`,
    PUBLIC_URL: remoteOrigin,
  });
  await Promise.all([
    ready(origin + "/healthz"),
    ready(remoteOrigin + "/healthz"),
  ]);
  const cache = join(homedir(), ".cache/ms-playwright");
  const cached = existsSync(cache)
    ? readdirSync(cache)
        .filter((n) => /^chromium-\d+$/.test(n))
        .sort()
        .reverse()
        .map((n) => join(cache, n, "chrome-linux64/chrome"))
        .find(existsSync)
    : undefined;
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROMIUM_PATH ||
      (existsSync(chromium.executablePath()) ? undefined : cached),
    args: ["--no-sandbox"],
  });
  const host = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await host.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const request = async (ctx, base, path, data, method = "post") => {
    const r = await ctx.request[method](base + "/api/v1" + path, {
      headers: { Origin: base },
      ...(data === undefined ? {} : { data }),
    });
    assert(r.ok(), `${method} ${path}: ${r.status()} ${await r.text()}`);
    return r.json();
  };
  await page.goto(origin);
  await page
    .getByLabel("Contraseña de administrador")
    .fill("isolated-chat-test-password");
  await page.getByRole("button", { name: "Abrir mi estudio" }).click();
  await page
    .getByRole("button", { name: "Abrir chat general", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Nueva conversación local" })
    .waitFor();
  const medium = await page.locator(".chat-window").boundingBox();
  assert(medium.width === 360 && medium.height === 480, "medium dimensions");
  await page.getByLabel("Mensaje para todos").fill("Borrador que se conserva");
  await page.getByLabel("Ampliar chat a pantalla completa").click();
  await page.getByRole("dialog", { name: "Chat general" }).waitFor();
  assert(
    await page.locator("#root").evaluate((el) => el.inert),
    "full focus isolation",
  );
  const full = await page.locator(".chat-window").boundingBox();
  assert(full.width === 1440 && full.height === 1000, "full dimensions");
  await page.screenshot({ path: join(work, "full.png") });
  await page.keyboard.press("Escape");
  assert(
    (await page.getByLabel("Mensaje para todos").inputValue()) ===
      "Borrador que se conserva",
    "full draft retention",
  );
  assert(
    !(await page.locator("#root").evaluate((el) => el.inert)),
    "focus isolation restored",
  );
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Abrir chat general", exact: true })
    .click();
  assert(
    (await page.getByLabel("Mensaje para todos").inputValue()) ===
      "Borrador que se conserva",
    "reduced draft retention",
  );
  await page.getByLabel("Mensaje para todos").fill("");
  const invite = await request(host, origin, "/invitations", {}),
    token = invite.url.split("/").at(-1);
  const guests = [];
  for (const name of ["Ana QA", "Luis QA"]) {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    const who = await request(ctx, origin, "/join", { token, name });
    await p.goto(origin);
    // La sala de espera también usa el chat para coordinar el ingreso.
    await p
      .getByRole("button", { name: "Abrir chat general", exact: true })
      .click();
    const early = `${name} espera su turno`;
    await p.getByLabel("Mensaje para todos").fill(early);
    await p.getByRole("button", { name: "Enviar", exact: true }).click();
    const seen = page.locator(".chat-message").filter({ hasText: early });
    await seen.waitFor();
    assert(
      (await seen.locator(".chat-waiting").textContent()) ===
        "En sala de espera",
      "waiting guest tagged for the host",
    );
    await p.getByLabel("Reducir chat").click();
    await request(host, origin, `/participants/${who.id}`, { action: "admit" });
    await p
      .getByRole("button", { name: "Abrir chat general", exact: true })
      .click();
    guests.push({ ctx, p, id: who.id, name });
  }
  const [ana, luis] = guests;
  const localSendTime = Date.now();
  await page
    .getByLabel("Mensaje para todos")
    .fill("Hola equipo 🐝 <b>texto</b>");
  await page.getByRole("button", { name: "Enviar", exact: true }).click();
  await Promise.all(
    guests.map((g) =>
      g.p.getByText("Hola equipo 🐝 <b>texto</b>", { exact: true }).waitFor(),
    ),
  );
  assert(
    Date.now() - localSendTime < 2500,
    "local notifications are realtime rather than poll-only",
  );
  assert(
    (await ana.p.locator(".chat-message b").count()) === 0,
    "text is not interpreted as HTML",
  );
  await page.getByLabel("Reducir chat").click();
  await ana.p.getByLabel("Mensaje para todos").fill("Mensaje de Ana");
  await ana.p.getByRole("button", { name: "Enviar", exact: true }).click();
  await page
    .getByRole("button", { name: /Abrir chat general, 1 mensajes sin leer/ })
    .waitFor();
  await page.getByRole("button", { name: /Abrir chat general/ }).click();
  await luis.p.getByLabel("Mensaje para todos").fill("Mensaje de Luis");
  await luis.p.getByRole("button", { name: "Enviar", exact: true }).click();
  await page.getByText("Mensaje de Luis", { exact: true }).waitFor();
  await page.screenshot({ path: join(work, "medium.png") });
  const overlap = await page.evaluate(() => {
    const bar = document.querySelector(".workspace-broadcast-bar");
    const box = document.querySelector(".chat-window");
    if (!bar || !box) return null;
    const a = bar.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    return {
      gap: a.top - b.bottom,
      horizontal: b.left < a.right && b.right > a.left,
    };
  });
  assert(
    overlap && (!overlap.horizontal || overlap.gap >= 0),
    `chat window must not cover the broadcast bar: ${JSON.stringify(overlap)}`,
  );
  await ana.p.screenshot({ path: join(work, "mobile.png") });
  await ana.p.reload();
  await ana.p
    .getByRole("button", { name: "Abrir chat general", exact: true })
    .click();
  await ana.p.getByText("Mensaje de Luis", { exact: true }).waitFor();
  // Recover a deletion missed while the guest was disconnected.
  await ana.ctx.setOffline(true);
  await page
    .locator(".chat-message")
    .filter({ hasText: "Mensaje de Luis" })
    .getByRole("button", { name: /Borrar mensaje/ })
    .click();
  await ana.ctx.setOffline(false);
  await ana.p
    .getByText("Mensaje eliminado", { exact: true })
    .waitFor({ timeout: 12000 });
  assert(
    (await ana.p.getByText("Mensaje de Luis", { exact: true }).count()) === 0,
    "deletion recovered",
  );
  // Preserve a failed send and retry with the same client identifier.
  await luis.ctx.setOffline(true);
  await luis.p.getByLabel("Mensaje para todos").fill("Reintento único");
  await luis.p.getByRole("button", { name: "Enviar", exact: true }).click();
  await luis.p.getByRole("button", { name: "Reintentar envío" }).waitFor();
  await luis.ctx.setOffline(false);
  await luis.p.getByRole("button", { name: "Reintentar envío" }).click();
  await page
    .getByText("Reintento único", { exact: true })
    .waitFor({ timeout: 12000 });
  assert(
    (await page.getByText("Reintento único", { exact: true }).count()) === 1,
    "retry deduplicated",
  );
  // A tall message provides enough scroll space without bypassing production rate limits.
  await page
    .getByLabel("Mensaje para todos")
    .fill("Contenido largo\n".repeat(70));
  await page.getByRole("button", { name: "Enviar", exact: true }).click();
  await ana.p.getByText(/Contenido largo/).waitFor();
  await ana.p.locator(".chat-messages").evaluate((el) => {
    el.scrollTop = 40;
    el.dispatchEvent(new Event("scroll"));
  });
  const scroll = await ana.p
    .locator(".chat-messages")
    .evaluate((el) => el.scrollTop);
  await ana.p.getByLabel("Reducir chat").click();
  await ana.p.getByRole("button", { name: /Abrir chat general/ }).click();
  assert(
    Math.abs(
      (await ana.p.locator(".chat-messages").evaluate((el) => el.scrollTop)) -
        scroll,
    ) < 2,
    "reader scroll retained",
  );
  // Mobile sizing, reduced motion and full keyboard navigation.
  const mobile = await ana.p.locator(".chat-window").boundingBox();
  assert(
    mobile.width <= 366 && mobile.height <= 844 * 0.7,
    "mobile panel fits",
  );
  await ana.p.emulateMedia({ reducedMotion: "reduce" });
  assert(
    (await ana.p
      .locator(".chat-header .chat-bee")
      .evaluate((el) => getComputedStyle(el).animationName)) === "none",
    "reduced motion",
  );
  await ana.p.getByLabel("Ampliar chat a pantalla completa").click();
  await ana.p.keyboard.press("Escape");
  assert(
    !(await ana.p.locator("#root").evaluate((el) => el.inert)),
    "mobile focus restored",
  );
  // Rotation clears all clients and rejects stale sends.
  await page.getByRole("button", { name: "Nueva conversación local" }).click();
  await page
    .getByRole("button", { name: "Nueva conversación", exact: true })
    .click();
  await page
    .getByText("La conversación empieza aquí", { exact: true })
    .waitFor();
  await ana.p
    .getByText("La conversación empieza aquí", { exact: true })
    .waitFor({ timeout: 12000 });
  // Removing an admitted guest may fail the fake multimedia kick, but authorization
  // is persisted before that external call, so verify the actual chat decision.
  await host.request.post(origin + `/api/v1/participants/${luis.id}`, {
    headers: { Origin: origin },
    data: { action: "remove" },
  });
  await luis.p
    .locator(".studio-chat")
    .waitFor({ state: "detached", timeout: 12000 });
  assert(
    (await luis.ctx.request.get(origin + "/api/v1/chat/messages")).status() ===
      401,
    "removed guest denied",
  );
  // Remote host uses its local backend; guests use the separate public portal.
  await request(host, origin, "/remote-server", { url: remoteOrigin }, "put");
  await request(host, origin, "/remote-session", {});
  const invitation = await request(
    host,
    origin,
    "/remote-session/invitations",
    {},
  );
  const remoteGuests = [];
  for (const name of ["Remota Ana", "Remoto Luis"]) {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(invitation.url);
    await p.getByLabel("Tu nombre").fill(name);
    await p.getByRole("button", { name: "Solicitar entrada" }).click();
    await p.getByText("Esperando al anfitrión", { exact: true }).waitFor();
    await p
      .getByRole("button", { name: "Abrir chat general", exact: true })
      .click();
    await p.getByLabel("Mensaje para todos").fill(`${name} en espera`);
    await p.getByRole("button", { name: "Enviar", exact: true }).click();
    await p
      .locator(".chat-message:not(.chat-pending)")
      .filter({ hasText: `${name} en espera` })
      .waitFor();
    await p.getByLabel("Reducir chat").click();
    const state = await request(
      host,
      origin,
      "/remote-server",
      undefined,
      "get",
    );
    const person = state.snapshot.participants.find((p) => p.name === name);
    assert(person, "remote guest found");
    await request(host, origin, `/remote-session/participants/${person.id}`, {
      action: "admit",
    });
    await p
      .getByRole("button", { name: "Abrir chat general", exact: true })
      .click();
    remoteGuests.push({ ctx, p, id: person.id });
  }
  // Wait for the host to switch away from the previous local conversation.
  await page
    .getByRole("button", { name: "Nueva conversación local" })
    .waitFor({ state: "detached", timeout: 12000 });
  const remoteEarly = page
    .locator(".chat-message")
    .filter({ hasText: "Remota Ana en espera" });
  await remoteEarly.waitFor();
  assert(
    (await remoteEarly.locator(".chat-waiting").count()) === 1,
    "remote waiting guest tagged for the host",
  );
  const remoteSendTime = Date.now();
  await page
    .getByLabel("Mensaje para todos")
    .fill("Hola desde el escritorio remoto");
  await page.getByRole("button", { name: "Enviar", exact: true }).click();
  await Promise.all(
    remoteGuests.map((g) =>
      g.p
        .getByText("Hola desde el escritorio remoto", { exact: true })
        .waitFor({ timeout: 12000 }),
    ),
  );
  assert(
    Date.now() - remoteSendTime < 2500,
    "remote notifications are realtime rather than poll-only",
  );
  await remoteGuests[0].p
    .getByLabel("Mensaje para todos")
    .fill("Hola desde el portal");
  await remoteGuests[0].p
    .getByRole("button", { name: "Enviar", exact: true })
    .click();
  await page.getByText("Hola desde el portal", { exact: true }).waitFor();
  await remoteGuests[1].p
    .getByText("Hola desde el portal", { exact: true })
    .waitFor();
  await remoteGuests[0].p.screenshot({ path: join(work, "remote-mobile.png") });
  assert(
    (await page
      .locator(".chat-message.chat-own")
      .filter({ hasText: "Hola desde el escritorio remoto" })
      .count()) === 1,
    "remote host identity matches sender",
  );
  await request(
    host,
    origin,
    `/remote-session/participants/${remoteGuests[1].id}`,
    { action: "remove" },
  );
  await remoteGuests[1].p
    .locator(".studio-chat")
    .waitFor({ state: "detached" });
  await request(host, origin, "/remote-session", undefined, "delete");
  await remoteGuests[0].p
    .locator(".studio-chat")
    .waitFor({ state: "detached" });
  assert(errors.length === 0, `Browser errors: ${errors.join(", ")}`);
  console.log(
    JSON.stringify({
      ok: true,
      artifacts: work,
      scenarios: [
        "three sizes",
        "bee",
        "local host + two guests + waiting room",
        "remote bridge + two guests + waiting room",
        "text safety",
        "unread",
        "reload",
        "offline deletion",
        "retry",
        "scroll",
        "mobile",
        "reduced motion",
        "rotation",
        "removal",
        "closure",
      ],
    }),
  );
} catch (e) {
  writeFileSync(join(work, "services.log"), logs.join(""));
  console.error(`Artifacts: ${work}`);
  throw e;
} finally {
  await browser?.close();
  media.stop(true);
  for (const p of children) p.kill("SIGTERM");
}
