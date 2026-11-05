import { describe, expect, it } from "bun:test";
import { AUTO, QUALITIES, describeCaps, describeSettings, isQualityId, loadQuality, pickQuality, supports } from "./src/camera-quality";

const hd = { width: { max: 1280 }, height: { max: 720 }, frameRate: { max: 30 } };
const fourK = { width: { max: 3840 }, height: { max: 2160 }, frameRate: { max: 30 } };

describe("pickQuality", () => {
  it("automática pide 1080p30 y se recorta a lo que da la cámara", () => {
    expect(pickQuality("auto").id).toBe(AUTO.id);
    expect(pickQuality("auto").width).toBe(1920);
    expect(pickQuality("auto", hd).id).toBe("720p30");
    expect(pickQuality("auto", fourK).height).toBe(1080);
  });
  it("respeta la elección si el dispositivo la soporta y baja si no", () => {
    expect(pickQuality("2160p30", fourK).id).toBe("2160p30");
    expect(pickQuality("2160p30", hd).id).toBe("720p30");
    expect(pickQuality("1080p60", fourK).id).toBe("1080p30"); // la cámara solo da 30 fps
    expect(pickQuality("1080p60", { ...fourK, frameRate: { max: 60 } }).id).toBe("1080p60");
  });
  it("sin capacidades conocidas no limita", () => {
    expect(pickQuality("1440p30").id).toBe("1440p30");
    expect(supports(QUALITIES[4])).toBe(true);
  });
  it("los bitrates crecen con la calidad", () => {
    const b = QUALITIES.map((q) => q.bitrate);
    expect([...b].sort((x, y) => x - y)).toEqual(b);
  });
});
describe("textos y almacenamiento", () => {
  it("describe lo que entrega la cámara", () => {
    expect(describeSettings({ width: 1920, height: 1080, frameRate: 29.97 })).toBe("1920×1080 · 30 fps");
    expect(describeSettings({})).toBe("—");
    expect(describeCaps(fourK)).toBe("3840×2160 · hasta 30 fps");
    expect(describeCaps(undefined)).toBe("desconocido");
  });
  it("valida ids y no falla sin localStorage", () => {
    expect(isQualityId("1080p60")).toBe(true);
    expect(isQualityId("8k")).toBe(false);
    expect(loadQuality()).toBe("auto");
  });
});
