import { describe, it, expect } from "bun:test";
import {
  cameraPositions,
  featuredPositions,
  visibleIdentities,
  playbackTime,
  playbackFinished,
  assetUrl,
} from "./src/composition";
import { initialProgram } from "./src/types";
import { allowedTrack } from "./src/media";
describe("technical and conversation compositions", () => {
  it("preserves 16:9 cameras inside a 16:9 program for 1–6 people", () => {
    for (let n = 1; n <= 6; n++) {
      const tiles = cameraPositions(n);
      expect(tiles).toHaveLength(n);
      for (const tile of tiles) {
        expect(tile.width / tile.height).toBeCloseTo(1);
        expect(tile.left).toBeGreaterThanOrEqual(0);
        expect(tile.top).toBeGreaterThanOrEqual(0);
        expect(tile.left + tile.width).toBeLessThanOrEqual(100);
        expect(tile.top + tile.height).toBeLessThanOrEqual(100);
      }
    }
  });
  it("keeps 1–6 portrait cameras inside the canvas without overlap", () => {
    for (let count = 1; count <= 6; count++) {
      const tiles = cameraPositions(count, "portrait");
      expect(tiles).toHaveLength(count);
      for (const [i, a] of tiles.entries()) {
        expect(a.left).toBeGreaterThanOrEqual(0);
        expect(a.top).toBeGreaterThanOrEqual(0);
        expect(a.left + a.width).toBeLessThanOrEqual(100);
        expect(a.top + a.height).toBeLessThanOrEqual(100);
        for (const b of tiles.slice(i + 1)) {
          expect(a.left + a.width <= b.left || b.left + b.width <= a.left || a.top + a.height <= b.top || b.top + b.height <= a.top).toBe(true);
        }
      }
    }
  });
  it("full content hides cameras while keeping selected microphones explicit", () => {
    const p = {
      ...initialProgram,
      layout: "screen" as const,
      content_mode: "full" as const,
      identities: ["host"],
      media_asset: "image",
    };
    expect(allowedTrack(p, "host", "camera")).toBe(false);
    expect(allowedTrack(p, "host", "microphone")).toBe(true);
    expect(
      allowedTrack({ ...p, microphones_enabled: false }, "host", "microphone"),
    ).toBe(false);
    expect(allowedTrack(p, "other", "microphone")).toBe(false);
  });
  it("uploaded media never enables a leftover shared-screen audio track", () => {
    expect(
      allowedTrack(
        {
          ...initialProgram,
          layout: "screen",
          screen: "host",
          screen_audio: true,
          media_asset: "image",
        },
        "host",
        "screen_share_audio",
      ),
    ).toBe(false);
  });
  it("playback follows server time and keeps paused positions fixed", () => {
    const playing = {
      ...initialProgram.playback,
      playing: true,
      position: 2,
      started_at_ms: 1000,
    };
    expect(playbackTime(playing, 4000, 60)).toBe(5);
    expect(playbackTime({ ...playing, playing: false }, 4000, 60)).toBe(2);
    expect(playbackTime({ ...playing, looped: true }, 14000, 10)).toBe(5);
    expect(playbackTime(playing, 999999, 10)).toBeLessThan(10);
  });
  it("a clip finishes instead of restarting unless repeat is enabled", () => {
    const p = {
      ...initialProgram.playback,
      playing: true,
      started_at_ms: 1000,
    };
    expect(playbackFinished(p, 4000, 2)).toBe(true);
    expect(playbackFinished({ ...p, looped: true }, 4000, 2)).toBe(false);
    expect(playbackFinished(p, 1500, 2)).toBe(false);
  });
  it("only renderer asset URLs carry the scoped compositor token", () => {
    expect(assetUrl("id")).toBe("/api/v1/assets/id");
    expect(assetUrl("id", "scope")).toBe(
      "/api/v1/assets/id?render_token=scope",
    );
  });
});

import { layerDimensions as ld } from "./src/composition";
describe("layerDimensions", () => {
  it("pide el tamaño real del cuadro, redondeado hacia arriba y nunca 0", () => {
    expect(ld({ width: 575.2, height: 323.9 })).toEqual({ width: 576, height: 324 });
    expect(ld({ width: 0, height: 0.2 })).toEqual({ width: 1, height: 1 });
  });
});

describe("featured layout and visible cameras", () => {
  const inside = (r: { left: number; top: number; width: number; height: number }) =>
    r.left >= 0 && r.top >= 0 && r.left + r.width <= 100.01 && r.top + r.height <= 100.01;
  const overlap = (a: any, b: any) =>
    a.left < b.left + b.width - 0.01 && b.left < a.left + a.width - 0.01 &&
    a.top < b.top + b.height - 0.01 && b.top < a.top + a.height - 0.01;
  for (const format of ["landscape", "portrait"] as const)
    for (let count = 1; count <= 6; count++)
      it(`${format} with ${count} fits without overlaps and keeps the lead largest`, () => {
        const rects = featuredPositions(count, format);
        expect(rects.length).toBe(count);
        for (const r of rects) expect(inside(r)).toBe(true);
        for (let i = 0; i < count; i++)
          for (let j = i + 1; j < count; j++) expect(overlap(rects[i], rects[j])).toBe(false);
        for (const r of rects.slice(1))
          expect(r.width * r.height).toBeLessThan(rects[0].width * rects[0].height);
      });
  it("landscape tiles stay 16:9", () => {
    for (const r of featuredPositions(6)) expect(r.width).toBe(r.height);
  });
  it("says who is visible per composition", () => {
    const base = { ...initialProgram, identities: ["a", "b", "c"], spotlight: "b" };
    expect(visibleIdentities({ ...base, layout: "grid" })).toEqual(["a", "b", "c"]);
    expect(visibleIdentities({ ...base, layout: "spotlight" })).toEqual(["b"]);
    expect(visibleIdentities({ ...base, layout: "featured" })).toEqual(["b", "a", "c"]);
    expect(visibleIdentities({ ...base, layout: "featured", spotlight: null })).toEqual(["a", "b", "c"]);
    expect(visibleIdentities({ ...base, layout: "screen", content_mode: "side" })).toEqual(["a", "b", "c"]);
    expect(visibleIdentities({ ...base, layout: "screen", content_mode: "pip" })).toEqual(["b"]);
    expect(visibleIdentities({ ...base, layout: "screen", content_mode: "full" })).toEqual([]);
  });
});
