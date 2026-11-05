import { useState } from "react";
import { audioMode, loadAudioMode } from "./audio-quality";
import { DeviceSetup } from "./DeviceSetup";
import {
  assertMediaSupport,
  deviceError,
  type CapturePreferences,
} from "./devices";
import {
  participants,
  publication,
  useRoom,
  type MediaParticipant,
} from "./media";
import { MonitorAudio, TrackView } from "./Stage";

/** Permiso de cámara y audio que da el servidor de sesiones solo tras la admisión. */
async function guestCredentials() {
  const r = await fetch("/api/v1/guest/media");
  const body = await r.json().catch(() => ({}));
  if (!r.ok)
    throw Error(body.error || "No se pudo obtener el acceso a cámara y audio");
  return body as { url: string; token: string };
}

function Tile({ person, self }: { person: MediaParticipant; self: boolean }) {
  const camera = publication(person, "camera");
  const screen = publication(person, "screen_share");
  const shown = screen?.track && !screen.isMuted ? screen : camera;
  return (
    <figure className={`guest-tile ${self ? "self" : ""}`}>
      {shown?.track && !shown.isMuted ? (
        <TrackView track={shown.track} muted contain={shown === screen} />
      ) : (
        <div className="guest-tile-off">Cámara apagada</div>
      )}
      <figcaption>
        {self ? "Tú" : person.name || "Participante"}
        {!person.isMicrophoneEnabled && " · micrófono apagado"}
      </figcaption>
    </figure>
  );
}

/**
 * Cámara, micrófono y pantalla del invitado del servidor, una vez admitido. El anfitrión decide
 * desde su estudio quién sale en el programa; conectarse no emite a nadie por sí solo.
 */
export function GuestMedia() {
  const media = useRoom();
  const [preferences, setPreferences] = useState<CapturePreferences>({});
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
  const connect = () =>
    act(async () => {
      assertMediaSupport();
      setTesting(false);
      const room = await media.connect(await guestCredentials());
      if (preferences.quality)
        await media.setCameraQuality(preferences.quality);
      const mode = audioMode(preferences.audio ?? loadAudioMode());
      const outcomes = await Promise.allSettled([
        room.localParticipant.setMicrophoneEnabled(
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
  const room = media.room;
  const me = room?.localParticipant;
  const canShare =
    typeof navigator.mediaDevices?.getDisplayMedia === "function";
  return (
    <section className="guest-media" aria-label="Tu cámara y audio">
      {!room ? (
        <>
          <p>
            Ya puedes conectar tu cámara y tu micrófono. El anfitrión decide
            cuándo sales en el programa.
          </p>
          <div className="guest-controls">
            <button
              disabled={busy || media.busy}
              onClick={() => void connect()}
            >
              {busy || media.busy ? "Conectando…" : "Conectar cámara y audio"}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setTesting(!testing)}
            >
              {testing ? "Cerrar prueba" : "Probar dispositivos"}
            </button>
          </div>
          {testing && (
            <DeviceSetup onPreferences={setPreferences} suspended={busy} />
          )}
        </>
      ) : (
        <>
          <div className="guest-tiles">
            {participants(room).map((p) => (
              <Tile key={p.identity} person={p} self={p === me} />
            ))}
          </div>
          <MonitorAudio room={room} revision={media.revision} />
          <div className="guest-controls">
            <button
              className={me!.isMicrophoneEnabled ? "secondary" : "off"}
              onClick={() =>
                void act(() =>
                  me!.setMicrophoneEnabled(!me!.isMicrophoneEnabled),
                )
              }
            >
              {me!.isMicrophoneEnabled ? "Silenciar" : "Activar micrófono"}
            </button>
            <button
              className={me!.isCameraEnabled ? "secondary" : "off"}
              disabled={busy}
              onClick={() =>
                void act(() => media.setCameraEnabled(!me!.isCameraEnabled))
              }
            >
              {me!.isCameraEnabled ? "Apagar cámara" : "Activar cámara"}
            </button>
            {canShare && (
              <button
                className="secondary"
                onClick={() =>
                  void act(() =>
                    me!.setScreenShareEnabled(!me!.isScreenShareEnabled, {
                      audio: true,
                    }),
                  )
                }
              >
                {me!.isScreenShareEnabled
                  ? "Dejar de compartir"
                  : "Compartir pantalla"}
              </button>
            )}
            <button
              className="secondary"
              onClick={() => void act(() => room.startAudio())}
            >
              Activar audio de la sala
            </button>
            <button
              className="secondary"
              onClick={() => void act(() => media.disconnect())}
            >
              Salir de la sala
            </button>
          </div>
        </>
      )}
      {(error || media.error) && (
        <p className="error" role="alert">
          {error || media.error}
        </p>
      )}
    </section>
  );
}
