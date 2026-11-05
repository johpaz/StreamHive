import { useEffect, useRef, useState } from "react";
import {
  QUALITIES,
  AUTO,
  describeCaps,
  describeSettings,
  pickQuality,
  supports,
  type Caps,
  type QualityId,
} from "./camera-quality";
import type { LocalCameraTrack } from "./media";
import "./camera-effects.css";

/** Ajustes de calidad de la cámara: muestra lo que entrega el dispositivo y deja elegir resolución/fps. */
export function CameraQualityDialog({
  track,
  current,
  onApply,
  onClose,
}: {
  track?: LocalCameraTrack;
  current: QualityId;
  onApply: (id: QualityId) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [choice, setChoice] = useState<QualityId>(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { dialog.current?.showModal(); }, []);
  const mst = track?.mediaStreamTrack;
  const caps = (mst?.getCapabilities?.() ?? undefined) as Caps | undefined;
  const real = describeSettings(mst?.getSettings?.());
  const effective = pickQuality(choice, caps);
  return (
    <dialog
      className="camera-effects-dialog camera-quality-dialog"
      ref={dialog}
      aria-labelledby="quality-title"
      onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}
    >
      <header>
        <div>
          <small>MI CÁMARA</small>
          <h2 id="quality-title">Calidad de cámara</h2>
        </div>
        <button className="quiet-icon" aria-label="Cerrar calidad de cámara" disabled={busy} onClick={onClose}>✕</button>
      </header>
      <div className="quality-body">
        <dl className="quality-facts">
          <div><dt>Entrega ahora</dt><dd>{track ? real : "Enciende la cámara para verlo"}</dd></div>
          <div><dt>Máximo del dispositivo</dt><dd>{track ? describeCaps(caps) : "—"}</dd></div>
        </dl>
        <fieldset disabled={busy}>
          <legend>Resolución y fotogramas</legend>
          {[{ ...AUTO }, ...QUALITIES].map((q) => {
            const ok = q.id === "auto" || supports(q, caps);
            return (
              <label key={q.id} className={ok ? "" : "is-off"}>
                <input type="radio" name="quality" value={q.id} checked={choice === q.id} disabled={!ok} onChange={() => setChoice(q.id as QualityId)} />
                <span>
                  <b>{q.label}</b>
                  <small>{ok ? `hasta ${(q.bitrate / 1e6).toFixed(0)} Mb/s de subida` : "Tu cámara no llega a esta calidad"}</small>
                </span>
              </label>
            );
          })}
        </fieldset>
        <p className="hint">
          {choice === "auto" ? "Se usará " : "Se pedirá "}
          <b>{effective.label.replace("Automática (1080p)", "1080p · 30 fps")}</b>. Más calidad usa más subida de red y más CPU
          {QUALITIES.findIndex((q) => q.id === effective.id) >= 3 ? "; con los efectos de fondo activos conviene 1080p o menos" : ""}.
        </p>
        {error && <p role="alert" className="alert warning">{error}</p>}
      </div>
      <footer>
        <button className="button" disabled={busy} onClick={onClose}>Cancelar</button>
        <button
          className="button primary"
          disabled={busy || choice === current}
          onClick={async () => {
            setBusy(true); setError("");
            try { await onApply(choice); onClose(); }
            catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
          }}
        >
          {busy ? "Aplicando…" : "Aplicar"}
        </button>
      </footer>
    </dialog>
  );
}
