import type { Asset, Layout, Program } from "./types";

const layoutLabels: Record<Layout, string> = {
  grid: "Cuadrícula",
  spotlight: "Protagonista",
  screen: "Contenido",
};
/** Campos que definen cómo se ve el programa; revisión y posición de reproducción no cuentan. */
const look = (p: Program) => [
  p.layout, p.identities, p.spotlight, p.screen, p.screen_audio, p.names, p.logo,
  p.media_asset, p.content_mode, p.pip_position, p.microphones_enabled, p.background, p.background_asset,
];
export const sameLook = (a: Program, b: Program) =>
  JSON.stringify(look(a)) === JSON.stringify(look(b));

export interface SceneSummary {
  layout: string;
  cameras: string;
  content: string | null;
  empty: boolean;
}
/** Resume en palabras lo que guarda una escena. */
export function describeScene(
  program: Program,
  names: Record<string, string>,
  assets: Asset[],
): SceneSummary {
  const person = (id: string) => names[id] || "Invitado";
  const media = assets.find((a) => a.id === program.media_asset);
  const content = program.screen
    ? `Pantalla de ${person(program.screen)}`
    : program.media_asset
      ? (media?.name ?? "Archivo no disponible")
      : null;
  const count = program.identities.length;
  return {
    layout: layoutLabels[program.layout],
    cameras: count
      ? `${count === 1 ? "1 cámara" : `${count} cámaras`}: ${program.identities.map(person).join(", ")}`
      : "Sin cámaras",
    content,
    empty: !count && !content,
  };
}
