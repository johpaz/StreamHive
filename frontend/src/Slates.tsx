import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { assetUrl } from "./composition";
import { slateNames } from "./slate";
import { slateBackgroundUrl, slateStyles } from "./slate-art";
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
  const [uploading, setUploading] = useState<"image" | "audio" | "logo" | null>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const logoRef = useRef<HTMLInputElement>(null);
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
  const upload = (file: File, slot: "image" | "audio" | "logo") =>
    run(async () => {
      setUploading(slot);
      try {
        const asset = await uploadAsset(file, () => {});
        if (asset.kind !== (slot === "audio" ? "audio" : "image"))
          throw Error(
            slot === "audio"
              ? "Para la música usa un audio MP3, OGG, WAV o M4A"
              : "Usa una imagen PNG, JPG o WebP",
          );
        set(
          slot === "image"
            ? { background_asset: asset.id }
            : slot === "logo"
              ? { logo_asset: asset.id, show_logo: true }
              : { music_asset: asset.id },
        );
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
          <legend>Diseño y marca</legend>
          <div className="slate-styles" role="radiogroup" aria-label="Estilo del fondo">
            {slateStyles.map((item) => (
              <button
                type="button"
                key={item.key}
                role="radio"
                aria-checked={draft.style === item.key && !draft.background_asset}
                className={draft.style === item.key && !draft.background_asset ? "active" : ""}
                onClick={() => set({ style: item.key, background_asset: null })}
              >
                <img src={slateBackgroundUrl(item.key, draft.background, draft.accent, 192, 108)} alt="" />
                <span>{item.label}</span>
              </button>
            ))}
          </div>
          <div className="slate-row">
            <label>
              Color de fondo
              <input type="color" value={draft.background} onChange={(e) => set({ background: e.target.value })} />
            </label>
            <label>
              Color de tu marca
              <input type="color" value={draft.accent} onChange={(e) => set({ accent: e.target.value })} />
            </label>
          </div>
          <label>
            Línea de marca (opcional)
            <input
              maxLength={60}
              placeholder="Nombre de tu canal o programa"
              value={draft.brand_line}
              onChange={(e) => set({ brand_line: e.target.value })}
            />
          </label>
          <div className="slate-row">
            <label>
              Logo
              <select
                aria-label="Posición del logo"
                value={draft.show_logo ? draft.logo_position : "none"}
                onChange={(e) =>
                  set(
                    e.target.value === "none"
                      ? { show_logo: false }
                      : { show_logo: true, logo_position: e.target.value as Slate["logo_position"] },
                  )
                }
              >
                <option value="top">Arriba, grande</option>
                <option value="corner">En la esquina</option>
                <option value="none">No mostrar</option>
              </select>
            </label>
            <label>
              Imagen del logo
              <select
                aria-label="Imagen del logo"
                value={draft.logo_asset ?? ""}
                onChange={(e) => set({ logo_asset: e.target.value || null })}
              >
                <option value="">Logo del programa</option>
                {images.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </label>
          </div>
          <button type="button" className="text-button" disabled={uploading !== null} onClick={() => logoRef.current?.click()}>
            {uploading === "logo" ? "Subiendo…" : "Subir logo (PNG con transparencia queda mejor)"}
          </button>
          {!draft.logo_asset && !program.logo && draft.show_logo && (
            <p className="hint">Aún no hay logo: sube uno aquí o en Ajustes › Identidad del programa.</p>
          )}
          <label>
            Imagen de fondo propia
            <select
              value={draft.background_asset ?? ""}
              onChange={(e) => set({ background_asset: e.target.value || null })}
            >
              <option value="">Ninguna: usar el diseño</option>
              {images.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </label>
          <button type="button" className="text-button" disabled={uploading !== null} onClick={() => imageRef.current?.click()}>
            {uploading === "image" ? "Subiendo…" : "Subir imagen de fondo"}
          </button>
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
        <input ref={logoRef} type="file" className="visually-hidden" aria-label="Subir logo" accept="image/png,image/jpeg,image/webp" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f, "logo"); }} />
        <input ref={audioRef} type="file" className="visually-hidden" aria-label="Subir música" accept="audio/mpeg,audio/ogg,audio/wav,audio/mp4,.mp3,.ogg,.wav,.m4a" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f, "audio"); }} />
        <div className="slate-save">
          <button className="button primary" disabled={pending || !dirty}>Guardar pantalla</button>
          {dirty && (
            <button type="button" className="text-button" onClick={() => setDraft(saved)}>Descartar cambios</button>
          )}
          <button
            type="button"
            className="button"
            disabled={pending}
            onClick={() =>
              void run(async () => {
                const design = {
                  style: draft.style, accent: draft.accent, background: draft.background,
                  background_asset: draft.background_asset, brand_line: draft.brand_line,
                  show_logo: draft.show_logo, logo_position: draft.logo_position, logo_asset: draft.logo_asset,
                };
                for (const other of ["start", "pause", "end"] as const)
                  await api(`/slates/${other}`, "PUT", other === kind ? draft : { ...studio.slates![other], ...design });
              }, "Diseño aplicado a las tres pantallas")
            }
          >
            Aplicar este diseño a las tres pantallas
          </button>
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
