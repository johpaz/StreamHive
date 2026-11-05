import { expect, it } from "bun:test";
import {
  effectOptions,
  configureCameraEffect,
  noCameraEffect,
  readCameraBackground,
} from "./src/camera-effects";
import type { LocalCameraTrack } from "./src/media";
it("rejects screen tracks before loading any camera processor", async () => {
  await expect(
    configureCameraEffect({ source: "screen_share" } as LocalCameraTrack, {
      ...noCameraEffect,
      mode: "background-blur",
    }),
  ).rejects.toThrow("solo se aplican a la cámara");
});
it("rejects unsupported and oversized images without allocating browser resources", async () => {
  await expect(
    readCameraBackground(
      new File(["text"], "image.svg", { type: "image/svg+xml" }),
    ),
  ).rejects.toThrow("PNG, JPG o WebP");
  await expect(
    readCameraBackground(
      new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.png", {
        type: "image/png",
      }),
    ),
  ).rejects.toThrow("5 MB");
});

it("allows only bundled backgrounds or local uploads, rejecting arbitrary image URLs", () => {
  expect(
    effectOptions({
      ...noCameraEffect,
      mode: "virtual-background",
      imageUrl: "/backgrounds/office-daylight.webp",
    }).imagePath,
  ).toBe("/backgrounds/office-daylight.webp");
  expect(
    effectOptions({
      ...noCameraEffect,
      mode: "virtual-background",
      imageUrl: "blob:http://localhost/custom",
    }).imagePath,
  ).toBe("blob:http://localhost/custom");
  for (const imageUrl of [
    "https://example.com/background.png",
    "/api/v1/assets/arbitrary",
    "/backgrounds/../secret",
    "/backgrounds/missing.webp",
  ]) {
    expect(() =>
      effectOptions({
        ...noCameraEffect,
        mode: "virtual-background",
        imageUrl,
      }),
    ).toThrow("galería");
  }
});
