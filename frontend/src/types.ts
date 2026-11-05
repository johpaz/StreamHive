export type Layout = "grid" | "spotlight" | "screen";
export type OutputFormat = "landscape" | "portrait";
export type DestinationStatus = "ready" | "disabled" | "connecting" | "live" | "reconnecting" | "finished";
export const destinationLabels: Record<DestinationStatus, string> = {
  ready: "Preparado", disabled: "Desactivado", connecting: "Conectando",
  live: "Enviando señal", reconnecting: "Reconectando", finished: "Sin señal",
};
export interface Destination {
  id: string; name: string; platform: string; enabled: boolean;
  format: OutputFormat; status: DestinationStatus; host?: string | null;
}
export interface Scene { id: string; name: string; format: OutputFormat; program: Program }
export interface Asset {
  id: string;
  name: string;
  filename: string;
  mime: string;
  kind: "image" | "video";
  bytes: number;
  created: number;
}
export interface Playback {
  playing: boolean;
  position: number;
  started_at_ms: number | null;
  volume: number;
  looped: boolean;
}
export type ContentMode = "side" | "pip" | "full";
export interface Program {
  revision: number;
  layout: Layout;
  identities: string[];
  spotlight: string | null;
  screen: string | null;
  screen_audio: boolean;
  names: boolean;
  logo: string | null;
  media_asset: string | null;
  content_mode: ContentMode;
  pip_position: "bottom_right" | "bottom_left" | "top_right" | "top_left";
  microphones_enabled: boolean;
  background: string;
  background_asset: string | null;
  playback: Playback;
}
export interface Person {
  id: string;
  name: string;
  status: string;
  connected: boolean;
}
export interface Broadcast {
  id: string;
  egress_id: string | null;
  status: string;
  created: number;
  ended: number | null;
  error: string | null;
  renderer_revision: number | null;
  renderer_revisions?: Record<string, number>;
}
export interface Studio {
  program: Program;
  portrait_program?: Program;
  scenes?: Scene[];
  participants: Person[];
  broadcast: Broadcast | null;
  destination_configured: boolean;
  destinations?: Destination[];
  assets: Asset[];
  server_time_ms: number;
  clock_offset?: number;
}
export interface Me {
  id: string;
  role: "admin" | "guest";
  livekit_url: string;
}
export interface Recording {
  id: string;
  filename: string;
  created: number;
  status: string;
  bytes: number;
  duration: number;
}
export interface Health {
  free_bytes: number;
  disk_warning: boolean;
  livekit: boolean;
  database: boolean;
}
export const initialProgram: Program = {
  revision: 0,
  layout: "grid",
  identities: [],
  spotlight: null,
  screen: null,
  screen_audio: false,
  names: true,
  logo: null,
  media_asset: null,
  content_mode: "side",
  pip_position: "bottom_right",
  microphones_enabled: true,
  background: "#101923",
  background_asset: null,
  playback: {
    playing: false,
    position: 0,
    started_at_ms: null,
    volume: 1,
    looped: false,
  },
};
export const statusLabels: Record<string, string> = {
  starting: "Iniciando",
  live: "En directo",
  reconnecting: "Destino desconectado",
  ending: "Finalizando",
  complete: "Finalizado",
  error: "Error",
  uncertain: "Comprobando inicio",
  recording: "Grabando",
  interrupted: "Interrumpida",
  missing: "Archivo no encontrado",
};

export function normalizeProgram(value: Partial<Program>): Program {
  return {
    ...initialProgram,
    ...value,
    playback: { ...initialProgram.playback, ...value.playback },
  };
}
