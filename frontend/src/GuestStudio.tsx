import { useEffect, useRef, useState } from "react";
import { audioMode, loadAudioMode } from "./audio-quality";
import { CameraEffectsDialog } from "./CameraEffectsDialog";
import { DeviceSetup } from "./DeviceSetup";
import {
  assertMediaSupport,
  deviceError,
  listDevices,
  type CapturePreferences,
} from "./devices";
import {
  participants,
  publication,
  useRoom,
  type LocalCameraTrack,
} from "./media";
import { slateNames } from "./slate";
import { MonitorAudio, Stage, TrackView } from "./Stage";
import { StudioChat } from "./StudioChat";
import type { Program, Slate } from "./types";
import { Icon } from "./ui";

/** Lo que el anfitrión tiene en su escenario, tal como lo publica su app (`remote::stage_view`). */
export interface GuestStage {
  program: Program;
  /** Hay un archivo del anfitrión en pantalla: se emite, pero no llega a los invitados. */
  file: boolean;
  names: Record<string, string>;
  slate: { kind: "start" | "pause" | "end"; ends_at_ms: number | null; slate: Slate } | null;
  live: boolean;
  recording: boolean;
}

/** Permiso de cámara y audio que da el servidor de sesiones solo tras la admisión. */
async function guestCredentials() {
  const r = await fetch("/api/v1/guest/media");
  const body = await r.json().catch(() => ({}));
  if (!r.ok)
    throw Error(body.error || "No se pudo obtener el acceso a cámara y audio");
  return body as { url: string; token: string };
}

const KINDS = [
  ["audioinput", "Micrófono"],
  ["videoinput", "Cámara"],
  ["audiooutput", "Altavoz"],
] as const;

/** Cambiar de micrófono, cámara o altavoz sin salir de la sala. */
function LiveDevices({
  switchDevice,
  act,
}: {
  switchDevice: (kind: string, id: string) => Promise<boolean>;
  act: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  useEffect(() => {
    const refresh = () =>
      void listDevices(navigator.mediaDevices)
        .then(setDevices)
        .catch(() => {});
    refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () =>
      navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
  }, []);
  return (
    <div className="guest-devices">
      {KINDS.map(([kind, name]) => {
        const list = devices.filter((d) => d.kind === kind && d.deviceId);
        if (!list.length) return null;
        return (
          <label key={kind}>
            {name}
            <select
              value={chosen[kind] ?? ""}
              onChange={(e) => {
                const id = e.target.value;
                setChosen({ ...chosen, [kind]: id });
                if (!id) return;
                void act(async () => {
                  try {
                    await switchDevice(kind, id);
                  } catch (error) {
                    throw Error(deviceError(error));
                  }
                });
              }}
            >
              <option value="" disabled>
                Elige {name.toLowerCase()}
              </option>
              {list.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `${name} ${i + 1}`}
                </option>
              ))}
            </select>
          </label>
        );
      })}
    </div>
  );
}

/** DisconnectReason de LiveKit: PARTICIPANT_REMOVED (4) y ROOM_DELETED (5). */
const removalReasons = new Set([4, 5]);

/**
 * Estudio del invitado del servidor, una vez admitido: el escenario del anfitrión tal como lo
 * tiene él, sus propios controles y el chat fijo al lado. Entra en la sala solo para ver y oír;
 * su cámara y su micrófono se encienden cuando él lo decide, y el anfitrión decide quién sale.
 */
