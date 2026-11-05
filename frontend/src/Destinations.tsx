import { useEffect, useState } from "react";
import { api } from "./api";
import { destinationLabels, type Destination, type OutputFormat } from "./types";

type Preset = { id: string; name: string; needs_url: boolean; help: string };
type List = { destinations: Destination[]; presets: Preset[]; max: number; profiles: { format: OutputFormat; video_bitrate: number; audio_bitrate: number }[] };
const panels: Record<string, string> = {
  youtube: "https://studio.youtube.com/", twitch: "https://dashboard.twitch.tv/settings/stream",
  facebook: "https://www.facebook.com/live/producer", kick: "https://dashboard.kick.com/",
};
export function Destinations({ disabled, run, version }: {
  disabled: boolean;
  run: (action: () => Promise<unknown>, message?: string) => Promise<void>;
  version: unknown;
}) {
  const [list, setList] = useState<List | null>(null);
  const [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [platform, setPlatform] = useState("youtube");
  const [format, setFormat] = useState<OutputFormat>("landscape");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let stop = false;
    api<List>("/destinations").then((l) => { if (!stop) { setList(l); setLoadError(""); } })
      .catch(() => { if (!stop) setLoadError("No se pudieron cargar los destinos. Se reintentará al actualizar el estudio."); });
    return () => { stop = true; };
  }, [version]);
  const preset = list?.presets.find((p) => p.id === platform);
  const custom = platform === "custom";
  const full = !editing && (list?.destinations.length ?? 0) >= (list?.max ?? 5);
  const locked = disabled || full || saving || !list;
  const reset = () => { setEditing(null); setKey(""); setName(""); setUrl(""); };
  return <div className="destinations">
    {loadError && <p role="alert">{loadError}</p>}
    {!list ? <p className="hint">Cargando destinos…</p> : !list.destinations.length ?
      <p className="hint">Aún no hay destinos. Añade uno o varios para emitir a la vez.</p> :
      <ul className="destination-list" aria-label="Destinos de transmisión">
        {list.destinations.map((d) => <li key={d.id} className={d.enabled ? "" : "is-off"}>
          <label className="destination-toggle">
            <input type="checkbox" checked={d.enabled} disabled={disabled || saving} aria-label={`Emitir a ${d.name}`}
              onChange={(e) => void run(() => api(`/destinations/${d.id}`, "PATCH", { enabled: e.target.checked }))} />
            <span><b>{d.name}</b><small>{d.format === "portrait" ? "9:16" : "16:9"}{d.host ? ` · ${d.host}` : ""}</small>
              <small role="status">{destinationLabels[d.status] ?? "Preparado"}</small></span>
          </label>
          {disabled && d.enabled && ["reconnecting", "finished"].includes(d.status) && <button className="text-button"
            onClick={() => void run(() => api(`/broadcast/retry?destination_id=${encodeURIComponent(d.id)}`, "POST"))}>Reintentar</button>}
          <button className="text-button" disabled={disabled || saving} onClick={() => {
            setEditing(d.id); setPlatform(d.platform); setFormat(d.format ?? "landscape"); setName(d.name); setUrl(""); setKey("");
          }}>Editar</button>
          <button className="text-button red" disabled={disabled || saving} onClick={() => void run(async () => {
            await api(`/destinations/${d.id}`, "DELETE"); if (editing === d.id) reset();
          }, "Destino eliminado")}>Quitar</button>
        </li>)}
      </ul>}
    <p className="hint">Todos los destinos marcados emiten simultáneamente. Las escenas se comparten entre destinos del mismo formato. Para cambiar destinos o credenciales, finaliza el directo.</p>
    <form onSubmit={(e) => {
      e.preventDefault();
      setSaving(true);
      void run(async () => {
        try {
          if (editing) await api(`/destinations/${editing}`, "PATCH", { name, format, url: url || undefined, key: key || undefined });
          else await api("/destinations", "POST", { platform, format, name: name || undefined, url: url || undefined, key });
          reset();
        } finally { setSaving(false); }
      }, editing ? "Destino actualizado" : "Destino añadido y guardado de forma cifrada");
    }}>
      <b>{editing ? "Editar destino" : "Añadir destino"}</b>
      <label>Plataforma<select value={platform} disabled={locked || !!editing} onChange={(e) => {
        setPlatform(e.target.value); setUrl(""); setKey("");
        setFormat(["instagram", "tiktok"].includes(e.target.value) ? "portrait" : "landscape");
      }}>
        {list?.presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        <option value="custom">Personalizado (otro servidor RTMP)</option>
      </select></label>
      {preset?.help && <p className="hint">{preset.help}</p>}
      {panels[platform] && <a href={panels[platform]} target="_blank" rel="noreferrer">Abrir panel de {preset?.name}</a>}
      <label>Nombre<input value={name} maxLength={40} disabled={locked} placeholder="Mi canal, cuenta o evento…" onChange={(e) => setName(e.target.value)} /></label>
      <label>Formato de salida<select value={format} disabled={locked} onChange={(e) => setFormat(e.target.value as OutputFormat)}>
        <option value="landscape">Horizontal · 16:9 · 1920 × 1080</option>
        <option value="portrait">Vertical · 9:16 · 1080 × 1920</option>
      </select></label>
      <label>{custom ? "URL RTMP / RTMPS" : `URL del servidor de ${preset?.name ?? platform}`}
        <input required={!editing && (custom || !!preset?.needs_url)} value={url} disabled={locked}
          placeholder={editing ? "Vacío: conservar servidor" : preset?.needs_url || custom ? "rtmps://servidor/app" : "Opcional: usar servidor predeterminado"}
          onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label>Clave de transmisión<input type="password" required={!editing || !!url} autoComplete="off" disabled={locked} value={key}
        onChange={(e) => setKey(e.target.value)} placeholder={editing ? "Vacío: conservar clave" : "La clave nunca se muestra de nuevo"} /></label>
      {editing && <p className="hint">Para reemplazar el servidor, pega también la clave. Las credenciales guardadas no se muestran.</p>}
      <button className="button primary" disabled={locked}>{saving ? "Guardando…" : full ? "Máximo de destinos alcanzado" : editing ? "Guardar destino" : "Añadir destino"}</button>
      {editing && <button type="button" className="button" disabled={saving} onClick={reset}>Cancelar</button>}
    </form>
    {!!list?.profiles?.length && <p className="hint">Salida H.264/AAC a 30 fps. {list.profiles.map((p) => `${p.format === "portrait" ? "9:16" : "16:9"}: ${p.video_bitrate} kbps vídeo / ${p.audio_bitrate} kbps audio`).join(" · ")}. Cada formato se codifica una vez; usar ambos aumenta el uso de CPU y red.</p>}
  </div>;
}
