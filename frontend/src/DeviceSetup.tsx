import { useEffect, useRef, useState } from "react";
import {
  assertMediaSupport,
  deviceError,
  probeInputs,
  stopPreview,
  type CapturePreferences,
} from "./devices";
import { AUDIO_MODES, loadAudioMode, saveAudioMode, type AudioMode } from "./audio-quality";
import {
  AUTO,
  QUALITIES,
  describeCaps,
  describeSettings,
  loadQuality,
  saveQuality,
  supports,
  type Caps,
  type QualityId,
} from "./camera-quality";
export function DeviceSetup({
  onPreferences,
  suspended = false,
}: {
  onPreferences?: (value: CapturePreferences) => void;
  suspended?: boolean;
}) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [preferences, setPreferences] = useState<CapturePreferences>(() => ({
    quality: loadQuality(),
    audio: loadAudioMode(),
  }));
  // Lo que entrega la cámara en la prueba y su máximo real (para activar/desactivar opciones).
  const [detail, setDetail] = useState(false);
  const [camInfo, setCamInfo] = useState<{ real: string; max: string; caps?: Caps } | null>(null);
  const [enabled, setEnabled] = useState({ audio: true, video: true });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [active, setActive] = useState({ audio: false, video: false });
  const [level, setLevel] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const preview = useRef<{
    audio: MediaStream | null;
    video: MediaStream | null;
  }>({ audio: null, video: null });
  const generation = useRef(0);
  const meter = useRef<{ context: AudioContext; frame: number } | null>(null);
  const stop = () => {
    generation.current++;
    stopPreview(preview.current);
    preview.current = { audio: null, video: null };
    if (meter.current) {
      cancelAnimationFrame(meter.current.frame);
      void meter.current.context.close().catch(() => {});
      meter.current = null;
    }
    if (video.current) video.current.srcObject = null;
    setActive({ audio: false, video: false });
    setLevel(0);
    setBusy(false);
  };
  const refresh = async () => {
    try {
      assertMediaSupport({
        isSecureContext: window.isSecureContext,
        mediaDevices: navigator.mediaDevices,
      });
      setDevices(await navigator.mediaDevices.enumerateDevices());
    } catch (error) {
      setErrors([deviceError(error)]);
    }
  };
  useEffect(() => {
    void refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => {
      navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
      stop();
    };
  }, []);
  useEffect(() => {
    if (suspended) stop();
  }, [suspended]);
  const choose = (kind: "audioinput" | "videoinput", id: string) => {
    const next = { ...preferences, [kind]: id };
    setPreferences(next);
    onPreferences?.(next);
  };
  const chooseQuality = (quality: QualityId) => {
    saveQuality(quality);
    const next = { ...preferences, quality };
    setPreferences(next);
    onPreferences?.(next);
  };
  const chooseAudio = (audio: AudioMode) => {
    saveAudioMode(audio);
    const next = { ...preferences, audio };
    setPreferences(next);
    onPreferences?.(next);
  };
  // Si ya hay una prueba en marcha, se repite con los nuevos ajustes para ver el efecto al momento.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      onPreferences?.(preferences);
      return;
    }
    if (preview.current.audio || preview.current.video) void test();
  }, [preferences.quality, preferences.audio]);
  const test = async () => {
    stop();
    setErrors([]);
    setBusy(true);
    const attempt = generation.current;
    try {
      assertMediaSupport({
        isSecureContext: window.isSecureContext,
        mediaDevices: navigator.mediaDevices,
      });
      const result = await probeInputs(
        navigator.mediaDevices,
        preferences,
        enabled,
        {
          isCurrent: () => attempt === generation.current,
          onStream: (kind, stream) => {
            preview.current[kind] = stream;
          },
        },
      );
      if (attempt !== generation.current) {
        stopPreview(result);
        return;
      }
      preview.current = result;
      const track = result.video?.getVideoTracks()[0];
      setCamInfo(
        track
          ? {
              real: describeSettings(track.getSettings()),
              max: describeCaps(track.getCapabilities?.() as Caps | undefined),
              caps: track.getCapabilities?.() as Caps | undefined,
            }
          : null,
      );
      setErrors(result.errors);
      setActive({ audio: Boolean(result.audio), video: Boolean(result.video) });
      if (video.current) video.current.srcObject = result.video;
      if (result.audio) {
        const context = new AudioContext();
        meter.current = { context, frame: 0 };
        void context.resume().catch(() => {});
        const source = context.createMediaStreamSource(result.audio);
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        const samples = new Uint8Array(analyser.fftSize);
        const update = () => {
          analyser.getByteTimeDomainData(samples);
          const rms = Math.sqrt(
            samples.reduce((sum, x) => sum + ((x - 128) / 128) ** 2, 0) /
              samples.length,
          );
          setLevel(Math.min(100, rms * 400));
          if (meter.current)
            meter.current.frame = requestAnimationFrame(update);
        };
        meter.current = { context, frame: requestAnimationFrame(update) };
      }
      await refresh();
    } catch (error) {
      if (attempt === generation.current) setErrors([deviceError(error)]);
    } finally {
      if (attempt === generation.current) setBusy(false);
    }
  };
  return (
    <section className="device-setup">
      <div className="device-setup-heading">
        <div>
          <b>Comprueba tus dispositivos</b>
          <small>
            Vista previa privada. Funciona antes de conectar a la sala.
          </small>
        </div>
        <button
          className="text-button"
          disabled={busy || suspended}
          onClick={refresh}
        >
          Actualizar lista
        </button>
      </div>
      <div className="device-setup-grid">
        <div className={`device-camera ${detail ? "is-detail" : ""}`}>
          <video
            ref={video}
            muted
            autoPlay
            playsInline
            hidden={!active.video}
          />
          {active.video && camInfo && <em className="res-badge">{camInfo.real}</em>}
          {!active.video && (
            <span>
              ▣
              <small>
                {busy ? "Solicitando permisos…" : "Cámara sin activar"}
              </small>
            </span>
          )}
        </div>
        <div className="device-inputs">
          {(["audioinput", "videoinput"] as const).map((kind) => (
            <label key={kind}>
              {kind === "audioinput" ? "Micrófono" : "Cámara"}
              <select
                aria-label={
                  kind === "audioinput"
                    ? "Micrófono de prueba"
                    : "Cámara de prueba"
                }
                disabled={busy || suspended}
                value={preferences[kind] || ""}
                onChange={(e) => choose(kind, e.target.value)}
              >
                <option value="">Dispositivo predeterminado</option>
                {devices
                  .filter((d) => d.kind === kind)
                  .map((d, i) => (
                    <option
                      value={d.deviceId}
                      key={`${d.kind}-${d.deviceId}-${i}`}
                    >
                      {d.label ||
                        `${kind === "audioinput" ? "Micrófono" : "Cámara"} ${i + 1}`}
                    </option>
                  ))}
              </select>
            </label>
          ))}
          <label>
            Calidad de cámara
            <select
              aria-label="Resolución de la cámara"
              disabled={busy || suspended}
              value={preferences.quality ?? "auto"}
              onChange={(e) => chooseQuality(e.target.value as QualityId)}
            >
              {[AUTO, ...QUALITIES].map((q) => {
                const ok = q.id === "auto" || supports(q, camInfo?.caps);
                return (
                  <option key={q.id} value={q.id} disabled={!ok}>
                    {q.label}
                    {ok ? "" : " · tu cámara no llega"}
                  </option>
                );
              })}
            </select>
          </label>
          {camInfo && (
            <small className="device-quality-info" role="status">
              La cámara entrega {camInfo.real} · máximo {camInfo.max}
            </small>
          )}
          <label>
            Calidad de audio
            <select
              aria-label="Modo de audio"
              disabled={busy || suspended}
              value={preferences.audio ?? "voz"}
              onChange={(e) => chooseAudio(e.target.value as AudioMode)}
            >
              {AUDIO_MODES.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </label>
          <small className="device-quality-info">
            {AUDIO_MODES.find((m) => m.id === (preferences.audio ?? "voz"))?.hint}
          </small>
          <div className="mic-status">
            {active.audio
              ? "Micrófono activo · habla para comprobar el nivel"
              : "Micrófono sin activar"}
          </div>
          <div
            className="mic-meter"
            role="meter"
            aria-label="Nivel de micrófono"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(level)}
          >
            <span style={{ width: `${level}%` }} />
          </div>
          {active.video && (
            <button className="text-button" aria-pressed={detail} onClick={() => setDetail(!detail)}>
              {detail ? "Ajustar a la caja" : "Ver detalle al 100 %"}
            </button>
          )}
          <div className="device-flags">
            <label>
              <input
                type="checkbox"
                checked={enabled.audio}
                disabled={busy || suspended}
                onChange={(e) =>
                  setEnabled((x) => ({ ...x, audio: e.target.checked }))
                }
              />
              Probar micrófono
            </label>
            <label>
              <input
                type="checkbox"
                checked={enabled.video}
                disabled={busy || suspended}
                onChange={(e) =>
                  setEnabled((x) => ({ ...x, video: e.target.checked }))
                }
              />
              Probar cámara
            </label>
          </div>
        </div>
      </div>
      {errors.map((error, i) => (
        <p className="device-error" role="alert" key={i}>
          {error}
        </p>
      ))}
      <div className="device-setup-actions">
        <button
          className="button primary"
          disabled={busy || suspended || (!enabled.audio && !enabled.video)}
          onClick={test}
        >
          {busy ? "Comprobando…" : "Probar cámara y micrófono"}
        </button>
        {(active.audio || active.video) && (
          <button className="button" onClick={stop}>
            Detener prueba
          </button>
        )}
      </div>
      <small>
        Permite el acceso cuando lo solicite el navegador. Puedes entrar con
        solo cámara o solo micrófono.
      </small>
    </section>
  );
}
