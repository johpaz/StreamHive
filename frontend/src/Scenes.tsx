import { useState } from "react";
import { api } from "./api";
import type { OutputFormat, Studio } from "./types";

export function Scenes({ studio, format, onFormat, run, pending }: {
  studio: Studio; format: OutputFormat; onFormat: (format: OutputFormat) => void;
  run: (action: () => Promise<unknown>, message?: string) => Promise<void>; pending: boolean;
}) {
  const [name, setName] = useState("");
  const scenes = (studio.scenes ?? []).filter((s) => s.format === format);
  return <section className="scene-controls" aria-label="Escenas y formatos">
    <div className="scene-toolbar">
      <label>Composición
        <select aria-label="Composición" value={format} onChange={(e) => onFormat(e.target.value as OutputFormat)}>
          <option value="landscape">Horizontal · 16:9</option>
          <option value="portrait">Vertical · 9:16</option>
        </select>
      </label>
      <button className="button" disabled={pending} onClick={() => void run(() => api(`/program?format=${format}`, "PUT", {
        ...(format === "portrait" ? studio.program : studio.portrait_program ?? studio.program),
        revision: (format === "portrait" ? studio.portrait_program : studio.program)?.revision ?? 0,
      }), "Composición copiada")}>Copiar desde {format === "portrait" ? "16:9" : "9:16"}</button>
      <form onSubmit={(e) => {
        e.preventDefault();
        void run(async () => { await api("/scenes", "POST", { name, format }); setName(""); }, "Escena guardada");
      }}>
        <label>Nombre de la escena<input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required placeholder="Entrevista, presentación…" /></label>
        <button className="button" disabled={pending || (studio.scenes?.length ?? 0) >= 20}>Guardar escena actual</button>
      </form>
    </div>
    <p className="hint">Cada formato tiene su propio programa. Los destinos activos emiten a la vez en el formato asignado en Configuración.</p>
    {!!scenes.length && <ul className="scene-list" aria-label="Escenas guardadas">
      {scenes.map((scene) => <li key={scene.id}>
        <button className="button" disabled={pending} onClick={() => void run(() => api(`/scenes/${scene.id}/activate`, "POST"), `Escena al programa: ${scene.name}`)}>{scene.name}</button>
        <button className="text-button red" disabled={pending} aria-label={`Eliminar escena ${scene.name}`} onClick={() => void run(() => api(`/scenes/${scene.id}`, "DELETE"))}>×</button>
      </li>)}
    </ul>}
  </section>;
}
