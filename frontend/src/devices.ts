import { audioMode, loadAudioMode, type AudioMode } from "./audio-quality";
import { loadQuality, pickQuality, type QualityId } from "./camera-quality";
export interface CapturePreferences {
  audioinput?: string;
  videoinput?: string;
  /** Calidad de cámara y modo de audio; si faltan se usan los guardados. */
  quality?: QualityId;
  audio?: AudioMode;
}
export function assertMediaSupport(
  context: {
    isSecureContext: boolean;
    mediaDevices?: Pick<MediaDevices, "getUserMedia" | "enumerateDevices">;
  } = {
    isSecureContext: window.isSecureContext,
    mediaDevices: navigator.mediaDevices,
  },
): void {
  const devices = context.mediaDevices;
  if (!context.isSecureContext)
    throw Error(
      "Abre el estudio mediante HTTPS o http://localhost:5173 para permitir cámara y micrófono.",
    );
  if (!devices?.getUserMedia || !devices.enumerateDevices)
    throw Error(
      "Este navegador no permite acceder a los dispositivos. Utiliza Chrome, Edge o Safari actualizado.",
    );
}
export function deviceError(error: unknown, kind = "dispositivo"): string {
  const name =
    error && typeof error === "object" && "name" in error
      ? String(error.name)
      : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return `Permiso de ${kind} denegado. Habilítalo en los permisos del sitio y vuelve a intentarlo.`;
    case "NotFoundError":
    case "DevicesNotFoundError":
      return `No se encontró ${kind}. Conéctalo y actualiza la lista de dispositivos.`;
    case "NotReadableError":
    case "TrackStartError":
      return `No se puede abrir ${kind}. Comprueba si otra aplicación lo está utilizando.`;
    case "OverconstrainedError":
      return `El ${kind} seleccionado ya no está disponible. Selecciona otro dispositivo.`;
    default:
      return error instanceof Error
        ? error.message
        : `No se pudo abrir ${kind}.`;
  }
}
export async function probeInputs(
  devices: Pick<MediaDevices, "getUserMedia">,
  preferences: CapturePreferences,
  enabled = { audio: true, video: true },
  options: {
    isCurrent?: () => boolean;
    onStream?: (kind: "audio" | "video", stream: MediaStream) => void;
  } = {},
): Promise<{
  audio: MediaStream | null;
  video: MediaStream | null;
  errors: string[];
}> {
  const current = () => options.isCurrent?.() ?? true;
  const captured = (kind: "audio" | "video", stream: MediaStream) => {
    if (!current()) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    result[kind] = stream;
    options.onStream?.(kind, stream);
  };
  const result: {
    audio: MediaStream | null;
    video: MediaStream | null;
    errors: string[];
  } = { audio: null, video: null, errors: [] };
  // Independent requests let a camera work when a microphone is absent or denied, and vice versa.
  if (enabled.audio) {
    try {
      captured(
        "audio",
        await devices.getUserMedia({
          audio: {
            ...audioMode(preferences.audio ?? loadAudioMode()).constraints,
            ...(preferences.audioinput
              ? { deviceId: { exact: preferences.audioinput } }
              : {}),
          },
          video: false,
        }),
      );
    } catch (error) {
      result.errors.push(deviceError(error, "micrófono"));
    }
  }
  if (enabled.video && current()) {
    const wanted = pickQuality(preferences.quality ?? loadQuality());
    try {
      captured(
        "video",
        await devices.getUserMedia({
          audio: false,
          video: {
            width: { ideal: wanted.width },
            height: { ideal: wanted.height },
            frameRate: { ideal: wanted.fps },
            ...(preferences.videoinput
              ? { deviceId: { exact: preferences.videoinput } }
              : {}),
          },
        }),
      );
    } catch (error) {
      result.errors.push(deviceError(error, "cámara"));
    }
  }
  return result;
}
export function stopPreview(preview: {
  audio: MediaStream | null;
  video: MediaStream | null;
}) {
  preview.audio?.getTracks().forEach((t) => t.stop());
  preview.video?.getTracks().forEach((t) => t.stop());
}
