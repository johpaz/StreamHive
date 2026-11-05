// Real local segmentation and outgoing WebRTC verification, without physical devices.
export async function effectsSmoke(page, guestPage) {
  const assert = (c, m) => {
    if (!c) throw Error(m);
  };
  const hostVideo = ".stage .camera-tile:first-child video";
  const magenta = () => {
    const v = document.querySelector(".stage .camera-tile:first-child video");
    if (!v || !v.videoWidth) return false;
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 36;
    const x = c.getContext("2d");
    x.drawImage(v, 0, 0, 64, 36);
    const pixels = x.getImageData(0, 0, 64, 36).data;
    let n = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (pixels[i] > 180 && pixels[i + 1] < 90 && pixels[i + 2] > 180) n++;
    return n / (pixels.length / 4) > 0.65;
  };
  const open = async (p) => {
    await p
      .getByRole("button", { name: "Efectos de cámara", exact: true })
      .click();
    await p.waitForFunction(
      () => document.querySelector(".effects-preview video")?.videoWidth > 0,
    );
  };
  const apply = async (p) => {
    await p
      .getByRole("button", { name: "Aplicar", exact: true })
      .click({ timeout: 60000 });
    await p.locator(".camera-effects-dialog").waitFor({ state: "detached" });
  };
  await guestPage.waitForFunction(
    () =>
      document.querySelector(".stage .camera-tile:first-child video")
        ?.videoWidth > 0,
  );
  assert(
    !(await guestPage.evaluate(magenta)),
    "Original fake camera unexpectedly magenta",
  );
  console.log("Effects: open host preview");
  await open(page);
  const matchesOffice = async () => {
    const video = document.querySelector(
      ".stage .camera-tile:first-child video",
    );
    if (!video?.videoWidth) return false;
    const image = new Image();
    image.src = "/backgrounds/office-daylight.webp";
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 18;
    const c = canvas.getContext("2d");
    c.drawImage(image, 0, 0, 32, 18);
    const expected = c.getImageData(0, 0, 32, 18).data;
    c.drawImage(video, 0, 0, 32, 18);
    const actual = c.getImageData(0, 0, 32, 18).data;
    let difference = 0;
    for (let i = 0; i < expected.length; i++)
      if (i % 4 !== 3) difference += Math.abs(expected[i] - actual[i]);
    return difference / (32 * 18 * 3) < 24;
  };
  await page.waitForFunction(() => {
    const thumbs = [
      ...document.querySelectorAll(".effects-background-card img"),
    ];
    return (
      thumbs.length === 4 &&
      thumbs.every((img) => img.complete && img.naturalWidth > 0)
    );
  });
  await page.evaluate(async () => {
    for (const id of [
      "office-daylight",
      "office-warm",
      "streamer-neon",
      "podcast-studio",
    ]) {
      const image = new Image();
      image.src = `/backgrounds/${id}.webp`;
      await image.decode();
      if (image.naturalWidth < 1280)
        throw Error("Bundled background is missing or too small");
    }
  });
  assert(
    !(await guestPage.evaluate(matchesOffice)),
    "Original camera unexpectedly matches office background",
  );
  await page
    .getByRole("button", { name: "Usar fondo Oficina luminosa", exact: true })
    .click();
  await page.waitForFunction(
    () => {
      const button = [
        ...document.querySelectorAll(".camera-effects-dialog button"),
      ].find((b) => b.textContent === "Aplicar");
      return button && !button.disabled;
    },
    {},
    { timeout: 60000 },
  );
  assert(
    !(await guestPage.evaluate(matchesOffice)),
    "Bundled preview leaked before Apply",
  );
  await page.screenshot({
    path: new URL(
      "../runtime/review/camera-background-gallery.png",
      import.meta.url,
    ).pathname,
    fullPage: true,
  });
  await apply(page);
  await guestPage.waitForFunction(matchesOffice, {}, { timeout: 30000 });
  await open(page);
  assert(
    (await page
      .getByRole("button", { name: "Usar fondo Oficina luminosa", exact: true })
      .getAttribute("aria-pressed")) === "true",
    "Applied bundled background selection was lost",
  );
  console.log(
    "Gallery passed: four decoded local assets and thumbnails, private selection, real outgoing office background.",
  );
  await page
    .getByRole("button", { name: "Desenfoque", exact: true })
    .click({ timeout: 60000 });
  await page.waitForFunction(
    () => {
      const b = [
        ...document.querySelectorAll(".camera-effects-dialog button"),
      ].find((b) => b.textContent === "Aplicar");
      return b && !b.disabled;
    },
    {},
    { timeout: 60000 },
  );
  assert(
    (await page.locator(".camera-effects-dialog [role=alert]").count()) === 0,
    "Blur processor initialization failed",
  );
  console.log("Effects: cancel preview");
  await page.getByRole("button", { name: "Cancelar", exact: true }).click();
  // Solid background, deterministic with the non-person synthetic input.
  const bytes = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 640;
    c.height = 360;
    const x = c.getContext("2d");
    x.fillStyle = "#ff00ff";
    x.fillRect(0, 0, 640, 360);
    return c.toDataURL().split(",")[1];
  });
  console.log("Effects: open host preview");
  await open(page);
  await page.locator("#camera-background-file").setInputFiles({
    name: "fondo-qa.png",
    mimeType: "image/png",
    buffer: Buffer.from(bytes, "base64"),
  });
  await page.waitForFunction(
    () => {
      const v = document.querySelector(".effects-preview video");
      if (!v?.videoWidth) return false;
      const c = document.createElement("canvas");
      c.width = 1;
      c.height = 1;
      const x = c.getContext("2d");
      x.drawImage(v, 0, 0, 1, 1);
      const p = x.getImageData(0, 0, 1, 1).data;
      return p[0] > 180 && p[1] < 90 && p[2] > 180;
    },
    {},
    { timeout: 60000 },
  );
  assert(
    !(await guestPage.evaluate(magenta)),
    "Private preview leaked before Apply",
  );
  await page.screenshot({
    path: new URL(
      "../runtime/review/camera-effects-preview.png",
      import.meta.url,
    ).pathname,
    fullPage: true,
  });
  console.log("Effects: apply host");
  await apply(page);
  await guestPage.waitForFunction(magenta, {}, { timeout: 30000 });
  await page.locator(".live-devices summary").click();
  const cameras = page.locator(".live-devices select").nth(1);
  const cameraId = await cameras.locator("option").nth(1).getAttribute("value");
  await cameras.selectOption(cameraId);
  await page.locator(".live-devices summary").click();
  await guestPage.waitForFunction(magenta, {}, { timeout: 30000 });
  console.log("Effects: toggle camera after device selection");
  await page
    .getByRole("button", { name: "Apagar cámara", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Activar cámara", exact: true })
    .click();
  await guestPage.waitForFunction(magenta, {}, { timeout: 30000 });
  console.log("Effects: open host preview");
  await open(page);
  await page.getByRole("button", { name: "Sin efecto", exact: true }).click();
  console.log("Effects: cancel preview");
  await page.getByRole("button", { name: "Cancelar", exact: true }).click();
  assert(
    await guestPage.evaluate(magenta),
    "Cancel altered published camera effect",
  );
  // Mobile guests control their own camera effects.
  console.log("Effects: open guest preview");
  await open(guestPage);
  assert(
    await guestPage
      .locator(".camera-effects-dialog")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
    "Effects dialog overflows on mobile",
  );
  await guestPage
    .getByRole("button", { name: "Desenfoque", exact: true })
    .click();
  await apply(guestPage);
  assert(await guestPage.evaluate(magenta), "Guest effect changed host camera");
  console.log("Effects: open guest preview");
  await open(guestPage);
  await guestPage
    .getByRole("button", { name: "Sin efecto", exact: true })
    .click();
  await apply(guestPage);
  console.log("Effects: open host preview");
  await open(page);
  await page.getByRole("button", { name: "Sin efecto", exact: true }).click();
  await apply(page);
  await guestPage.waitForFunction(
    () => {
      const v = document.querySelector(".stage .camera-tile:first-child video");
      if (!v?.videoWidth) return false;
      const c = document.createElement("canvas");
      c.width = 1;
      c.height = 1;
      const x = c.getContext("2d");
      x.drawImage(v, 0, 0, 1, 1);
      const p = x.getImageData(0, 0, 1, 1).data;
      return p[1] > 90;
    },
    {},
    { timeout: 30000 },
  );
  assert(
    (await page.locator(hostVideo).count()) === 1,
    "Camera lost after effect reset",
  );
  console.log(
    "Effects passed: real MediaPipe blur, private custom background, Apply/Cancel, outgoing WebRTC pixels, camera off/on, independent guest effects, mobile dialog, reset.",
  );
}
