import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { assetUrl } from "./composition";
import { slateNames } from "./slate";
import { Stage } from "./Stage";
import { uploadAsset } from "./uploads";
import type { OutputFormat, Slate, SlateKind, Studio } from "./types";

const kinds: SlateKind[] = ["start", "pause", "end"];
const purpose: Record<SlateKind, string> = {
  start: "Se ve mientras llega el público.",
  pause: "Tapa el programa durante un descanso.",
  end: "Despide la emisión antes de cerrarla.",
};
export function Slates({
  studio,
  run,
  pending,
}: {
  studio: Studio;
  run: (action: () => Promise<unknown>, message?: string) => Promise<void>;
  pending: boolean;
}) {
  const [kind, setKind] = useState<SlateKind>("start");
  return (
    <section className="panel slates-editor">
      <h2>Pantallas de inicio, pausa y fin</h2>
      <p>
        Mientras una pantalla está al aire, cámaras, micrófonos y contenido
        quedan fuera de la emisión. Las activas desde el estudio.
      </p>
      <div className="slate-tabs" role="tablist" aria-label="Pantalla a configurar">
        {kinds.map((item) => (
          <button
            key={item}
            role="tab"
            aria-selected={kind === item}
            className={kind === item ? "active" : ""}
            onClick={() => setKind(item)}
          >
            {slateNames[item]}
          </button>
        ))}
      </div>
      {studio.slates && (
        <SlateForm
          key={kind}
          kind={kind}
          saved={studio.slates[kind]}
          studio={studio}
          run={run}
          pending={pending}
        />
      )}
    </section>
  );
}
function SlateForm({
  kind,
  saved,
  studio,
  run,
  pending,
}: {
  kind: SlateKind;
  saved: Slate;
  studio: Studio;
  run: (action: () => Promise<unknown>, message?: string) => Promise<void>;
  pending: boolean;
}) {
  const [draft, setDraft] = useState(saved);
  const [format, setFormat] = useState<OutputFormat>("landscape");
  const [uploading, setUploading] = useState<"image" | "audio" | null>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLInputElement>(null);
  const savedJson = JSON.stringify(saved);
  // Solo se recarga si cambió fuera de este formulario.
  const base = useRef(savedJson);
  useEffect(() => {
    if (base.current !== savedJson) {
      base.current = savedJson;
      setDraft(saved);
    }
  }, [savedJson]);
  const dirty = JSON.stringify(draft) !== savedJson;
  const set = (patch: Partial<Slate>) => setDraft((d) => ({ ...d, ...patch }));
  const assets = studio.assets ?? [];
  const images = assets.filter((a) => a.kind === "image");
  const songs = assets.filter((a) => a.kind === "audio");
  const minutes = Math.floor(draft.timer_seconds / 60);
  const seconds = draft.timer_seconds % 60;
  const upload = (file: File, slot: "image" | "audio") =>
    run(async () => {
      setUploading(slot);
      try {
        const asset = await uploadAsset(file, () => {});
        if (asset.kind !== slot)
          throw Error(
            slot === "image"
              ? "Para el fondo usa una imagen PNG, JPG o WebP"
              : "Para la música usa un audio MP3, OGG, WAV o M4A",
          );
        set(slot === "image" ? { background_asset: asset.id } : { music_asset: asset.id });
      } finally {
        setUploading(null);
      }
    });
  const program = format === "portrait" ? studio.portrait_program ?? studio.program : studio.program;
  return (
    <div className="slate-form">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () => api(`/slates/${kind}`, "PUT", draft),
            `Pantalla de ${slateNames[kind].toLowerCase()} guardada`,
          );
        }}
      >
        <p className="hint">{purpose[kind]}</p>
        <label>
          Título
          <input required maxLength={60} value={draft.title} onChange={(e) => set({ title: e.target.value })} />
        </label>
        <label>
          Subtítulo
          <input maxLength={60} value={draft.subtitle} onChange={(e) => set({ subtitle: e.target.value })} />
        </label>
        <fieldset>
          <legend>Temporizador</legend>
          <div className="slate-row">
            <label>
              Minutos
              <input
                type="number"
                min={0}
                max={360}
                value={minutes}
                onChange={(e) => set({ timer_seconds: Math.min(21600, Math.max(0, Number(e.target.value) || 0) * 60 + seconds) })}
              />
            </label>
            <label>
              Segundos
              <input
                type="number"
                min={0}
                max={59}
                value={seconds}
                onChange={(e) => set({ timer_seconds: Math.min(21600, minutes * 60 + Math.min(59, Math.max(0, Number(e.target.value) || 0))) })}
              />
            </label>
          </div>
          {draft.timer_seconds > 0 ? (
            <>
              <label>
                Texto sobre el temporizador
                <input maxLength={60} value={draft.timer_label} onChange={(e) => set({ timer_label: e.target.value })} />
              </label>
              <label>
                Texto al llegar a cero
                <input maxLength={60} value={draft.done_label} onChange={(e) => set({ done_label: e.target.value })} />
              </label>
              <label className="slate-check">
                <input
                  type="checkbox"
                  checked={draft.auto_on_timer_end}
                  onChange={(e) => set({ auto_on_timer_end: e.target.checked })}
                />
                {kind === "end"
                  ? "Al llegar a cero, finalizar el directo y también la grabación"
                  : "Al llegar a cero, volver al programa automáticamente"}
              </label>
            </>
          ) : (
            <p className="hint">Con 0 minutos y 0 segundos, la pantalla no muestra temporizador.</p>
          )}
        </fieldset>
        {kind === "start" && (
          <label className="slate-check">
            <input
              type="checkbox"
              checked={draft.show_on_go_live}
              onChange={(e) => set({ show_on_go_live: e.target.checked })}
            />
            Mostrarla al iniciar el directo
          </label>
        )}
        <fieldset>
          <legend>Fondo</legend>
          <div className="slate-row">
            <label>
              Color
              <input type="color" value={draft.background} onChange={(e) => set({ background: e.target.value })} />
            </label>
            <label>
              Imagen
              <select
                value={draft.background_asset ?? ""}
                onChange={(e) => set({ background_asset: e.target.value || null })}
              >
                <option value="">Sin imagen</option>
                {images.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </label>
          </div>
          <button type="button" className="text-button" disabled={uploading !== null} onClick={() => imageRef.current?.click()}>
            {uploading === "image" ? "Subiendo…" : "Subir imagen"}
          </button>
          <label className="slate-check">
            <input type="checkbox" checked={draft.show_logo} onChange={(e) => set({ show_logo: e.target.checked })} />
            Mostrar el logo del programa
          </label>
        </fieldset>
        <fieldset>
          <legend>Música de fondo</legend>
          <label>
            Audio
            <select
              aria-label="Música de fondo"
              value={draft.music_asset ?? ""}
              onChange={(e) => set({ music_asset: e.target.value || null })}
            >
              <option value="">Silencio</option>
              {songs.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </label>
          <button type="button" className="text-button" disabled={uploading !== null} onClick={() => audioRef.current?.click()}>
            {uploading === "audio" ? "Subiendo…" : "Subir audio (MP3, OGG, WAV o M4A, hasta 50 MB)"}
          </button>
          {draft.music_asset && (
            <>
              <label>
                Volumen en la emisión: {Math.round(draft.music_volume * 100)}%
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={draft.music_volume}
                  onChange={(e) => set({ music_volume: Number(e.target.value) })}
                />
              </label>
              <audio className="slate-listen" controls preload="none" src={assetUrl(draft.music_asset)} />
              <p className="hint">Emite solo música sobre la que tengas derechos: las plataformas pueden silenciar o cortar el directo.</p>
            </>
          )}
        </fieldset>
        <input ref={imageRef} type="file" className="visually-hidden" aria-label="Subir imagen de fondo" accept="image/png,image/jpeg,image/webp" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f, "image"); }} />
        <input ref={audioRef} type="file" className="visually-hidden" aria-label="Subir música" accept="audio/mpeg,audio/ogg,audio/wav,audio/mp4,.mp3,.ogg,.wav,.m4a" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f, "audio"); }} />
        <div className="slate-save">
          <button className="button primary" disabled={pending || !dirty}>Guardar pantalla</button>
          {dirty && (
            <button type="button" className="text-button" onClick={() => setDraft(saved)}>Descartar cambios</button>
          )}
        </div>
      </form>
      <div className="slate-preview">
        <div className="slate-row">
          <b>Vista previa</b>
          <select aria-label="Formato de la vista previa" value={format} onChange={(e) => setFormat(e.target.value as OutputFormat)}>
            <option value="landscape">16:9</option>
            <option value="portrait">9:16</option>
          </select>
        </div>
        <Stage
          format={format}
          program={program}
          room={null}
          assets={assets}
          slate={{ slate: draft, endsAtMs: null }}
          slatePreview
        />
      </div>
    </div>
  );
}