export function GuestStudio({
  me,
  sessionId,
  stage,
  hostOnline,
  online,
}: {
  me: { id: string; name: string };
  sessionId: string;
  stage: GuestStage | null;
  hostOnline: boolean;
  online: boolean;
}) {
  const media = useRoom();
  const [preferences, setPreferences] = useState<CapturePreferences>({});
  const [testing, setTesting] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [effectsOpen, setEffectsOpen] = useState(false);
  // Efectos de cámara: solo si el servidor trae sus archivos (`/api/v1/meta` → effects).
  const [effects, setEffects] = useState(false);
  useEffect(() => {
    void fetch("/api/v1/meta")
      .then((r) => r.json())
      .then((m) => setEffects(m.effects === true))
      .catch(() => {});
  }, []);
  const preview = useRef<HTMLDivElement>(null);
  const identity = `g-${me.id}`;
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  // Entra a ver y oír la sala en cuanto lo admiten (sin publicar nada todavía).
  const join = () =>
    act(async () => {
      const room = await media.connect(await guestCredentials());
      watchRemoval(room);
      void room.startAudio().catch(() => setAudioBlocked(true));
    });
  // Si el anfitrión lo saca (o cierra la sesión), la cámara y el micrófono se apagan al momento,
  // sin esperar al aviso del servidor de sesiones.
  const watched = useRef(new WeakSet<object>());
  const watchRemoval = (room: NonNullable<typeof media.room>) => {
    if (watched.current.has(room)) return;
    watched.current.add(room);
    const local = new Set<MediaStreamTrack>();
    room.on("localTrackPublished", (pub) => {
      const track = (pub as { track?: { mediaStreamTrack?: MediaStreamTrack } }).track
        ?.mediaStreamTrack;
      if (track) local.add(track);
    });
    room.on("disconnected", (reason) => {
      if (!removalReasons.has(Number(reason))) return;
      for (const track of local) track.stop();
      setRemoved(true);
    });
  };
  useEffect(() => {
    void join();
    return () => void media.disconnect();
  }, []);
  const room = media.room;
  const self = room?.localParticipant;
  const publishing = Boolean(self?.isMicrophoneEnabled || self?.isCameraEnabled);
  const turnOn = () =>
    act(async () => {
      assertMediaSupport();
      setTesting(false);
      const r = room ?? (await media.connect(await guestCredentials()));
      watchRemoval(r);
      if (preferences.quality) await media.setCameraQuality(preferences.quality);
      const mode = audioMode(preferences.audio ?? loadAudioMode());
      const outcomes = await Promise.allSettled([
        r.localParticipant.setMicrophoneEnabled(
          true,
          {
            ...mode.constraints,
            ...(preferences.audioinput
              ? { deviceId: preferences.audioinput }
              : {}),
          },
          { audioPreset: { maxBitrate: mode.bitrate } },
        ),
        media.setCameraEnabled(
          true,
          preferences.videoinput
            ? { deviceId: preferences.videoinput }
            : undefined,
        ),
      ]);
      const warnings = outcomes.flatMap((o, i) =>
        o.status === "rejected"
          ? [deviceError(o.reason, i === 0 ? "micrófono" : "cámara")]
          : [],
      );
      if (warnings.length) setError(warnings.join(" "));
    });
  const program = stage?.program;
  const onProgram = Boolean(program?.identities.includes(identity));
  const content = program?.layout === "screen";
  const shown = stage?.slate
    ? { slate: stage.slate.slate, endsAtMs: stage.slate.ends_at_ms }
    : null;
  const status = stage?.live
    ? { label: "En directo", tone: "live" }
    : stage?.recording
      ? { label: "Grabando", tone: "rec" }
      : { label: "Aún no empieza", tone: "" };
  const selfCamera = publication(self, "camera");
  const people = participants(room).filter((p) => !p.identity.startsWith("EG_"));
  const canShare = typeof navigator.mediaDevices?.getDisplayMedia === "function";
  if (removed)
    return (
      <div className="guest-studio gs-removed">
        <p className="state" role="status">
          El anfitrión te sacó de la sala
        </p>
        <p>Tu cámara y tu micrófono ya están apagados.</p>
      </div>
    );
  return (
    <div className="guest-studio">
      <header className="gs-top">
        <span className="gs-brand">StreamHive</span>
        <span className={`gs-pill ${status.tone}`}>
          <i />
          {status.label}
        </span>
        <span className={`gs-host ${hostOnline && online ? "on" : ""}`}>
          <i />
          {!online
            ? "Reconectando…"
            : hostOnline
              ? "Anfitrión conectado"
              : "El anfitrión no está conectado"}
        </span>
        <span className="gs-me" title="Tu nombre en la sala">
          {me.name}
        </span>
      </header>
      <div className="gs-body">
        <section className="gs-main" aria-label="Escenario">
          {shown && (
            <div className="alert">
              Se está mostrando una pantalla de{" "}
              {slateNames[stage!.slate!.kind].toLowerCase()}: ahora no estás al
              aire, y el público no te ve ni te oye.
            </div>
          )}
          <div className="studio-preview" ref={preview}>
            <div className="preview-title">
              <span>
                <Icon name="eye" size={14} /> VISTA DEL PROGRAMA
              </span>
              <div>
                <span className={onProgram ? "gs-on-air" : ""}>
                  {onProgram ? "Estás en el programa" : "No estás en el programa"}
                </span>
                <button
                  className="quiet-icon"
                  aria-label="Ampliar vista del programa"
                  title="Ampliar vista del programa"
                  onClick={() => void preview.current?.requestFullscreen?.()}
                >
                  <Icon name="maximize" size={15} />
                </button>
              </div>
            </div>
            {program ? (
              <Stage
                program={program}
                slate={shown}
                room={room}
                names={stage!.names}
                revision={media.revision}
              />
            ) : (
              <div className="stage gs-stage-wait">
                <p>
                  {hostOnline
                    ? "Cargando el escenario del anfitrión…"
                    : "Verás el escenario cuando el anfitrión abra su estudio."}
                </p>
              </div>
            )}
            {content && stage?.file && !program?.screen && (
              <p className="gs-note">
                El anfitrión está mostrando un archivo: sale en la emisión, pero
                aquí no se ve.
              </p>
            )}
          </div>
          <MonitorAudio room={room} revision={media.revision} />
          <div className="studio-controls gs-controls">
            {!publishing ? (
              <>
                <button
                  className="button primary"
                  disabled={busy || media.busy}
                  onClick={() => void turnOn()}
                >
                  <Icon name="camera" />
                  {busy || media.busy ? "Conectando…" : "Encender cámara y micrófono"}
                </button>
                <button className="button" onClick={() => setTesting(!testing)}>
                  <Icon name="settings" />
                  {testing ? "Cerrar prueba" : "Probar dispositivos"}
                </button>
              </>
            ) : (
              <>
                <button
                  className={`control-button ${self!.isMicrophoneEnabled ? "" : "is-off"}`}
                  onClick={() =>
                    void act(() =>
                      self!.setMicrophoneEnabled(!self!.isMicrophoneEnabled),
                    )
                  }
                >
                  <Icon name="mic" />
                  <span>{self!.isMicrophoneEnabled ? "Silenciar" : "Activar micrófono"}</span>
                </button>
                <button
                  className={`control-button ${self!.isCameraEnabled ? "" : "is-off"}`}
                  disabled={busy}
                  onClick={() =>
                    void act(() => media.setCameraEnabled(!self!.isCameraEnabled))
                  }
                >
                  <Icon name="camera" />
                  <span>{self!.isCameraEnabled ? "Apagar cámara" : "Activar cámara"}</span>
                </button>
                {canShare && (
                  <button
                    className={`control-button ${self!.isScreenShareEnabled ? "sharing" : ""}`}
                    onClick={() =>
                      void act(() =>
                        self!.setScreenShareEnabled(!self!.isScreenShareEnabled, {
                          audio: true,
                        }),
                      )
                    }
                  >
                    <Icon name="monitor" />
                    <span>
                      {self!.isScreenShareEnabled ? "Dejar de compartir" : "Compartir pantalla"}
                    </span>
                  </button>
                )}
                {effects && (
                  <button
                    className={`control-button ${media.cameraEffect.mode !== "disabled" ? "sharing" : ""}`}
                    disabled={!self!.isCameraEnabled}
                    title={self!.isCameraEnabled ? undefined : "Enciende la cámara para usar efectos"}
                    onClick={() => setEffectsOpen(true)}
                  >
                    <Icon name="camera" />
                    <span>Efectos de cámara</span>
                  </button>
                )}
                <button
                  className={`control-button ${devicesOpen ? "sharing" : ""}`}
                  aria-expanded={devicesOpen}
                  onClick={() => setDevicesOpen(!devicesOpen)}
                >
                  <Icon name="settings" />
                  <span>Dispositivos</span>
                </button>
              </>
            )}
            {room && (
              <button
                className={`control-button ${audioBlocked ? "is-off" : ""}`}
                title="Activar audio de la sala"
                onClick={() =>
                  void act(async () => {
                    await room.startAudio();
                    setAudioBlocked(false);
                  })
                }
              >
                <Icon name="volume" />
                <span>{audioBlocked ? "Activar sonido" : "Sonido de la sala"}</span>
              </button>
            )}
          </div>
          {effectsOpen && (
            <CameraEffectsDialog
              current={media.cameraEffect}
              source={selfCamera?.track as LocalCameraTrack | undefined}
              onApply={media.applyCameraEffect}
              onClose={() => setEffectsOpen(false)}
            />
          )}
          {publishing && devicesOpen && (
            <LiveDevices switchDevice={media.switchActiveDevice} act={act} />
          )}
          {!publishing && testing && (
            <DeviceSetup onPreferences={setPreferences} suspended={busy} />
          )}
          {(error || media.error) && (
            <p className="error" role="alert">
              {error || media.error}
              {!room && (
                <button className="button" onClick={() => void join()}>
                  Reintentar
                </button>
              )}
            </p>
          )}
        </section>
        <aside className="gs-side">
          <section className="gs-card" aria-label="Tu cámara">
            <div className="gs-self">
              {selfCamera?.track && !selfCamera.isMuted ? (
                <TrackView track={selfCamera.track} muted />
              ) : (
                <span>Tu cámara está apagada</span>
              )}
            </div>
            <small>
              Tú{publishing ? "" : " · aún sin cámara ni micrófono"}
              {onProgram ? " · en el programa" : ""}
            </small>
          </section>
          <section className="gs-card" aria-label="En la sala">
            <b>En la sala</b>
            <ul className="gs-people">
              {people.length ? (
                people.map((p) => (
                  <li key={p.identity}>
                    <span>
                      {p.identity === identity
                        ? `${me.name} (tú)`
                        : stage?.names[p.identity] || p.name || "Participante"}
                    </span>
                    <Icon
                      name="mic"
                      size={13}
                      className={p.isMicrophoneEnabled ? "" : "muted"}
                      aria-label={p.isMicrophoneEnabled ? "Micrófono activo" : "Micrófono apagado"}
                    />
                  </li>
                ))
              ) : (
                <li>{room ? "Nadie más todavía" : "Entrando en la sala…"}</li>
              )}
            </ul>
          </section>
          <div className="gs-chat">
            <StudioChat docked me={{ id: me.id, role: "guest" }} sessionId={sessionId} />
          </div>
        </aside>
      </div>
    </div>
  );
}
