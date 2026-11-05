import { describe, expect, it } from "bun:test";
import { fitRect, pickMime } from "./src/compositor";

const box = { left: 100, top: 50, width: 400, height: 200 };
describe("fitRect", () => {
  it("cover recorta el origen centrado para llenar la caja", () => {
    const f = fitRect("cover", 1000, 1000, box);
    expect(f.sw).toBe(1000);
    expect(f.sh).toBe(500);
    expect(f.sy).toBe(250);
    expect([f.dx, f.dy, f.dw, f.dh]).toEqual([100, 50, 400, 200]);
  });
  it("contain centra sin recortar", () => {
    const f = fitRect("contain", 1000, 1000, box);
    expect([f.dw, f.dh]).toEqual([200, 200]);
    expect([f.dx, f.dy]).toEqual([200, 50]);
    expect([f.sx, f.sy, f.sw, f.sh]).toEqual([0, 0, 1000, 1000]);
  });
  it("fill estira y tolera origen vacío", () => {
    expect(fitRect("fill", 10, 10, box).dw).toBe(400);
    expect(fitRect("cover", 0, 0, box).dw).toBe(400);
  });
});
describe("pickMime", () => {
  it("prefiere WebM y cae a MP4 en WebKit", () => {
    expect(pickMime(() => true, null)).toBe("video/webm;codecs=h264,opus");
    expect(pickMime((m) => !m.includes("h264"), null)).toBe("video/webm;codecs=vp8,opus");
    expect(pickMime(() => true, "vp9")).toBe("video/webm;codecs=vp9,opus");
    expect(pickMime((m) => !m.includes("vp9"), "vp9")).toBe("video/webm;codecs=h264,opus");
    expect(pickMime((m) => m.startsWith("video/mp4"), null)).toBe(
      "video/mp4;codecs=avc1,mp4a.40.2",
    );
    expect(pickMime(() => false, null)).toBe("");
  });
});
