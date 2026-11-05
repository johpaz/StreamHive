// Sessions server with media (LiveKit behind it, as in deploy/sessions/compose.yaml).
// Everything goes through the server's single URL (/lk), the LiveKit key never leaves it:
// - `migrate` creates the LiveKit keys and config; /api/v1/meta announces media and ports;
// - the app gets permissions only for its own room (another installation cannot manage it);
// - a guest gets camera/audio only after admission, and the host receives their video;
// - removing the guest takes them out of the room; closing the session closes the room.
// With SESSIONS_URL it tests an already running server (for example the compose), without
// starting its own.
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "sh-media-server-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (ok, message) => { if (!ok) throw Error(message); };
const free = () => new Promise((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const children = [];
const start = (file, args, env) => { const p = spawn(file, args, { env: { ...process.env, ...env }, stdio: "ignore" }); children.push(p); return p; };
const bin = process.env.BIN_DIR || join(root, "target/debug");
const livekitClient = readFileSync(join(root, "frontend/public/livekit-client.umd.js"), "utf8");
let browser, success = false;
try {
  const external = process.env.SESSIONS_URL;
  const [ownPort, lk, ownUdp, ownTcp] = await Promise.all(Array.from({ length: 4 }, free));
  const cloud = external || `http://localhost:${ownPort}`;
  const port = Number(new URL(cloud).port);
  const udp = external ? Number(process.env.MEDIA_UDP_PORT || 7882) : ownUdp, tcp = external ? Number(process.env.MEDIA_TCP_PORT || 7881) : ownTcp;
  const env = {
    PUBLIC_URL: cloud, LISTEN_ADDR: `127.0.0.1:${port}`, DATA_DIR: join(work, "data"),
    LIVEKIT_URL: `http://127.0.0.1:${lk}`, MEDIA_UDP_PORT: String(udp), MEDIA_TCP_PORT: String(tcp), MEDIA_PUBLIC_IP: "127.0.0.1",
  };
  if (!external) {
    execFileSync(join(bin, "streamhive-sessions"), ["migrate"], { env: { ...process.env, ...env }, stdio: "ignore" });
    for (const f of ["livekit.yaml", "livekit-keys.json"]) assert((statSync(join(work, "data", f)).mode & 0o077) === 0, `${f} readable by others`);
    start(join(root, "runtime/bin/livekit-server"), ["--config", join(work, "data/livekit.yaml")], {});
    start(join(bin, "streamhive-sessions"), [], env);
  }
  let meta;
  for (let i = 0; ; i++) {
    try { meta = await (await fetch(`${cloud}/api/v1/meta`)).json(); if (meta.media_ready) break; } catch {}
    assert(i < 100, "server or LiveKit did not start: " + JSON.stringify(meta)); await sleep(100);
  }
  assert(meta.media === true && meta.media_ports.udp === udp && meta.media_ports.tcp === tcp, "meta: " + JSON.stringify(meta));
  if (!external) assert(!JSON.stringify(meta).includes(JSON.parse(readFileSync(join(work, "data/livekit-keys.json"), "utf8")).secret), "secret leaked");
  console.log("OK migrate prepares LiveKit; meta announces media and ports", meta.media_ports);

  const api = async (path, { method = "GET", credential, body, cookie } = {}) => {
    const r = await fetch(`${cloud}/api/v1${path}`, { method, headers: { "content-type": "application/json", ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
  };
  const install = async () => (await api("/installations", { method: "POST" })).body;
  const a = await install(), b = await install();
  const session = (await api("/sessions/current", { method: "POST", credential: a.credential })).body.session;
  const token = (credential, body) => api("/media/token", { method: "POST", credential, body });
  const host = await token(a.credential, { identity: "host", name: "Ana", role: "publisher" });
  assert(host.status === 200 && host.body.url === `ws://localhost:${port}/lk` && host.body.room === `sh-${a.installation_id}`, "host token: " + JSON.stringify(host.body));
  for (const [body, why] of [
    [{ identity: "g-fake", name: "x", role: "publisher" }, "guest identity"],
    [{ identity: "spy", name: "x", role: "recorder" }, "recorder without EG_"],
    [{ identity: "a b", name: "x", role: "publisher" }, "invalid identity"],
    [{ identity: "host", name: "x", role: "root" }, "unknown role"],
  ]) assert((await token(a.credential, body)).status === 400, `${why} accepted`);
  assert((await token("nope", { identity: "host", role: "publisher" })).status === 401, "token without credential");
  console.log("OK the app only gets valid permissions for its room");

  // Room administration goes through /lk, limited to its own room and to a few methods.
  const twirp = (method, admin, body) => fetch(`${cloud}/lk/twirp/livekit.RoomService/${method}`, { method: "POST", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json", origin: "http://localhost:5173" }, body: JSON.stringify(body) });
  const adminA = (await token(a.credential, { role: "admin" })).body.token, adminB = (await token(b.credential, { role: "admin" })).body.token;
  const roomA = `sh-${a.installation_id}`;
  const list = async () => (await (await twirp("ListParticipants", adminA, { room: roomA })).json()).participants || [];
  assert((await twirp("ListParticipants", adminA, { room: roomA })).ok, "own room admin");
  assert(!(await twirp("ListParticipants", adminB, { room: roomA })).ok, "another installation manages the room");
  assert((await twirp("ListRooms", adminA, {})).status === 404, "ListRooms passes through the proxy");
  assert((await twirp("CreateRoom", adminA, { name: "x" })).status === 404, "CreateRoom passes through the proxy");
  console.log("OK administration only of its own room; global methods blocked");

  // Host (from another origin, like the desktop app) and guest connect with real cameras.
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  const errors = [];
  const pageAt = async (url) => {
    // bypassCSP only to inject the client; the guest portal will bundle it (same origin).
    const ctx = await browser.newContext({ permissions: ["camera", "microphone"], bypassCSP: true });
    const p = await ctx.newPage(); p.setDefaultTimeout(20000);
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(url); await p.addScriptTag({ content: livekitClient });
    return p;
  };
  const connect = (p, url, tok) => p.evaluate(async ([url, tok]) => {
    const room = new LivekitClient.Room();
    window.room = room; window.videos = 0; window.left = false;
    room.on(LivekitClient.RoomEvent.TrackSubscribed, (track) => {
      if (track.kind !== "video") return;
      const v = track.attach(); v.muted = true; document.body.append(v);
      v.addEventListener("resize", () => { if (v.videoWidth > 0) window.videos++; });
    });
    room.on(LivekitClient.RoomEvent.Disconnected, () => { window.left = true; });
    await room.connect(url, tok);
    await room.localParticipant.setCameraEnabled(true);
    return room.localParticipant.identity;
  }, [url, tok]);
  const hostPage = await pageAt(`http://127.0.0.1:${port}/healthz`);
  assert((await connect(hostPage, host.body.url, host.body.token)) === "host", "host did not connect");

  const { url: invite } = (await api(`/sessions/${session.id}/invitations`, { method: "POST", credential: a.credential, body: {} })).body;
  const guestPage = await pageAt(`${cloud}/healthz`);
  const joined = await guestPage.evaluate(async (path) => (await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Sara" }) })).json(), `/api/v1/join/${invite.split("/join/")[1]}`);
  const guestMedia = () => guestPage.evaluate(async () => { const r = await fetch("/api/v1/guest/media"); return { status: r.status, body: await r.json() }; });
  assert((await guestMedia()).status === 403, "media before admission");
  await api(`/sessions/${session.id}/participants/${joined.participant_id}`, { method: "POST", credential: a.credential, body: { action: "admit" } });
  const g = await guestMedia();
  assert(g.status === 200, "guest media after admission: " + JSON.stringify(g));
  assert((await connect(guestPage, g.body.url, g.body.token)) === `g-${joined.participant_id}`, "guest identity");
  await hostPage.waitForFunction(() => window.videos > 0);
  await guestPage.waitForFunction(() => window.videos > 0);
  const identities = (await list()).map((p) => p.identity).sort();
  assert(JSON.stringify(identities) === JSON.stringify(["g-" + joined.participant_id, "host"].sort()), "room: " + identities);
  console.log("OK guest admitted: camera in both directions through the server", identities);

  // Removing the guest takes them out of the room at once; closing the session closes it.
  await api(`/sessions/${session.id}/participants/${joined.participant_id}`, { method: "POST", credential: a.credential, body: { action: "remove" } });
  await guestPage.waitForFunction(() => window.left === true);
  assert((await guestMedia()).status === 401, "removed guest still gets media");
  for (let i = 0; (await list()).some((p) => p.identity.startsWith("g-")); i++) { assert(i < 50, "guest still in the room"); await sleep(100); }
  console.log("OK removed: out of the room and without new permissions");
  await api(`/sessions/${session.id}/close`, { method: "POST", credential: a.credential, body: {} });
  await hostPage.waitForFunction(() => window.left === true);
  console.log("OK closing the session closes the room");
  assert(!errors.length, "page errors: " + errors.join("; "));
  success = true;
  console.log("MEDIA SERVER E2E OK");
} finally {
  await browser?.close().catch(() => {});
  for (const p of children) try { p.kill("SIGKILL"); } catch {}
  if (!success) console.log("work dir:", work);
}
process.exit(success ? 0 : 1);
