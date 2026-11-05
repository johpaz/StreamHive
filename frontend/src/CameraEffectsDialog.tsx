import { useEffect, useRef, useState } from "react";
import {
  configureCameraEffect,
  createCameraEffectPreview,
  readCameraBackground,
  loadEffects,
  type CameraEffect,
} from "./camera-effects";
import type { LocalCameraTrack } from "./media";
import "./camera-effects.css";
import { cameraBackgrounds } from "./camera-backgrounds";

export function CameraEffectsDialog({
  source,
  current,
  onApply,
  onClose,
}: {
  source?: LocalCameraTrack;
  current: CameraEffect;
  onApply: (effect: CameraEffect) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    video = useRef<HTMLVideoElement>(null);
  const [draft, setDraft] = useState<CameraEffect>({ ...current });
  const [track, setTrack] = useState<LocalCameraTrack>();
  const [busy, setBusy] = useState(true),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [supported, setSupported] = useState<boolean>();
  const disposed = useRef(false),
    queue = useRef<Promise<void>>(Promise.resolve()),
    version = useRef(0);
  const urls = useRef(new Set<string>()),
    retained = useRef(current.imageUrl);
  useEffect(() => {
    dialog.current?.showModal();
    let preview: LocalCameraTrack | undefined;
    void createCameraEffectPreview(source)
      .then(async (camera) => {
        preview = camera;
        if (disposed.current) {
          camera.stop();
          return;
        }
        if (video.current) {
          camera.attach(video.current);
          void video.current.play().catch(() => {});
        }
        setTrack(camera);
        try {
          setSupported((await loadEffects()).supportsBackgroundProcessors());
        } catch (e) {
          if (!disposed.current) {
            setSupported(false);
            setError((e as Error).message);
          }
        }
      })
      .catch((e) => {
        if (!disposed.current) {
          setError((e as Error).message);
          setBusy(false);
        }
      });
    return () => {
      disposed.current = true;
      version.current++;
      // Stop the private raw clone immediately, including during model initialization.
      preview?.stop();
      void queue.current.finally(async () => {
        if (preview) {
          preview.detach();
          preview.stop();
        }
        for (const url of urls.current)
          if (url !== retained.current) URL.revokeObjectURL(url);
      });
    };
  }, []);
  useEffect(() => {
    if (!track) return;
    const request = ++version.current;
    setBusy(true);
    setError("");
    queue.current = queue.current.then(async () => {
      if (disposed.current || request !== version.current) return;
      try {
        await configureCameraEffect(track, draft);
        if (!disposed.current && request === version.current) setBusy(false);
      } catch (e) {
        if (!disposed.current && request === version.current) {
          setError((e as Error).message);
          setBusy(false);
        }
      }
    });
  }, [track, draft]);
  return (
    <dialog
      className="camera-effects-dialog"
      ref={dialog}
      aria-labelledby="effects-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!saving) onClose();
      }}
    >
      <header>
        <div>
          <small>MI CÁMARA</small>
          <h2 id="effects-title">Efectos de cámara</h2>
        </div>
        <button
          className="quiet-icon"
          aria-label="Cerrar efectos"
          disabled={saving}
          onClick={onClose}
        >
          ✕
        </button>
      </header>
      <div className="effects-body">
        <div>
          <div className="effects-preview">
            <video
              ref={video}
              autoPlay
              muted
              playsInline
              aria-label="Vista previa privada de cámara"
            />
            {busy && <span role="status">Preparando vista previa…</span>}
          </div>
          <p className="effects-note">
            Vista previa privada. Los demás verán el cambio al pulsar Aplicar.
          </p>
        </div>
        <div className="effects-options">
          <div
            className="effects-choices"
            role="group"
            aria-label="Efecto de cámara"
          >
            {(
              [
                ["disabled", "Sin efecto"],
                ["background-blur", "Desenfoque"],
                ["virtual-background", "Imagen"],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                className="button"
                aria-pressed={draft.mode === mode}
                disabled={saving || (mode !== "disabled" && !supported)}
                onClick={() => {
                  if (mode === "virtual-background" && !draft.imageUrl) {
                    const background = cameraBackgrounds[0];
                    setDraft({
                      ...draft,
                      mode,
                      imageUrl: background.url,
                      imageName: background.name,
                    });
                    return;
                  }
                  setDraft({ ...draft, mode });
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {supported === false && (
            <p role="status">
              Los fondos requieren un navegador con WebGL y procesamiento de
              video. Prueba una versión reciente de Chrome o Edge con
              aceleración gráfica.
            </p>
          )}
          {draft.mode === "background-blur" && (
            <label>
              Intensidad · {draft.blurRadius}
              <input
                aria-label="Intensidad de desenfoque"
                type="range"
                min="4"
                max="30"
                step="1"
                value={draft.blurRadius}
                disabled={saving}
                onChange={(e) =>
                  setDraft({ ...draft, blurRadius: Number(e.target.value) })
                }
              />
            </label>
          )}
          <section className="effects-gallery" aria-label="Fondos incluidos">
            <h3>Fondos incluidos</h3>
            <div className="effects-background-grid">
              {cameraBackgrounds.map((background) => (
                <button
                  key={background.id}
                  type="button"
                  className="effects-background-card"
                  aria-label={`Usar fondo ${background.name}`}
                  aria-pressed={
                    draft.mode === "virtual-background" &&
                    draft.imageUrl === background.url
                  }
                  disabled={!supported || saving}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      mode: "virtual-background",
                      imageUrl: background.url,
                      imageName: background.name,
                    })
                  }
                >
                  <img
                    src={background.thumbnail}
                    alt=""
                    width="320"
                    height="180"
                  />
                  <span>{background.name}</span>
                </button>
              ))}
            </div>
          </section>
          <label className="button effects-upload">
            Subir mi propia imagen
            <input
              id="camera-background-file"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={!supported || saving}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                try {
                  const image = await readCameraBackground(file);
                  if (disposed.current) {
                    URL.revokeObjectURL(image.url);
                    return;
                  }
                  urls.current.add(image.url);
                  setDraft({
                    ...draft,
                    mode: "virtual-background",
                    imageUrl: image.url,
                    imageName: image.name,
                  });
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            />
          </label>
          {draft.mode === "virtual-background" && (
            <p className="effects-filename">{draft.imageName}</p>
          )}
          <p className="effects-note">
            PNG, JPG o WebP · hasta 5 MB y 4096 px. Se procesa en este
            navegador.
          </p>
          <p className="effects-note">
            Usa buena iluminación y separa tu cuerpo del fondo. Si el equipo se
            ralentiza, vuelve a Sin efecto.
          </p>
        </div>
      </div>
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
      <footer>
        <button className="button" disabled={saving} onClick={onClose}>
          Cancelar
        </button>
        <button
          className="button primary"
          disabled={!track || busy || saving || !!error}
          onClick={async () => {
            setSaving(true);
            try {
              await onApply({ ...draft });
              retained.current = draft.imageUrl;
              onClose();
            } catch (e) {
              setError((e as Error).message);
              setSaving(false);
            }
          }}
        >
          {saving ? "Aplicando…" : "Aplicar"}
        </button>
      </footer>
    </dialog>
  );
}
