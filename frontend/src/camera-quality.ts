// Calidad de la cámara: resolución, fps y tope de bitrate de la pista que se publica.
// La cámara puede entregar más de lo que antes se pedía (fijo 1280×720): se elige aquí y se recorta a lo
// que el dispositivo realmente soporta.
export type QualityId = "auto" | "720p30" | "1080p30" | "1080p60" | "1440p30" | "2160p30";
export interface Quality {
  id: QualityId;
  label: string;
  width: number;
  height: number;
  fps: number;
  /** Tope de bitrate de la capa principal (bits/s). Mayor calidad = más subida de red y más CPU. */
  bitrate: number;
}
export const QUALITIES: Quality[] = [
  { id: "720p30", label: "720p · 30 fps", width: 1280, height: 720, fps: 30, bitrate: 3_000_000 },
  { id: "1080p30", label: "1080p · 30 fps", width: 1920, height: 1080, fps: 30, bitrate: 6_000_000 },
  { id: "1080p60", label: "1080p · 60 fps", width: 1920, height: 1080, fps: 60, bitrate: 9_000_000 },
  { id: "1440p30", label: "1440p · 30 fps", width: 2560, height: 1440, fps: 30, bitrate: 10_000_000 },
  { id: "2160p30", label: "4K · 30 fps", width: 3840, height: 2160, fps: 30, bitrate: 16_000_000 },
];
/** "Automática": 1080p30 si el dispositivo lo permite, o lo máximo que tenga. */
export const AUTO: Quality = { ...QUALITIES[1], id: "auto", label: "Automática (1080p)" };
const KEY = "streamhive.camera.quality";

export interface Caps {
  width?: { max?: number };
  height?: { max?: number };
  frameRate?: { max?: number };
}
export function supports(q: Quality, caps?: Caps): boolean {
  if (!caps) return true;
  return (
    (caps.width?.max ?? Infinity) >= q.width &&
    (caps.height?.max ?? Infinity) >= q.height &&
    (caps.frameRate?.max ?? Infinity) >= q.fps - 1
  );
}
/** Calidad efectiva: la pedida o, si el dispositivo no llega, la mejor que sí soporte. */
export function pickQuality(id: QualityId, caps?: Caps): Quality {
  const wanted = id === "auto" ? AUTO : (QUALITIES.find((q) => q.id === id) ?? AUTO);
  if (supports(wanted, caps)) return wanted;
  const below = QUALITIES.filter((q) => supports(q, caps) && q.height <= wanted.height);
  return below.at(-1) ?? QUALITIES[0];
}
export function isQualityId(v: unknown): v is QualityId {
  return v === "auto" || QUALITIES.some((q) => q.id === v);
}
/** Valor guardado, o null si el almacenamiento no está disponible o no hay nada válido. */
export function storedQuality(): QualityId | null {
  try {
    const v = localStorage.getItem(KEY);
    return isQualityId(v) ? v : null;
  } catch {
    return null;
  }
}
export function loadQuality(): QualityId {
  try {
    const v = localStorage.getItem(KEY);
    return isQualityId(v) ? v : "auto";
  } catch {
    return "auto";
  }
}
export function saveQuality(id: QualityId) {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* sin almacenamiento: se aplica solo en esta sesión */
  }
}
export function describeSettings(s?: MediaTrackSettings): string {
  if (!s?.width || !s?.height) return "—";
  return `${s.width}×${s.height}${s.frameRate ? ` · ${Math.round(s.frameRate)} fps` : ""}`;
}
export function describeCaps(c?: Caps): string {
  if (!c?.width?.max || !c?.height?.max) return "desconocido";
  const w = c.width.max, h = c.height.max;
  return `${w}×${h}${c.frameRate?.max ? ` · hasta ${Math.round(c.frameRate.max)} fps` : ""}`;
}
