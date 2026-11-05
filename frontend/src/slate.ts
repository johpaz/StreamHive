import type { ActiveSlate, Program, Slate, Slates } from "./types";

export interface ShownSlate {
  slate: Slate;
  /** Fin del temporizador en hora del servidor; null si no tiene. */
  endsAtMs: number | null;
}
export const slateNames = { start: "Inicio", pause: "Pausa", end: "Fin" } as const;

export function shownSlate(
  slates?: Slates | null,
  active?: ActiveSlate | null,
): ShownSlate | null {
  if (!slates || !active) return null;
  return { slate: slates[active.kind], endsAtMs: active.ends_at_ms };
}
export function remainingSeconds(endsAtMs: number, nowMs: number, clockOffset = 0) {
  return Math.max(0, Math.ceil((endsAtMs - (nowMs + clockOffset)) / 1000));
}
export function formatCountdown(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const two = (n: number) => String(n).padStart(2, "0");
  const hours = Math.floor(s / 3600);
  return hours
    ? `${hours}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`
    : `${two(Math.floor(s / 60))}:${two(s % 60)}`;
}
/**
 * Programa que se ve y se oye mientras hay una pantalla: sin personas, micrófonos ni
 * contenido. Lo usan el dibujo y las suscripciones, así nada de eso llega a la emisión.
 */
export function slateProgram(program: Program, slate: Slate): Program {
  return {
    ...program,
    layout: "grid",
    identities: [],
    spotlight: null,
    screen: null,
    screen_audio: false,
    media_asset: null,
    microphones_enabled: false,
    names: false,
    background: slate.background,
    background_asset: slate.background_asset,
    logo: slate.show_logo ? program.logo : null,
  };
}
/** El compositor no parte líneas: un texto largo reduce su tamaño para caber en una. */
export function fittedSize(text: string, base: number) {
  return Math.min(base, 150 / Math.max(text.length, 1));
}
/** Tinta legible sobre el color de fondo elegido. */
export function inkFor(background: string) {
  const channel = (at: number) => parseInt(background.slice(at, at + 2), 16) || 0;
  const light =
    0.299 * channel(1) + 0.587 * channel(3) + 0.114 * channel(5) > 150;
  return light ? "#10151c" : "#f5f8fa";
}
