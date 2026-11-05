// Calidad del micrófono. "Voz" aplica el procesado del navegador (cancelación de eco, supresión de ruido y
// control automático de ganancia): lo mejor para hablar sin auriculares. "Estudio" lo desactiva y sube el
// bitrate: para micrófonos buenos, música o instrumentos, donde ese procesado estropea el sonido.
export type AudioMode = "voz" | "estudio";
export interface AudioQuality {
  id: AudioMode;
  label: string;
  hint: string;
  constraints: { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean };
  /** Bitrate de Opus al publicar (bits/s). */
  bitrate: number;
}
export const AUDIO_MODES: AudioQuality[] = [
  {
    id: "voz",
    label: "Voz clara (recomendado)",
    hint: "Reduce eco y ruido; ideal para hablar",
    constraints: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    bitrate: 48_000,
  },
  {
    id: "estudio",
    label: "Estudio (sin procesado)",
    hint: "Sonido natural para música o micrófono profesional; usa auriculares para evitar eco",
    constraints: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    bitrate: 96_000,
  },
];
const KEY = "streamhive.audio.mode";
export const audioMode = (id: AudioMode | undefined) => AUDIO_MODES.find((m) => m.id === id) ?? AUDIO_MODES[0];
export function loadAudioMode(): AudioMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === "voz" || v === "estudio" ? v : "voz";
  } catch {
    return "voz";
  }
}
export function saveAudioMode(id: AudioMode) {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* solo en esta sesión */
  }
}
