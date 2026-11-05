import { isBundledCameraBackground } from "./camera-backgrounds";
import { loadSDK, type LocalCameraTrack } from "./media";
export interface CameraEffect {
  mode: "disabled" | "background-blur" | "virtual-background";
  blurRadius: number;
  imageUrl?: string;
  imageName?: string;
}
export const noCameraEffect: CameraEffect = {
  mode: "disabled",
  blurRadius: 10,
};
export interface CameraProcessor {
  name: string;
  switchTo?(options: Record<string, unknown>): Promise<void>;
  destroy(): Promise<void>;
  processedTrack?: MediaStreamTrack;
}
interface EffectsRuntime {
  supportsBackgroundProcessors(): boolean;
  BackgroundProcessor(
    options: Record<string, unknown>,
    name?: string,
  ): CameraProcessor;
}
let runtimePromise: Promise<EffectsRuntime> | undefined;
export async function loadEffects(): Promise<EffectsRuntime> {
  await loadSDK();
  if (!runtimePromise) {
    runtimePromise = new Promise<EffectsRuntime>((resolve, reject) => {
      const script = document.createElement("script");
      script.type = "module";
      script.src = "/effects/loader.mjs";
      script.onload = () => {
        const runtime = (
          window as Window & { StreamHiveEffects?: EffectsRuntime }
        ).StreamHiveEffects;
        if (runtime) resolve(runtime);
        else reject(Error("Procesador de cámara inválido."));
      };
      script.onerror = () => {
        script.remove();
        reject(
          Error(
            "No se pudieron cargar los efectos de cámara. Inténtalo de nuevo.",
          ),
        );
      };
      document.head.append(script);
    }).catch((error) => {
      runtimePromise = undefined;
      throw error;
    });
  }
  return runtimePromise;
}
export function effectOptions(effect: CameraEffect): Record<string, unknown> {
  if (effect.mode === "background-blur")
    return {
      mode: effect.mode,
      blurRadius: Math.min(30, Math.max(4, effect.blurRadius)),
    };
  if (effect.mode === "virtual-background") {
    if (
      !effect.imageUrl ||
      (!effect.imageUrl.startsWith("blob:") &&
        !isBundledCameraBackground(effect.imageUrl))
    )
      throw Error(
        "Selecciona un fondo de la galería o una imagen de tu equipo.",
      );
    return { mode: effect.mode, imagePath: effect.imageUrl };
  }
  return { mode: "disabled" };
}
export async function configureCameraEffect(
  track: LocalCameraTrack,
  effect: CameraEffect,
  onFrame?: () => void,
): Promise<void> {
  if (track.source && track.source !== "camera" && track.source !== "unknown")
    throw Error("Los efectos solo se aplican a la cámara.");
  // Bypass processing without interrupting the video pipeline during preview changes.
  if (effect.mode === "disabled") {
    const processor = track.getProcessor?.();
    if (processor?.switchTo) await processor.switchTo({ mode: "disabled" });
    else if (processor) await track.stopProcessor();
    return;
  }
  const options = effectOptions(effect);
  if (effect.mode === "virtual-background") {
    const image = new Image();
    image.src = effect.imageUrl!;
    try {
      await image.decode();
    } catch {
      throw Error(
        "No se pudo cargar el fondo. Elige otra imagen o vuelve a intentarlo.",
      );
    }
  }
  const runtime = await loadEffects();
  if (!runtime.supportsBackgroundProcessors())
    throw Error(
      "Este navegador no admite fondos de cámara. Puedes seguir usando la cámara sin efecto.",
    );
  const existing = track.getProcessor?.();
  if (
    existing?.name.startsWith("streamhive-camera-background-") &&
    existing.switchTo
  ) {
    await existing.switchTo(options);
    return;
  }
  const processor = runtime.BackgroundProcessor(
    {
      ...options,
      maxFps: 24,
      assetPaths: {
        tasksVisionFileSet: "/effects/vision/wasm",
        modelAssetPath: "/effects/selfie_segmenter.tflite",
      },
      onFrameProcessed: onFrame,
    },
    `streamhive-camera-background-${crypto.randomUUID()}`,
  );
  try {
    await track.setProcessor(processor, true);
  } catch (error) {
    await processor.destroy().catch(() => {});
    throw error;
  }
}
export async function createCameraEffectPreview(
  source?: LocalCameraTrack,
): Promise<LocalCameraTrack> {
  const sdk = await loadSDK();
  const raw = source?.mediaStream?.getVideoTracks()[0];
  if (raw?.readyState === "live") {
    const clone = raw.clone();
    clone.enabled = true;
    try {
      await clone.applyConstraints({
        width: { ideal: 640 },
        height: { ideal: 360 },
        frameRate: { max: 15 },
      });
      return new sdk.LocalVideoTrack(clone, clone.getConstraints(), true);
    } catch (error) {
      clone.stop();
      throw error;
    }
  }
  const settings = source?.getSourceTrackSettings?.();
  return sdk.createLocalVideoTrack({
    resolution: { width: 1280, height: 720, frameRate: 24 },
    ...(settings?.deviceId ? { deviceId: settings.deviceId } : {}),
  });
}
export async function readCameraBackground(
  file: File,
): Promise<{ url: string; name: string }> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw Error("El fondo de cámara debe ser PNG, JPG o WebP.");
  if (file.size > 5 * 1024 * 1024)
    throw Error("El fondo de cámara puede pesar hasta 5 MB.");
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width > 4096 || bitmap.height > 4096)
      throw Error("Usa un fondo de hasta 4096 × 4096 píxeles.");
  } finally {
    bitmap.close();
  }
  return { url: URL.createObjectURL(file), name: file.name };
}
export function effectLabel(effect: CameraEffect) {
  return effect.mode === "disabled"
    ? "Sin efecto"
    : effect.mode === "background-blur"
      ? "Fondo desenfocado"
      : effect.imageName || "Fondo personalizado";
}
