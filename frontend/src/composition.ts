import type { Playback } from "./types";
export function cameraPositions(
  count: number,
  format: "landscape" | "portrait" = "landscape",
): { left: number; top: number; width: number; height: number }[] {
  if (!count) return [];
  if (format === "portrait") {
    const columns = count <= 3 ? 1 : 2;
    const rows = Math.ceil(count / columns), gap = 2, pad = 3;
    const width = (100 - pad * 2 - (columns - 1) * gap) / columns;
    const height = (100 - pad * 2 - (rows - 1) * gap) / rows;
    return Array.from({ length: count }, (_, i) => {
      const inRow = Math.min(columns, count - Math.floor(i / columns) * columns);
      return { left: (100 - inRow * width - (inRow - 1) * gap) / 2 + (i % columns) * (width + gap),
        top: pad + Math.floor(i / columns) * (height + gap), width, height };
    });
  }
  const columns = count === 1 ? 1 : count <= 4 ? 2 : 3;
  const rows = Math.ceil(count / columns),
    gap = 2,
    pad = 3;
  const width = (100 - pad * 2 - gap * (columns - 1)) / columns;
  const height = width;
  const top = (100 - rows * height - (rows - 1) * gap) / 2;
  return Array.from({ length: count }, (_, i) => {
    const row = Math.floor(i / columns);
    const inRow = Math.min(columns, count - row * columns);
    return {
      left:
        (100 - inRow * width - (inRow - 1) * gap) / 2 +
        (i % columns) * (width + gap),
      top: top + row * (height + gap),
      width,
      height,
    };
  });
}
export function playbackTime(
  playback: Playback,
  now: number,
  duration: number = Infinity,
): number {
  const elapsed =
    playback.playing && playback.started_at_ms !== null
      ? Math.max(0, (now - playback.started_at_ms) / 1000)
      : 0;
  const time = playback.position + elapsed;
  return playback.looped && Number.isFinite(duration) && duration > 0
    ? time % duration
    : Math.min(
        time,
        Number.isFinite(duration) ? Math.max(0, duration - 0.03) : time,
      );
}
export function assetUrl(id: string, renderToken?: string) {
  return `/api/v1/assets/${encodeURIComponent(id)}${renderToken ? `?render_token=${encodeURIComponent(renderToken)}` : ""}`;
}

export function playbackFinished(
  playback: Playback,
  now: number,
  duration: number,
): boolean {
  if (playback.looped || !Number.isFinite(duration) || duration <= 0)
    return false;
  const elapsed =
    playback.playing && playback.started_at_ms !== null
      ? Math.max(0, (now - playback.started_at_ms) / 1000)
      : 0;
  return playback.position + elapsed >= duration - 0.03;
}

/** Dimensiones que hay que pedir a LiveKit para un cuadro: su tamaño real en píxeles del lienzo de salida.
 *  LiveKit entrega la capa más pequeña que las cubre, así que no se decodifica más de lo que se ve. */
export function layerDimensions(rect: { width: number; height: number }) {
  return {
    width: Math.max(1, Math.ceil(rect.width)),
    height: Math.max(1, Math.ceil(rect.height)),
  };
}
