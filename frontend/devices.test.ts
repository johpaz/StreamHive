import { describe, it, expect } from "bun:test";
import { assertMediaSupport, probeInputs, stopPreview } from "./src/devices";
describe("independent device preflight", () => {
  it("explains insecure contexts before attempting capture", () => {
    expect(() => assertMediaSupport({ isSecureContext: false })).toThrow(
      "HTTPS",
    );
  });
  it("allows a camera preview after microphone permission is denied", async () => {
    const camera = {} as MediaStream;
    const calls: MediaStreamConstraints[] = [];
    const result = await probeInputs(
      {
        getUserMedia: async (constraints) => {
          calls.push(constraints!);
          if (constraints?.audio) throw { name: "NotAllowedError" };
          return camera;
        },
      },
      { videoinput: "chosen-camera" },
    );
    expect(result.video).toBe(camera);
    expect(result.audio).toBeNull();
    expect(result.errors[0]).toContain("Permiso de micrófono denegado");
    expect(calls[1].video).toMatchObject({
      deviceId: { exact: "chosen-camera" },
    });
  });
  it("allows microphone testing when no camera is present", async () => {
    const microphone = {} as MediaStream;
    const result = await probeInputs(
      {
        getUserMedia: async (constraints) => {
          if (constraints?.video) throw { name: "NotFoundError" };
          return microphone;
        },
      },
      {},
    );
    expect(result.audio).toBe(microphone);
    expect(result.video).toBeNull();
    expect(result.errors[0]).toContain("No se encontró cámara");
  });
  it("never requests unchecked sources", async () => {
    const calls: unknown[] = [];
    await probeInputs(
      {
        getUserMedia: async (constraints) => {
          calls.push(constraints);
          return {} as MediaStream;
        },
      },
      {},
      { audio: false, video: true },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ audio: false });
  });
  it("releases both preview sources", () => {
    let stopped = 0;
    const stream = {
      getTracks: () => [{ stop: () => stopped++ }],
    } as unknown as MediaStream;
    stopPreview({ audio: stream, video: stream });
    expect(stopped).toBe(2);
  });
  it("stops captures that complete after the preview was cancelled", async () => {
    let stopped = 0,
      calls = 0,
      current = true;
    const stream = {
      getTracks: () => [{ stop: () => stopped++ }],
    } as unknown as MediaStream;
    const result = await probeInputs(
      {
        getUserMedia: async () => {
          calls++;
          current = false;
          return stream;
        },
      },
      {},
      { audio: true, video: true },
      { isCurrent: () => current },
    );
    expect(stopped).toBe(1);
    expect(calls).toBe(1);
    expect(result.audio).toBeNull();
    expect(result.video).toBeNull();
  });
});
