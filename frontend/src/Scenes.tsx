import { useState } from "react";
import { api } from "./api";
import { assetUrl } from "./composition";
import { describeScene, sameLook } from "./scene-summary";
import type { OutputFormat, Program, Scene, Studio } from "./types";

const MAX_SCENES = 20;
const formatName = (format: OutputFormat) => (format === "portrait" ? "9:16" : "16:9");

/** Esquema del montaje: fondo real y un bloque por contenido o cámara. */
function SceneThumb({ program, format }: { program: Program; format: OutputFormat }) {
  const content = Boolean(program.screen || program.media_asset);
  const lead = program.layout === "spotlight" ? program.spotlight : null;
  return (
    <div
      className={`scene-thumb ${format === "portrait" ? "is-portrait" : ""} ${content || lead ? "has-lead" : ""}`}
      aria-hidden="true"
      style={{
        backgroundColor: program.background,
        backgroundImage: program.background_asset ? `url(${assetUrl(program.background_asset)})` : undefined,
      }}
    >
      {content && <i className="scene-thumb-content" />}
      {program.identities.map((id) => <i key={id} className={id === lead ? "scene-thumb-lead" : ""} />)}
    </div>
  );
}

export function Scenes({ studio, format, onFormat, run, pending, names, compact = false }: {
  compact?: boolean;
  studio: Studio; format: OutputFormat; onFormat: (format: OutputFormat) => void;
  run: (action: () => Promise<unknown>, message?: string) => Promise<void>; pending: boolean;
  names: Record<string, string>;
}) {
  const [name, setName] = useState("");
  // Acción de la tarjeta que espera confirmación.
  const [asking, setAsking] = useState<{ id: string; action: "replace" | "remove" } | null>(null);
  const all = studio.scenes ?? [];
  const scenes = all.filter((s) => s.format === format);
  const other: OutputFormat = format === "portrait" ? "landscape" : "portrait";
  const elsewhere = all.length - scenes.length;
  const current = format === "portrait" ? studio.portrait_program ?? studio.program : studio.program;
  const live = studio.broadcast?.live !== false && ["live", "reconnecting"].includes(studio.broadcast?.status ?? "");
  const full = all.length >= MAX_SCENES;
  const replace = (scene: Scene) =>
    run(() => api(`/scenes/${scene.id}`, "PUT"), `Escena «${scene.name}» actualizada`);
  const remove = (scene: Scene) =>
    run(() => api(`/scenes/${scene.id}`, "DELETE"), `Escena «${scene.name}» eliminada`);
  if (compact)
    return <section className="scene-compact" aria-label="Cambiar de escena">
      <label>Composición
        <select aria-label="Composición" value={format} onChange={(e) => onFormat(e.target.value as OutputFormat)}>
          <option value="landscape">Horizontal · 16:9</option>
          <option value="portrait">Vertical · 9:16</option>
        </select>
      </label>
      {scenes.length ? (
        <ul aria-label="Escenas guardadas">
          {scenes.map((scene) => {
            const summary = describeScene(scene.program, names, studio.assets);
            const active = sameLook(scene.program, current);
            return <li key={scene.id}>
              <button
                className={active ? "is-active" : ""}
                aria-label={`Usar escena ${scene.name}`}
                aria-current={active ? "true" : undefined}
                disabled={pending || active}
                onClick={() => void run(() => api(`/scenes/${scene.id}/activate`, "POST"), `Escena «${scene.name}» en el programa`)}
              >
                <SceneThumb program={scene.program} format={scene.format} />
                <span><b>{scene.name}</b><small>{active ? "En el programa" : summary.layout}</small></span>
              </button>
            </li>;
          })}
        </ul>
      ) : (
        <p className="hint">Aún no tienes escenas en {formatName(format)}. Sal del foco para guardar el montaje actual.</p>
      )}
    </section>;
  return <section className="scene-controls" aria-label="Escenas y formatos">
    <div className="scene-heading">
      <div>
        <h2>Escenas</h2>
        <p>Guarda cómo se ve el programa (cámaras, diseño, contenido, logo y fondo) y vuelve a ese montaje con un clic.</p>
      </div>
      <form onSubmit={(e) => {
        e.preventDefault();
        const saved = name.trim();
        void run(async () => { await api("/scenes", "POST", { name: saved, format }); setName(""); }, `Escena «${saved}» guardada. Pulsa «Usar escena» para volver a este montaje.`);
      }}>
        <label>Nombre de la escena<input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required placeholder="Entrevista, presentación…" /></label>
        <button className="button" disabled={pending || full}>Guardar escena actual</button>
      </form>
      <div className="scene-format">
        <label>Composición
          <select aria-label="Composición" value={format} onChange={(e) => onFormat(e.target.value as OutputFormat)}>
            <option value="landscape">Horizontal · 16:9</option>
            <option value="portrait">Vertical · 9:16</option>
          </select>
        </label>
        <button className="button" disabled={pending} onClick={() => void run(() => api(`/program?format=${format}`, "PUT", {
          ...(format === "portrait" ? studio.program : studio.portrait_program ?? studio.program),
          revision: (format === "portrait" ? studio.portrait_program : studio.program)?.revision ?? 0,
        }), "Composición copiada")}>Copiar desde {formatName(other)}</button>
      </div>
    </div>
    {scenes.length ? (
      <ul className="scene-list" aria-label="Escenas guardadas">
        {scenes.map((scene) => {
          const summary = describeScene(scene.program, names, studio.assets);
          const active = sameLook(scene.program, current);
          return <li key={scene.id} className={active ? "is-active" : ""}>
            <SceneThumb program={scene.program} format={scene.format} />
            <div className="scene-info">
              <b>{scene.name}</b>
              <small>{summary.layout} · {formatName(scene.format)}</small>
              <small>{summary.cameras}</small>
              {summary.content && <small>{summary.content}</small>}
              {summary.empty && <small className="scene-warning">Escena vacía: sin cámaras ni contenido.</small>}
            </div>
            {asking?.id === scene.id ? (
              <div className="scene-actions" role="group" aria-label={`Confirmar cambio en ${scene.name}`}>
                <small>{asking.action === "replace" ? "¿Reemplazarla por el programa actual?" : "¿Eliminarla? El programa no cambia."}</small>
                <button className="button" disabled={pending} onClick={() => {
                  const action = asking.action;
                  setAsking(null);
                  void (action === "replace" ? replace(scene) : remove(scene));
                }}>{asking.action === "replace" ? "Sí, reemplazar" : "Sí, eliminar"}</button>
                <button className="text-button" onClick={() => setAsking(null)}>Cancelar</button>
              </div>
            ) : (
              <div className="scene-actions">
                {active
                  ? <span className="pill">En el programa</span>
                  : <button className="button primary" disabled={pending} aria-label={`Usar escena ${scene.name}`} onClick={() => void run(() => api(`/scenes/${scene.id}/activate`, "POST"), `Escena «${scene.name}» en el programa`)}>Usar escena</button>}
                <button className="text-button" disabled={pending || active} aria-label={`Actualizar escena ${scene.name}`} onClick={() => setAsking({ id: scene.id, action: "replace" })}>Actualizar</button>
                <button className="text-button red" disabled={pending} aria-label={`Eliminar escena ${scene.name}`} onClick={() => setAsking({ id: scene.id, action: "remove" })}>Eliminar</button>
              </div>
            )}
          </li>;
        })}
      </ul>
    ) : (
      <p className="scene-empty">Aún no tienes escenas en {formatName(format)}. Prepara el programa abajo y guárdalo aquí con un nombre.</p>
    )}
    <p className="hint">
      {live && scenes.length > 0 && <b>Estás en directo: al usar una escena el público ve el cambio al instante. </b>}
      {elsewhere > 0 && <>
        {elsewhere === 1 ? "Tienes 1 escena" : `Tienes ${elsewhere} escenas`} en {formatName(other)}.{" "}
        <button className="text-button" onClick={() => onFormat(other)}>Ver {formatName(other)}</button>{" "}
      </>}
      {full ? `Llegaste al máximo de ${MAX_SCENES} escenas: elimina alguna para guardar otra.` : "Cada formato tiene su propio programa y sus propias escenas."}
    </p>
  </section>;
}
