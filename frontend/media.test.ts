import { describe, it, expect } from "bun:test";
import { allowedTrack } from "./src/media";
import { initialProgram } from "./src/types";
describe("program isolation", () => {
  const program = { ...initialProgram, identities: ["host", "guest-a"] };
  it("never subscribes to backstage audio or video", () => {
    for (const source of [
      "microphone",
      "camera",
      "screen_share",
      "screen_share_audio",
    ])
      expect(allowedTrack(program, "backstage", source)).toBe(false);
  });
  it("includes stage microphones independently of visible spotlight", () => {
    const p = { ...program, layout: "spotlight" as const, spotlight: "host" };
    expect(allowedTrack(p, "guest-a", "microphone")).toBe(true);
    expect(allowedTrack(p, "guest-a", "camera")).toBe(false);
    expect(allowedTrack(p, "host", "camera")).toBe(true);
  });
  it("requires explicit screen audio opt-in", () => {
    const p = { ...program, layout: "screen" as const, screen: "screen-guest" };
    expect(allowedTrack(p, "screen-guest", "screen_share")).toBe(true);
    expect(allowedTrack(p, "screen-guest", "screen_share_audio")).toBe(false);
    expect(
      allowedTrack(
        { ...p, screen_audio: true },
        "screen-guest",
        "screen_share_audio",
      ),
    ).toBe(true);
    expect(
      allowedTrack({ ...p, screen_audio: true }, "screen-guest", "microphone"),
    ).toBe(false);
  });
  it("does not leak a previously selected screen in another layout", () => {
    const p = { ...program, screen: "host", screen_audio: true };
    expect(allowedTrack(p, "host", "screen_share")).toBe(false);
    expect(allowedTrack(p, "host", "screen_share_audio")).toBe(false);
  });
  it("unknown source types default to denied", () => {
    expect(allowedTrack(program, "host", "unknown")).toBe(false);
  });
});
