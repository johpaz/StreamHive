// Run with `bun run dev --smoke` on a machine with Chromium installed.
// Uses synthetic camera/microphone devices; never opens physical devices.
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
const origin = `http://localhost:${process.env.STREAMHIVE_PORT || 5173}`;
const runtime = new URL("../runtime/review/", import.meta.url);
const { ADMIN_PASSWORD } = JSON.parse(
  await readFile(new URL("secrets.json", runtime), "utf8"),
);
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.BUN_CHROME_PATH || process.env.CHROMIUM_PATH || undefined,
  args: [
    "--no-sandbox",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
});
let host, guest, partial;
let originalProgram, ownedRevision, inviteId, guestId;
const uploadedAssets = [];
const guestName = `Invitado QA ${Date.now().toString(36)}`;
const errors = [];
const assert = (condition, message) => {
  if (!condition) throw Error(message);
};
try {
  host = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await host.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  await page.getByLabel("Contraseña de administrador").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Abrir mi estudio" }).click();
  await page.getByRole("heading", { name: "Mi estudio" }).waitFor();
  originalProgram = (
    await (await page.request.get(`${origin}/api/v1/studio`)).json()
  ).program;
  const reset = await page.request.put(`${origin}/api/v1/program`, {
    headers: { Origin: origin },
    data: {
      ...originalProgram,
      identities: [],
      spotlight: null,
      screen: null,
      media_asset: null,
      background_asset: null,
      layout: "grid",
      playback: { ...originalProgram.playback, playing: false },
    },
  });
  ownedRevision = (await reset.json()).revision;
  page.on("response", async (response) => {
    if (
      response.url().endsWith("/api/v1/program") &&
      response.request().method() === "PUT" &&
      response.ok()
    )
      ownedRevision = (await response.json()).revision;
  });
  await page
    .getByRole("button", { name: "Probar dispositivos", exact: true })
    .click();
  await page.getByRole("button", { name: "Probar cámara y micrófono" }).click();
  await page
    .getByText("Micrófono activo · habla para comprobar el nivel")
    .waitFor();
  await page.waitForFunction(
    () => document.querySelector(".device-camera video")?.videoWidth > 0,
  );
  assert(
    (await page.getByLabel("Micrófono de prueba").locator("option").count()) >
      1,
    "Microphone not enumerated",
  );
  assert(
    (await page.getByLabel("Cámara de prueba").locator("option").count()) > 1,
    "Camera not enumerated",
  );
  await page.getByRole("button", { name: "Conectar cámara y audio" }).click();
  await page
    .getByText("Sala conectada", { exact: true })
    .waitFor({ timeout: 20000 });
  await page.waitForFunction(
    () => document.querySelector(".participant-preview video")?.videoWidth > 0,
  );
  await page
    .getByRole("button", { name: "Añadir Anfitrión", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelector(".stage video")?.videoWidth > 0,
  );
  ownedRevision = (
    await (await page.request.get(`${origin}/api/v1/studio`)).json()
  ).program.revision;
  const inviteResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/invitations") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Invitar personas" }).click();
  const createdInvite = await (await inviteResponse).json();
  const invitation = createdInvite.url;
  inviteId = createdInvite.id;
  guest = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const guestPage = await guest.newPage();
  guestPage.on("pageerror", (error) => errors.push(error.message));
  await guestPage.goto(invitation);
  await guestPage.getByLabel("Tu nombre", { exact: true }).fill(guestName);
  await guestPage
    .getByRole("button", { name: "Entrar a la sala de espera" })
    .click();
  await guestPage
    .getByRole("heading", { name: "Ya estás en la sala de espera" })
    .waitFor();
  const waiting = await (
    await page.request.get(`${origin}/api/v1/studio`)
  ).json();
  guestId = (await (await guestPage.request.get(`${origin}/api/v1/me`)).json())
    .id;
  assert(guestId, "Guest did not enter waiting room");
  const forbidden = await guestPage.request.post(`${origin}/api/v1/token`, {
    headers: { Origin: origin },
  });
  assert(
    forbidden.status() === 403,
    "Waiting guest received media credentials",
  );
  await page
    .locator(".waiting-list")
    .getByRole("button", { name: "Admitir", exact: true })
    .click();
  await guestPage
    .getByRole("button", { name: "Conectar cámara y audio" })
    .waitFor();
  await guestPage
    .getByRole("button", { name: "Conectar cámara y audio" })
    .click();
  await guestPage
    .locator(".connection.good")
    .waitFor({ state: "attached", timeout: 20000 });
  await page
    .getByRole("button", { name: `Añadir ${guestName}`, exact: true })
    .click();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".stage video")].filter(
        (v) => v.videoWidth > 0,
      ).length === 2,
    {},
    { timeout: 20000 },
  );
  ownedRevision = (
    await (await page.request.get(`${origin}/api/v1/studio`)).json()
  ).program.revision;
  await (await import("./effects-smoke.mjs")).effectsSmoke(page, guestPage);
  // Upload a readable technical reference and exercise all content compositions.
  const imageData = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = 900;
    const c = canvas.getContext("2d");
    c.fillStyle = "#101e2b";
    c.fillRect(0, 0, 1600, 900);
    c.fillStyle = "#b5ed7d";
    c.font = "bold 54px monospace";
    c.fillText("Tutorial: una API con Rust", 70, 100);
    c.fillStyle = "#cad9e6";
    c.font = "36px monospace";
    [
      "01  async fn main() -> Result<()> {",
      "02      let router = Router::new()",
      '03          .route("/health", get(health));',
      "04      serve(listener, router).await?;",
      "05      Ok(())",
      "06  }",
    ].forEach((line, i) => c.fillText(line, 70, 230 + i * 80));
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.getByRole("tab", { name: "Archivos" }).click();
  const imageUpload = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/v1/assets") && r.request().method() === "POST",
  );
  await page.getByLabel("Subir imagen o video", { exact: true }).setInputFiles({
    name: "tutorial-rust.png",
    mimeType: "image/png",
    buffer: Buffer.from(imageData, "base64"),
  });
  const imageAsset = await (await imageUpload).json();
  assert(imageAsset.id, "Image upload failed");
  uploadedAssets.push(imageAsset.id);
  await page
    .getByLabel("Imagen de fondo del escenario")
    .selectOption(imageAsset.id);
  await guestPage.waitForFunction(
    () => document.querySelector(".stage-background")?.naturalWidth === 1600,
  );
  const protectedBackground = await page.request.delete(
    `${origin}/api/v1/assets/${imageAsset.id}`,
    { headers: { Origin: origin } },
  );
  assert(
    protectedBackground.status() === 400,
    "Selected stage background could be deleted",
  );
  await page.getByLabel("Imagen de fondo del escenario").selectOption("");
  await guestPage.locator(".stage-background").waitFor({ state: "detached" });
  await page
    .locator(".asset-card")
    .filter({ hasText: "tutorial-rust.png" })
    .getByRole("button", { name: "Mostrar", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector(".stage img.stage-asset")?.naturalWidth === 1600,
  );
  await page
    .getByRole("button", { name: "Tutorial técnico", exact: true })
    .click();
  assert(
    (await page
      .locator(".stage.content-side .stage-asset")
      .evaluate((el) => getComputedStyle(el).objectFit)) === "contain",
    "Technical content is cropped",
  );
  await page
    .getByRole("button", { name: "Cámara flotante", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Posición de cámara", exact: true })
    .selectOption("top_left");
  await page.waitForFunction(() =>
    document.querySelector(".stage.content-pip.pip-top_left"),
  );
  assert(
    (await page.locator(".stage .camera-tile").count()) === 1,
    "PIP should show one camera",
  );
  await page
    .getByRole("button", { name: "Solo contenido", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector(".stage.content-full .stage-asset")
        ?.naturalWidth === 1600,
  );
  assert(
    (await page.locator(".stage .camera-tile").count()) === 0,
    "Full content is obscured by cameras",
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: join(runtime.pathname, "studio-tutorial.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Retirar del programa", exact: true })
    .click();
  const videoData = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const c = canvas.getContext("2d");
    const stream = canvas.captureStream(12);
    const chunks = [];
    const recorder = new MediaRecorder(stream, {
      mimeType: "video/webm;codecs=vp8",
    });
    recorder.ondataavailable = (e) => chunks.push(e.data);
    let frame = 0;
    const timer = setInterval(() => {
      c.fillStyle = "#203d30";
      c.fillRect(0, 0, 640, 360);
      c.fillStyle = "#c4ef9a";
      c.font = "32px monospace";
      c.fillText("Clip de prueba " + frame++, 50, 180);
    }, 80);
    const done = new Promise((resolve) => (recorder.onstop = resolve));
    recorder.start();
    await new Promise((r) => setTimeout(r, 2000));
    recorder.stop();
    await done;
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: "video/webm" });
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.readAsDataURL(blob);
    });
  });
  const videoUpload = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/v1/assets") && r.request().method() === "POST",
  );
  await page.getByLabel("Subir imagen o video", { exact: true }).setInputFiles({
    name: "clip-prueba.webm",
    mimeType: "video/webm",
    buffer: Buffer.from(videoData, "base64"),
  });
  const videoAsset = await (await videoUpload).json();
  assert(videoAsset.id, "Video upload failed");
  uploadedAssets.push(videoAsset.id);
  await page
    .locator(".asset-card")
    .filter({ hasText: "clip-prueba.webm" })
    .getByRole("button", { name: "Mostrar", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelector(".stage video.stage-asset")?.readyState >= 2,
  );
  assert(
    await page.locator(".stage video.stage-asset").evaluate((v) => v.paused),
    "Video must enter paused",
  );
  await page
    .getByRole("button", { name: "Reproducir video", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector(".stage video.stage-asset")?.currentTime > 0.25,
  );
  await page.getByRole("button", { name: "Pausar video", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".stage video.stage-asset")?.paused,
  );
  await page
    .getByRole("slider", { name: "Posición del video", exact: true })
    .press("Home");
  await page.waitForFunction(
    () => document.querySelector(".stage video.stage-asset")?.currentTime < 0.1,
  );
  await page
    .getByRole("button", { name: "Reiniciar video", exact: true })
    .click();
  await page.waitForFunction(
    () => {
      const video = document.querySelector(".stage video.stage-asset");
      return video && !video.paused && video.currentTime > 0.25;
    },
    {},
    { timeout: 10000 },
  );
  await page.waitForFunction(
    () => {
      const video = document.querySelector(".stage video.stage-asset");
      return video && video.paused && video.currentTime >= video.duration - 0.1;
    },
    {},
    { timeout: 10000 },
  );
  await page
    .getByRole("button", { name: "Reproducir video", exact: true })
    .waitFor({ timeout: 10000 });
  const endTime = await page
    .locator(".stage video.stage-asset")
    .evaluate((video) => video.currentTime);
  await page.waitForTimeout(700);
  assert(
    await page
      .locator(".stage video.stage-asset")
      .evaluate(
        (video) => video.paused && video.currentTime >= video.duration - 0.1,
      ),
    "A completed clip started again without repeat",
  );
  assert(endTime > 0.5, "Video stopped before its end");
  const retiredVideo = await page
    .locator(".stage video.stage-asset")
    .elementHandle();
  await page
    .getByRole("button", { name: "Retirar del programa", exact: true })
    .click();
  await page.waitForFunction(
    () => !document.querySelector(".stage video.stage-asset"),
  );
  await page.waitForFunction(
    (video) => video.paused && !video.hasAttribute("src"),
    retiredVideo,
  );
  assert(
    await retiredVideo.evaluate(
      (video) => video.paused && !video.hasAttribute("src"),
    ),
    "Retired video is still active",
  );
  await page.getByRole("button", { name: "Conversación", exact: true }).click();
  const tiles = await page.locator(".stage .camera-tile").evaluateAll((tiles) =>
    tiles.map((tile) => {
      const r = tile.getBoundingClientRect();
      return r.width / r.height;
    }),
  );
  assert(
    tiles.length === 2 && tiles.every((r) => Math.abs(r - 16 / 9) < 0.02),
    "Two cameras lose their aspect ratio",
  );
  ownedRevision = (
    await (await page.request.get(`${origin}/api/v1/studio`)).json()
  ).program.revision;
  await page.getByRole("tab", { name: "Participantes" }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  assert(
    (await page
      .locator(".composition-bar button[aria-pressed=true]")
      .count()) === 1,
    "More than one composition is selected",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    !(await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    )),
    "Mobile producer page overflows",
  );
  await page
    .locator(".mobile-navigation")
    .getByRole("button", { name: "Configuración", exact: true })
    .click();
  await page.getByRole("heading", { name: "Destino de transmisión" }).waitFor();
  await page
    .locator(".mobile-navigation")
    .getByRole("button", { name: "Estudio", exact: true })
    .click();
  await page.getByRole("heading", { name: "Mi estudio" }).waitFor();
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: join(runtime.pathname, "smoke-desktop.png"),
    fullPage: true,
  });
  await guestPage.screenshot({
    path: join(runtime.pathname, "smoke-mobile.png"),
    fullPage: true,
  });
  assert(
    !(await guestPage.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    )),
    "Mobile page overflows",
  );
  // A denied microphone must not prevent the private camera preview from working.
  partial = await browser.newContext();
  await partial.addInitScript(() => {
    const actual = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = (constraints) =>
      constraints?.audio
        ? Promise.reject(new DOMException("Denied for test", "NotAllowedError"))
        : actual(constraints);
  });
  const partialPage = await partial.newPage();
  await partialPage.goto(invitation);
  await partialPage
    .getByRole("button", { name: "Probar cámara y micrófono" })
    .click();
  await partialPage
    .getByText("Permiso de micrófono denegado.", { exact: false })
    .waitFor();
  await partialPage.waitForFunction(
    () => document.querySelector(".device-camera video")?.videoWidth > 0,
  );
  assert(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
  console.log(
    "Browser smoke passed: private preview, enumeration, microphone denial, real LiveKit connection, guest admission, two WebRTC cameras, image upload, video play/pause, technical layouts, preserved aspect ratio, mobile layout.",
  );
} catch (error) {
  console.error("Browser smoke failure:", error.message);
  if (host?.pages()[0]) {
    const page = host.pages()[0];
    console.error(
      "Visible page:",
      (await page.locator("body").innerText()).slice(-5000),
    );
    await page.screenshot({
      path: join(runtime.pathname, "smoke-failed.png"),
      fullPage: true,
    });
  }
  throw error;
} finally {
  if (host) {
    const page = host.pages()[0];
    if (page) {
      if (originalProgram && ownedRevision !== undefined) {
        const current = await (
          await page.request.get(`${origin}/api/v1/studio`)
        ).json();
        if (current.program.revision === ownedRevision)
          await page.request.put(`${origin}/api/v1/program`, {
            headers: { Origin: origin },
            data: { ...originalProgram, revision: current.program.revision },
          });
      }
      for (const assetId of uploadedAssets)
        await page.request.delete(`${origin}/api/v1/assets/${assetId}`, {
          headers: { Origin: origin },
        });
      if (guestId)
        await page.request.post(`${origin}/api/v1/participants/${guestId}`, {
          headers: { Origin: origin },
          data: { action: "remove" },
        });
      if (inviteId)
        await page.request.delete(`${origin}/api/v1/invitations/${inviteId}`, {
          headers: { Origin: origin },
        });
    }
  }
  await browser.close();
}
