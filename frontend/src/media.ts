import { useEffect, useRef, useState } from "react";
import type { Program } from "./types";
import { api } from "./api";
import { loadQuality, saveQuality, storedQuality, pickQuality, type QualityId } from "./camera-quality";
import {
  configureCameraEffect,
  noCameraEffect,
  type CameraEffect,
  type CameraProcessor,
} from "./camera-effects";
// Small adapter boundary around the pinned, locally served LiveKit browser SDK.
export interface MediaTrack {
  attach(element?: HTMLMediaElement): HTMLMediaElement;
  detach(element?: HTMLMediaElement): HTMLMediaElement[];
  kind: string;
  source: string;
  sid?: string;
  mediaStreamTrack: MediaStreamTrack;
  mediaStream?: MediaStream;
}
export interface LocalCameraTrack extends MediaTrack {
  setProcessor(
    processor: CameraProcessor,
    showLocally?: boolean,
  ): Promise<void>;
  stopProcessor(): Promise<void>;
  getProcessor(): CameraProcessor | undefined;
  getSourceTrackSettings?(): MediaTrackSettings;
  stop(): void;
}
export interface Publication {
  trackSid: string;
  source: string;
  kind: string;
  track?: MediaTrack;
  isMuted: boolean;
  isSubscribed?: boolean;
  setSubscribed?(enabled: boolean): void;
  /** Pide a LiveKit la capa simulcast que cubre estas dimensiones (solo con adaptiveStream desactivado). */
  setVideoDimensions?(dimensions: { width: number; height: number }): void;
}
export interface MediaParticipant {
  identity: string;
  name: string;
  trackPublications: Map<string, Publication>;
  isMicrophoneEnabled: boolean;
  isCameraEnabled: boolean;
  isScreenShareEnabled: boolean;
  setCameraEnabled(enabled: boolean, options?: unknown): Promise<unknown>;
  setMicrophoneEnabled(
    enabled: boolean,
    options?: unknown,
    publishOptions?: unknown,
  ): Promise<unknown>;
  setScreenShareEnabled(enabled: boolean, options?: unknown): Promise<unknown>;
  setActiveDevice?(kind: string, id: string): Promise<void>;
  publishTrack(
    track: LocalCameraTrack,
    options?: unknown,
  ): Promise<Publication>;
  unpublishTrack(
    track: MediaTrack,
    stopOnUnpublish?: boolean,
  ): Promise<Publication | undefined>;
}
export interface MediaRoom {
  localParticipant: MediaParticipant;
  remoteParticipants: Map<string, MediaParticipant>;
  state: string;
  connect(url: string, token: string, options?: unknown): Promise<void>;
  disconnect(): Promise<void>;
  startAudio(): Promise<void>;
  switchActiveDevice(kind: string, id: string): Promise<boolean>;
  on(event: string, callback: (...args: unknown[]) => void): MediaRoom;
  off(event: string, callback: (...args: unknown[]) => void): MediaRoom;
}
interface SDK {
  Room: new (options?: unknown) => MediaRoom;
  LocalVideoTrack: new (
    track: MediaStreamTrack,
    constraints?: MediaTrackConstraints,
    userProvided?: boolean,
  ) => LocalCameraTrack;
  createLocalVideoTrack(options?: unknown): Promise<LocalCameraTrack>;
  VideoPresets?: Record<string, unknown>;
}
declare global {
  interface Window {
    LivekitClient?: SDK;
  }
}
let sdkPromise: Promise<SDK> | undefined;
export function loadSDK(): Promise<SDK> {
  if (window.LivekitClient) return Promise.resolve(window.LivekitClient);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<SDK>((resolve, reject) => {
    const tag = document.createElement("script");
    tag.src = "/livekit-client.umd.js";
    tag.onload = () =>
      window.LivekitClient
        ? resolve(window.LivekitClient)
        : reject(Error("SDK multimedia inválido"));
    tag.onerror = () =>
      reject(
        Error(
          "Falta el SDK multimedia. Ejecuta bun run sdk o utiliza la imagen Docker.",
        ),
      );
    document.head.append(tag);
  }).catch((error) => {
    sdkPromise = undefined;
    throw error;
  });
  return sdkPromise;
}
export function participants(room: MediaRoom | null): MediaParticipant[] {
  return room
    ? [room.localParticipant, ...room.remoteParticipants.values()]
    : [];
}
export function publication(
  p: MediaParticipant | undefined,
  source: string,
): Publication | undefined {
  return (
    p && [...p.trackPublications.values()].find((x) => x.source === source)
  );
}
export function allowedTrack(
  program: Program,
  identity: string,
  source: string,
): boolean {
  switch (source) {
    case "microphone":
      return (
        program.microphones_enabled !== false &&
        program.identities.includes(identity)
      );
    case "screen_share_audio":
      return (
        program.layout === "screen" &&
        !program.media_asset &&
        program.screen_audio &&
        program.screen === identity
      );
    case "screen_share":
      return (
        program.layout === "screen" &&
        !program.media_asset &&
        program.screen === identity
      );
    case "camera":
      if (program.layout === "screen" && program.content_mode === "full")
        return false;
      if (program.layout === "screen" && program.content_mode === "pip")
        return (
          identity ===
          (program.spotlight && program.identities.includes(program.spotlight)
            ? program.spotlight
            : program.identities[0])
        );
      return program.layout === "spotlight"
        ? program.spotlight === identity &&
            program.identities.includes(identity)
        : program.identities.includes(identity);
    default:
      return false;
  }
}
const mediaEvents = [
  "trackSubscribed",
  "trackUnsubscribed",
  "trackPublished",
  "trackUnpublished",
  "localTrackPublished",
  "localTrackUnpublished",
  "participantConnected",
  "participantDisconnected",
  "trackMuted",
  "trackUnmuted",
  "reconnecting",
  "reconnected",
  "disconnected",
  "connectionStateChanged",
  "mediaDevicesChanged",
  "trackProcessorUpdate",
];
export function useRoom(renderer = false) {
  const [room, setRoom] = useState<MediaRoom | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const current = useRef<MediaRoom | null>(null);
  const effectRef = useRef<CameraEffect>({ ...noCameraEffect });
  const cameraOptions = useRef<Record<string, unknown>>({});
  const qualityRef = useRef<QualityId>(loadQuality());
  const [cameraQuality, setCameraQualityState] = useState<QualityId>(qualityRef.current);
  const [cameraEffect, setCameraEffect] = useState<CameraEffect>({
    ...noCameraEffect,
  });
  const setCameraEnabled = async (
    enabled: boolean,
    options?: Record<string, unknown>,
  ) => {
    const room = current.current;
    if (!room) throw Error("Conecta primero a la sala.");
    if (!enabled) return room.localParticipant.setCameraEnabled(false);
    const existing = publication(room.localParticipant, "camera");
    if (existing && !existing.isMuted) return existing;
    // Create and process the new camera before publishing any frames.
    if (existing?.track)
      await room.localParticipant.unpublishTrack(existing.track, true);
    const sdk = await loadSDK();
    const captureOptions = { ...cameraOptions.current, ...options };
    const wanted = storedQuality() ?? qualityRef.current;
    const quality = pickQuality(wanted);
    const track = await sdk.createLocalVideoTrack({
      resolution: { width: quality.width, height: quality.height, frameRate: quality.fps },
      ...captureOptions,
    });
    // Si el dispositivo entrega menos de lo pedido, el tope de bitrate se ajusta a lo real.
    const got = track.mediaStreamTrack.getSettings();
    const effective = pickQuality(wanted, {
      width: { max: Math.max(got.width ?? 0, 1) },
      height: { max: Math.max(got.height ?? 0, 1) },
    });
    try {
      await configureCameraEffect(track, effectRef.current);
      if (current.current !== room) throw Error("La sala se desconectó.");
      await room.localParticipant.publishTrack(track, {
        source: "camera",
        simulcast: true,
        videoEncoding: { maxBitrate: effective.bitrate, maxFramerate: effective.fps },
        // Capas simulcast: 540p y 360p además de la original (LiveKit admite solo dos extra). Un cuadro de 5-6 personas
        // (≈576×324 px) usa la de 360p; uno de 2-4 (≈880×500) la de 540p; solo 1-2 personas decodifican 1080p.
        ...(sdk.VideoPresets?.h540 && sdk.VideoPresets.h360
          ? { videoSimulcastLayers: [sdk.VideoPresets.h540, sdk.VideoPresets.h360] }
          : {}),
      });
      cameraOptions.current = captureOptions;
      setRevision((n) => n + 1);
      return track;
    } catch (error) {
      track.stop();
      throw error;
    }
  };
  const switchActiveDevice = async (kind: string, id: string) => {
    const room = current.current;
    if (!room) throw Error("Conecta primero a la sala.");
    const changed = await room.switchActiveDevice(kind, id);
    if (changed && kind === "videoinput")
      cameraOptions.current = { ...cameraOptions.current, deviceId: id };
    return changed;
  };
  /** Cambia la calidad y, si la cámara está encendida, la vuelve a publicar con los nuevos ajustes. */
  const setCameraQuality = async (id: QualityId) => {
    qualityRef.current = id;
    saveQuality(id);
    setCameraQualityState(id);
    const room = current.current;
    if (!room) return;
    const pub = publication(room.localParticipant, "camera");
    if (pub && !pub.isMuted) {
      await setCameraEnabled(false);
      await setCameraEnabled(true);
    }
  };
  const applyCameraEffect = async (next: CameraEffect) => {
    const previous = effectRef.current;
    const room = current.current;
    const pub = room ? publication(room.localParticipant, "camera") : undefined;
    const track = pub?.track as LocalCameraTrack | undefined;
    if (track && !pub?.isMuted) {
      try {
        await configureCameraEffect(track, next);
      } catch (error) {
        try {
          await configureCameraEffect(track, previous);
        } catch {
          await room?.localParticipant.setCameraEnabled(false);
        }
        throw error;
      }
    }
    effectRef.current = { ...next };
    setCameraEffect({ ...next });
    setRevision((n) => n + 1);
    if (previous.imageUrl && previous.imageUrl !== next.imageUrl)
      URL.revokeObjectURL(previous.imageUrl);
  };

  const connect = async (credentials?: { url: string; token: string }) => {
    if (current.current) return current.current;
    setBusy(true);
    setError("");
    let instance: MediaRoom | null = null;
    try {
      const sdk = await loadSDK();
      const auth =
        credentials ||
        (await api<{ url: string; token: string }>("/token", "POST"));
      instance = new sdk.Room({
        adaptiveStream: !renderer,
        dynacast: true,
        videoCaptureDefaults: {
          resolution: { width: 1280, height: 720, frameRate: 30 },
        },
        publishDefaults: { simulcast: true },
      });
      current.current = instance;
      const connectedRoom = instance;
      instance.on("disconnected", () => {
        if (current.current === connectedRoom) {
          current.current = null;
          setRoom(null);
        }
      });
      const refresh = () => setRevision((n) => n + 1);
      for (const event of mediaEvents) instance.on(event, refresh);
      await instance.connect(auth.url, auth.token, {
        autoSubscribe: !renderer,
      });
      setRoom(instance);
      try {
        await instance.startAudio();
      } catch {
        setError("Pulsa «Activar audio» para escuchar la sala.");
      }
      setRevision((n) => n + 1);
      return instance;
    } catch (e) {
      if (instance) void instance.disconnect();
      current.current = null;
      const details = e instanceof Error ? e.message : "Error de conexión";
      const error = new Error(
        `No se pudo conectar a la sala multimedia. Comprueba que el motor esté disponible. ${details}`,
      );
      setError(error.message);
      throw error;
    } finally {
      setBusy(false);
    }
  };
  useEffect(
    () => () => {
      void current.current?.disconnect();
      current.current = null;
      if (effectRef.current.imageUrl)
        URL.revokeObjectURL(effectRef.current.imageUrl);
    },
    [],
  );
  return {
    room,
    revision,
    error,
    setError,
    busy,
    connect,
    cameraEffect,
    applyCameraEffect,
    cameraQuality,
    setCameraQuality,
    setCameraEnabled,
    switchActiveDevice,
    disconnect: async () => {
      await current.current?.disconnect();
      current.current = null;
      setRoom(null);
    },
  };
}
