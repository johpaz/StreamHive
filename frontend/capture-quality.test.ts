import { describe, expect, it } from "bun:test";
import { probeInputs } from "./src/devices";
import { AUDIO_MODES, audioMode, loadAudioMode } from "./src/audio-quality";

const stream = () => ({ getTracks: () => [] }) as unknown as MediaStream;
function spy() {
  const calls: MediaStreamConstraints[] = [];
  return { calls, devices: { getUserMedia: async (c: MediaStreamConstraints) => { calls.push(c); return stream(); } } };
}
describe("la prueba de cámara y micrófono respeta la calidad elegida", () => {
  it("pide la resolución y fps de la calidad, no un 720p fijo", async () => {
    const { calls, devices } = spy();
    await probeInputs(devices, { quality: "2160p30", audio: "voz" });
    const video = calls.find((c) => c.video)!.video as MediaTrackConstraints;
    expect(video.width).toEqual({ ideal: 3840 });
    expect(video.height).toEqual({ ideal: 2160 });
    expect(video.frameRate).toEqual({ ideal: 30 });
    const small = spy();
    await probeInputs(small.devices, { quality: "720p30" });
    expect((small.calls.find((c) => c.video)!.video as MediaTrackConstraints).width).toEqual({ ideal: 1280 });
  });
  it("la automática pide 1080p", async () => {
    const { calls, devices } = spy();
    await probeInputs(devices, { quality: "auto" });
    expect((calls.find((c) => c.video)!.video as MediaTrackConstraints).height).toEqual({ ideal: 1080 });
  });
  it("el modo estudio desactiva el procesado del navegador y voz lo activa", async () => {
    const studio = spy();
    await probeInputs(studio.devices, { audio: "estudio" }, { audio: true, video: false });
    expect(studio.calls[0].audio).toMatchObject({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
    const voice = spy();
    await probeInputs(voice.devices, { audio: "voz" }, { audio: true, video: false });
    expect(voice.calls[0].audio).toMatchObject({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
  });
  it("mantiene el dispositivo elegido", async () => {
    const { calls, devices } = spy();
    await probeInputs(devices, { videoinput: "cam-1", audioinput: "mic-1" });
    expect((calls.find((c) => c.video)!.video as MediaTrackConstraints).deviceId).toEqual({ exact: "cam-1" });
    expect((calls.find((c) => c.audio)!.audio as MediaTrackConstraints).deviceId).toEqual({ exact: "mic-1" });
  });
});
describe("modos de audio", () => {
  it("estudio sube el bitrate y el valor por defecto es voz", () => {
    expect(loadAudioMode()).toBe("voz");
    expect(audioMode("estudio").bitrate).toBeGreaterThan(audioMode("voz").bitrate);
    expect(audioMode(undefined).id).toBe("voz");
    expect(AUDIO_MODES.map((m) => m.id)).toEqual(["voz", "estudio"]);
  });
});
