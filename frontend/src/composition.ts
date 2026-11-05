import type { Playback, Program } from "./types";
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
/** Quién lleva la vista con protagonista: la cámara destacada o la primera de la lista. */
export function leadIdentity(program: Program) {
  return program.spotlight && program.identities.includes(program.spotlight)
    ? program.spotlight
    : (program.identities[0] ?? null);
}
/** Cámaras que se ven según la composición. El resto de la lista se oye, pero no se ve. */
export function visibleIdentities(program: Program): string[] {
  const lead = leadIdentity(program);
  if (program.layout === "spotlight")
    return program.spotlight ? [program.spotlight] : [];
  if (program.layout === "featured")
    return lead ? [lead, ...program.identities.filter((id) => id !== lead)] : [];
  if (program.layout === "screen") {
    const mode = program.content_mode || "side";
    if (mode === "full") return [];
    if (mode === "pip") return lead ? [lead] : [];
  }
  return program.identities;
}
/** Una cámara grande y el resto en una tira, sin bandas: conserva 16:9 en horizontal. */
export function featuredPositions(
  count: number,
  format: "landscape" | "portrait" = "landscape",
): { left: number; top: number; width: number; height: number }[] {
  if (!count) return [];
  const pad = 3, gap = 2, others = count - 1;
  if (!others) return [{ left: pad, top: pad, width: 94, height: 94 }];
  if (format === "portrait") {
    const leadHeight = 60;
    const columns = others <= 2 ? others : others <= 4 ? 2 : 3;
    const rows = Math.ceil(others / columns);
    const top = pad + leadHeight + gap;
    const height = (100 - pad - top - (rows - 1) * gap) / rows;
    const width = (94 - (columns - 1) * gap) / columns;
    return [
      { left: pad, top: pad, width: 94, height: leadHeight },
      ...Array.from({ length: others }, (_, i) => {
        const row = Math.floor(i / columns);
        const inRow = Math.min(columns, others - row * columns);
        return {
          left: (100 - inRow * width - (inRow - 1) * gap) / 2 + (i % columns) * (width + gap),
          top: top + row * (height + gap),
          width,
          height,
        };
      }),
    ];
  }
  const side = others === 5 ? 17 : 20;
  const lead = 100 - pad * 2 - gap - side;
  const start = (100 - others * side - (others - 1) * gap) / 2;
  return [
    { left: pad, top: (100 - lead) / 2, width: lead, height: lead },
    ...Array.from({ length: others }, (_, i) => ({
      left: 100 - pad - side,
      top: start + i * (side + gap),
      width: side,
      height: side,
    })),
  ];
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
