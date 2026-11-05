import { describe, expect, test } from "bun:test";
import { describeScene, sameLook } from "./src/scene-summary";
import { initialProgram, type Asset, type Program } from "./src/types";

const program = (patch: Partial<Program> = {}): Program => ({ ...initialProgram, ...patch });
const names = { host: "Anfitrión", ana: "Ana" };

describe("describeScene", () => {
  test("names the layout and each camera", () => {
    const s = describeScene(program({ layout: "spotlight", identities: ["host", "ana"], spotlight: "ana" }), names, []);
    expect(s.layout).toBe("Protagonista");
    expect(s.cameras).toBe("2 cámaras: Anfitrión, Ana");
    expect(s.content).toBeNull();
    expect(s.empty).toBe(false);
  });
  test("names shared screens and files", () => {
    expect(describeScene(program({ layout: "screen", screen: "ana" }), names, []).content).toBe("Pantalla de Ana");
    const asset = { id: "a1", name: "Intro" } as Asset;
    expect(describeScene(program({ layout: "screen", media_asset: "a1" }), names, [asset]).content).toBe("Intro");
    expect(describeScene(program({ layout: "screen", media_asset: "gone" }), names, []).content).toBe("Archivo no disponible");
  });
  test("flags a scene that saved nothing", () => {
    const s = describeScene(program(), names, []);
    expect(s.cameras).toBe("Sin cámaras");
    expect(s.empty).toBe(true);
  });
});

describe("sameLook", () => {
  test("ignores revision and playback position", () => {
    const a = program({ identities: ["host"] });
    const b = { ...a, revision: 9, playback: { ...a.playback, position: 42 } };
    expect(sameLook(a, b)).toBe(true);
  });
  test("detects changes that alter the program", () => {
    const a = program({ identities: ["host", "ana"] });
    expect(sameLook(a, { ...a, background: "#123456" })).toBe(false);
    expect(sameLook(a, { ...a, identities: ["ana", "host"] })).toBe(false);
  });
});
