import React, { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { participants, publication, allowedTrack, type useRoom } from "./media";
import { Stage, TrackView } from "./Stage";
import { CameraEffectsDialog } from "./CameraEffectsDialog";
import type { LocalCameraTrack } from "./media";
import { DeviceSetup } from "./DeviceSetup";
import { BrandMark } from "./Brand";
import {
  assertMediaSupport,
  deviceError,
  type CapturePreferences,
} from "./devices";
import { Icon, LayoutThumb } from "./ui";
import { formatCountdown, shownSlate, slateNames } from "./slate";
import { useStoredFlag } from "./useFocusMode";
import { uploadAsset } from "./uploads";
import { assetUrl, playbackTime, playbackFinished, visibleIdentities } from "./composition";
import {
  initialProgram,
  destinationLabels,
  type OutputFormat,
  statusLabels,
  type Me,
  type Studio,
  type Program,
  type Person,
  type ContentMode,
  type SlateKind,
} from "./types";
type Action = (
  action: () => Promise<unknown>,
  message?: string,
) => Promise<void>;
interface Props {
  format?: OutputFormat;
  me: Me;
  studio: Studio;
  media: ReturnType<typeof useRoom>;
  pending: boolean;
  names: Record<string, string>;
  onProgram: (patch: Partial<Program>) => Promise<void>;
  onAction: Action;
  onConnect: () => Promise<void>;
  onPreferences: (preferences: CapturePreferences) => void;
  onSettings: () => void;
  focus?: boolean;
  onFocus?: (focus: boolean) => void;
  onInvite?: () => void;
  /** Escenas compactas del panel de foco. */
  scenes?: React.ReactNode;
}
const slateKinds: SlateKind[] = ["start", "pause", "end"];
const contentLabels = {
  side: "Contenido y cámaras",
  pip: "Cámara flotante",
  full: "Solo contenido",
};
function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "0:00";
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
}
import { ResourceMonitor } from "./ResourceMonitor";
import { RemoteLinkPill } from "./RemoteSessions";
import { CameraQualityDialog } from "./CameraQualityDialog";
export function StudioWorkspace({
  format = "landscape",
  me,
  studio,
  media,
  pending,
  names,
  onProgram,
  onAction,
  onConnect,
  onPreferences,
  onSettings,
  focus = false,
  onFocus,
  onInvite,
  scenes,
}: Props) {
  const admin = me.role === "admin",
    p = studio.program,
    broadcast = studio.broadcast;
  const running = Boolean(
    broadcast &&
    ["starting", "live", "reconnecting", "ending", "uncertain"].includes(
      broadcast.status,
    ),
  );
  // Emisión y grabación son servicios independientes de la misma sesión.
  const live = running && broadcast?.live !== false,
    recording = running && broadcast?.recording !== false,
    ending = broadcast?.status === "ending",
    independent = studio.independent_services !== false;
  const [recordWithLive, setRecordWithLive] = useState(false);
  const [panelTab, setPanelTab] = useState<"scenes" | "sources" | "settings">("scenes");
  const [panelClosed, setPanelClosed] = useStoredFlag("streamhive.focus-panel-closed");
  const activeSlate = studio.active_slate ?? null;
  const shown = shownSlate(studio.slates, activeSlate);
  const admitted =
    admin ||
    studio.participants.find((x) => x.id === me.id)?.status === "admitted";
  const [sourceTab, setSourceTab] = useState<"people" | "screens" | "files">(
    "people",
  );
  const [inspector, setInspector] = useState<"design" | "audio">("design");
  const [deviceOpen, setDeviceOpen] = useState(false);
  const [effectsOpen, setEffectsOpen] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [hint, setHint] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [duration, setDuration] = useState(0);
  const [mediaError, setMediaError] = useState("");
  const [clock, setClock] = useState(Date.now());
  const [scrub, setScrub] = useState<number | null>(null);
  const [previewAudio, setPreviewAudio] = useState(false);
  const upload = useRef<AbortController | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!p.media_asset && !focus) return;
    const timer = setInterval(() => setClock(Date.now()), p.media_asset ? 250 : 1000);
    return () => clearInterval(timer);
  }, [p.media_asset, focus]);
  useEffect(() => {
    setDuration(0);
    setMediaError("");
    setScrub(null);
    setPreviewAudio(false);
  }, [p.media_asset]);
  useEffect(() => () => upload.current?.abort(), []);
  const people = participants(media.room);
  const screens = people.filter((person) =>
    publication(person, "screen_share"),
  );
  const assets = studio.assets || [];
  const asset = assets.find((a) => a.id === p.media_asset);
  const content = p.layout === "screen";
  const waiting = studio.participants.filter((x) => x.status === "waiting");
  // Invitados temporales: los de la red local y los del servidor, en la sala o esperando.
  const guests = studio.participants.filter(
    (x) => x.status === "admitted" || x.status === "waiting",
  ).length;
  const cameraPeople: Person[] = [
    {
      id: "host",
      name: "Anfitrión",
      status: "admitted",
      connected:
        media.room?.localParticipant.identity === "host" ||
        Boolean(people.find((x) => x.identity === "host")),
    },
    ...studio.participants.filter((x) => x.status === "admitted"),
  ];
  const selectedPosition = playbackTime(
    p.playback,
    clock + (studio.clock_offset || 0),
    duration || Infinity,
  );
  const finished = playbackFinished(
    p.playback,
    clock + (studio.clock_offset || 0),
    duration,
  );
  const clearContent = () =>
    onProgram({
      layout: "grid",
      screen: null,
      media_asset: null,
      playback: { ...p.playback, playing: false },
    });
  const source = (identity: string) =>
    onProgram({
      layout: "screen",
      screen: identity,
      media_asset: null,
      content_mode: p.content_mode || "side",
      playback: { ...p.playback, playing: false },
    });
  const showAsset = (id: string) =>
    onProgram({
      layout: "screen",
      screen: null,
      media_asset: id,
      content_mode: p.content_mode || "side",
      playback: { ...initialProgram.playback },
    });
  const preset = (kind: string) => {
    if (kind === "grid" || kind === "spotlight" || kind === "featured") {
      void onProgram({
        layout: kind,
        screen: null,
        media_asset: null,
        spotlight: kind === "grid" ? null : p.spotlight || p.identities[0],
        playback: { ...p.playback, playing: false },
      });
      return;
    }
    const screen = p.screen;
    if (!screen && !p.media_asset) {
      void onProgram({ content_mode: kind as ContentMode });
      setSourceTab("screens");
      setHint(
        "Comparte una pantalla o elige un archivo para usar esta composición.",
      );
      return;
    }
    void onProgram({
      layout: "screen",
      screen: p.media_asset ? null : screen,
      content_mode: kind as ContentMode,
      spotlight: p.spotlight || p.identities[0] || null,
    });
  };
  const setPlayback = (patch: Partial<Program["playback"]>) =>
    onProgram({ playback: { ...p.playback, ...patch } });
  const add = (person: Person) => {
    const on = p.identities.includes(person.id);
    const identities = on
      ? p.identities.filter((id) => id !== person.id)
      : [...p.identities, person.id];
    return onProgram({
      identities,
      ...(on && p.spotlight === person.id
        ? {
            spotlight: null,
            ...(p.layout === "spotlight" ? { layout: "grid" as const } : {}),
          }
        : {}),
    });
  };
  const move = (id: string, direction: number) => {
    const identities = [...p.identities],
      i = identities.indexOf(id),
      j = i + direction;
    if (i < 0 || j < 0 || j >= identities.length) return;
    [identities[i], identities[j]] = [identities[j], identities[i]];
    void onProgram({ identities });
  };
  const spotlight = (id: string) =>
    onProgram({
      spotlight: id,
      identities: p.identities.includes(id)
        ? p.identities
        : [...p.identities, id],
      ...((content && p.content_mode === "pip") || p.layout === "featured"
        ? {}
        : {
            layout: "spotlight",
            screen: null,
            media_asset: null,
            playback: { ...p.playback, playing: false },
          }),
    });
  const share = () =>
    onAction(async () => {
      if (!media.room) {
        setHint("Conecta primero a la sala para compartir tu pantalla.");
        return;
      }
      await media.room.localParticipant.setScreenShareEnabled(
        !media.room.localParticipant.isScreenShareEnabled,
        { audio: true },
      );
      setSourceTab("screens");
    });
  const uploadFile = (file: File) =>
    onAction(async () => {
      upload.current = new AbortController();
      setProgress(0);
      try {
        await uploadAsset(file, setProgress, upload.current.signal);
        setSourceTab("files");
      } finally {
        setProgress(null);
        upload.current = null;
      }
    });
  const mediaInfo = (info: { duration: number; error?: string }) => {
    setDuration(info.duration);
    setMediaError(info.error || "");
  };
  if (!admitted)
    return (
      <section className="waiting panel">
        <BrandMark className="hive-mark" />
        <h2>Ya estás en la sala de espera</h2>
        <p>
          Tu cámara y micrófono no se comparten hasta que el anfitrión te
          admita.
        </p>
        <DeviceSetup />
      </section>
    );
  const screenCap = studio.limits?.on_screen ?? 6;
  const roomCap = studio.limits?.admitted ?? 10;
  const guestsInRoom = cameraPeople.length - 1;
  const roomFull = guestsInRoom >= roomCap;
  const screenFull = p.identities.length >= screenCap;
  const counters = (
    <>
      <Icon name="people" size={15} />
      <span title="Invitados admitidos en la sala">En sala {guestsInRoom}/{roomCap}</span>
      <span title="Cámaras en pantalla en este formato">En pantalla {p.identities.length}/{screenCap}</span>
    </>
  );
  const setLimits = (patch: { on_screen?: number; admitted?: number }) =>
    onAction(() =>
      api("/settings/limits", "PUT", { on_screen: screenCap, admitted: roomCap, ...patch }),
    );
  const visibleCount = visibleIdentities(p).length;
  const usedBySlate = (id: string) =>
    slateKinds.some(
      (kind) =>
        studio.slates?.[kind].background_asset === id ||
        studio.slates?.[kind].music_asset === id,
    );
  const compositionBar = admin && (
            <div className="composition-bar">
              <span>Composición</span>
              <div role="group" aria-label="Composición del programa">
                {[
                  { key: "grid", label: "Conversación" },
                  { key: "spotlight", label: "Protagonista" },
                  { key: "featured", label: "Con acompañantes" },
                  { key: "side", label: "Tutorial técnico" },
                  { key: "pip", label: "Cámara flotante" },
                  { key: "full", label: "Solo contenido" },
                ].map((item) => (
                  <button
                    key={item.key}
                    title={item.label}
                    aria-label={item.label}
                    aria-pressed={
                      item.key === p.layout ||
                      (content && item.key === p.content_mode)
                    }
                    className={
                      item.key === p.layout ||
                      (content && item.key === p.content_mode)
                        ? "selected"
                        : ""
                    }
                    disabled={
                      pending ||
                      ((item.key === "spotlight" || item.key === "featured") && !p.identities.length)
                    }
                    onClick={() => preset(item.key)}
                  >
                    <LayoutThumb kind={item.key} />
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            </div>
  );
  const sourceDeck = (
          <section className="source-deck">
            <div className="source-deck-heading">
              <div role="tablist" aria-label="Fuentes del estudio">
                {(
                  [
                    {
                      key: "people",
                      label: "Participantes",
                      icon: "people",
                      count: cameraPeople.length,
                    },
                    {
                      key: "screens",
                      label: "Pantallas",
                      icon: "monitor",
                      count: screens.length,
                    },
                    ...(admin
                      ? [
                          {
                            key: "files",
                            label: "Archivos",
                            icon: "image",
                            count: assets.length,
                          },
                        ]
                      : []),
                  ] as const
                ).map((item) => (
                  <button
                    key={item.key}
                    role="tab"
                    aria-selected={sourceTab === item.key}
                    className={sourceTab === item.key ? "active" : ""}
                    onClick={() => setSourceTab(item.key as typeof sourceTab)}
                  >
                    <Icon name={item.icon} size={16} />
                    {item.label}
                    <span>{item.count}</span>
                  </button>
                ))}
              </div>
              {admin && waiting.length > 0 && (
                <span className="waiting-count">
                  {waiting.length} en espera
                </span>
              )}
            </div>
            {sourceTab === "people" && (
              <>
                {admin && (
                  <div className="quota-controls">
                    <label>
                      Invitados en sala
                      <select
                        aria-label="Cupo de invitados en sala"
                        value={roomCap}
                        disabled={pending}
                        onChange={(e) => void setLimits({ admitted: Number(e.target.value) })}
                      >
                        {Array.from({ length: (studio.limits?.max_admitted ?? 10) + 1 }, (_, n) => (
                          <option key={n} value={n}>{n}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Cámaras en pantalla
                      <select
                        aria-label="Cupo de cámaras en pantalla"
                        value={screenCap}
                        disabled={pending}
                        onChange={(e) => void setLimits({ on_screen: Number(e.target.value) })}
                      >
                        {[1, 2, 3, 4, 5, 6].map((n) => (
                          <option key={n} value={n}>{n}</option>
                        ))}
                      </select>
                    </label>
                    {p.identities.length > screenCap && (
                      <small>Hay más cámaras que el cupo: quita alguna para respetarlo.</small>
                    )}
                    {guests > 0 && (
                      <button
                        className="text-button red retire-all"
                        disabled={pending}
                        title="Saca a todos los invitados de la sala y de la sala de espera, y anula sus enlaces"
                        onClick={() => {
                          if (
                            confirm(
                              `Se sacará a ${guests === 1 ? "1 invitado" : `${guests} invitados`} (en la sala y en espera) y dejarán de valer todos los enlaces de invitación. ¿Retirar a todos?`,
                            )
                          )
                            onAction(() => api("/participants/clear", "POST"));
                        }}
                      >
                        Retirar a todos
                      </button>
                    )}
                  </div>
                )}
                <div className="participant-list participant-strip">
                  {cameraPeople.map((person) => {
                    const participant = people.find(
                      (x) => x.identity === person.id,
                    );
                    const camera = publication(participant, "camera");
                    const on = p.identities.includes(person.id);
                    const order = p.identities.indexOf(person.id);
                    const visibleCamera = allowedTrack(p, person.id, "camera");
                    return (
                      <article
                        className={`participant-card ${on ? "on-air" : ""}`}
                        key={person.id}
                      >
                        <div className="participant-preview">
                          {camera?.track && !camera.isMuted ? (
                            <TrackView track={camera.track} muted />
                          ) : (
                            <span className="mini-avatar">
                              {person.name.slice(0, 1)}
                            </span>
                          )}
                          <span className={`card-tag ${on ? "selected" : ""}`}>
                            <i />
                            {on
                              ? visibleCamera
                                ? "EN PROGRAMA"
                                : p.microphones_enabled
                                  ? "SOLO AUDIO"
                                  : "CÁMARA OCULTA"
                              : person.connected
                                ? "EN SALA"
                                : "SIN CONEXIÓN"}
                          </span>
                          <span
                            className={`participant-mic ${participant?.isMicrophoneEnabled ? "" : "muted"}`}
                            title={
                              participant?.isMicrophoneEnabled
                                ? "Micrófono activo"
                                : "Micrófono apagado"
                            }
                          >
                            <Icon name="mic" size={12} />
                          </span>
                          {admin && (
                            <button
                              className="focus-button"
                              title={`Destacar ${person.name}`}
                              aria-label={`Destacar ${person.name}`}
                              disabled={pending}
                              onClick={() => spotlight(person.id)}
                            >
                              <Icon name="star" size={13} />
                            </button>
                          )}
                        </div>
                        <div className="participant-info">
                          <div>
                            <b>{person.name}</b>
                            <small>
                              {person.id === me.id
                                ? "Tú"
                                : person.id === "host"
                                  ? "Anfitrión"
                                  : "Invitado"}
                              {on ? ` · Posición ${order + 1}` : ""}
                            </small>
                          </div>
                          {admin && (
                            <button
                              className="source-add"
                              aria-label={`${on ? "Quitar" : "Añadir"} ${person.name}`}
                              title={
                                on
                                  ? "Quitar del programa"
                                  : screenFull
                                    ? `Cupo de ${screenCap} en pantalla completo`
                                    : "Añadir al programa"
                              }
                              disabled={pending || (!on && screenFull)}
                              onClick={() => add(person)}
                            >
                              <Icon name={on ? "check" : "plus"} size={16} />
                            </button>
                          )}
                        </div>
                        {admin && (
                          <div className="participant-actions">
                            {on && (
                              <>
                                <button
                                  aria-label={`Mover ${person.name} antes`}
                                  disabled={pending || order === 0}
                                  onClick={() => move(person.id, -1)}
                                >
                                  <Icon name="left" size={13} />
                                </button>
                                <button
                                  aria-label={`Mover ${person.name} después`}
                                  disabled={
                                    pending || order === p.identities.length - 1
                                  }
                                  onClick={() => move(person.id, 1)}
                                >
                                  <Icon name="right" size={13} />
                                </button>
                              </>
                            )}
                            {person.id !== "host" && (
                              <details className="participant-menu">
                                <summary
                                  aria-label={`Opciones de ${person.name}`}
                                >
                                  •••
                                </summary>
                                <div>
                                  <button
                                    onClick={() =>
                                      onAction(() =>
                                        api(
                                          `/participants/${person.id}`,
                                          "POST",
                                          { action: "mute" },
                                        ),
                                      )
                                    }
                                  >
                                    Silenciar micrófono
                                  </button>
                                  <button
                                    onClick={() =>
                                      onAction(() =>
                                        api(
                                          `/participants/${person.id}`,
                                          "POST",
                                          { action: "wait" },
                                        ),
                                      )
                                    }
                                  >
                                    Volver a espera
                                  </button>
                                  <button
                                    onClick={() =>
                                      onAction(() =>
                                        api(
                                          `/participants/${person.id}`,
                                          "POST",
                                          { action: "remove" },
                                        ),
                                      )
                                    }
                                  >
                                    Expulsar
                                  </button>
                                </div>
                              </details>
                            )}
                          </div>
                        )}
                      </article>
                    );
                  })}
                  <button
                    className="add-source-card"
                    onClick={() => setSourceTab("screens")}
                  >
                    <Icon name="plus" size={25} />
                    <b>Comparte contenido</b>
                    <small>Pantalla, imagen o video</small>
                  </button>
                </div>
                <p className="source-caption">
                  {admin
                    ? "Usa + para añadir al programa. Las flechas cambian el orden; la estrella destaca una cámara."
                    : "Tu cámara y micrófono están en la sala. El anfitrión elige qué aparece en el programa."}
                </p>
              </>
            )}
            {sourceTab === "screens" && (
              <div className="screens-deck">
                {screens.length > 0 ? (
                  <div className="screen-source-list">
                    {screens.map((person) => (
                      <article
                        className={`screen-source ${p.screen === person.identity ? "selected" : ""}`}
                        key={person.identity}
                      >
                        <div>
                          <TrackView
                            track={publication(person, "screen_share")?.track}
                            muted
                            contain
                          />
                        </div>
                        <b>
                          Pantalla de {names[person.identity] || person.name}
                        </b>
                        {admin && (
                          <button
                            className="button"
                            disabled={pending}
                            onClick={() => source(person.identity)}
                          >
                            {p.screen === person.identity
                              ? "En programa"
                              : "Mostrar en programa"}
                          </button>
                        )}
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="source-empty">
                    <Icon name="monitor" size={30} />
                    <h3>Tu contenido, en primer plano</h3>
                    <p>
                      Comparte la ventana del editor, la presentación o el
                      manual.
                      <br />
                      Su proporción se conserva para que el texto no se recorte.
                    </p>
                    <button
                      className="button"
                      onClick={share}
                      disabled={!media.room}
                    >
                      <Icon name="plus" size={15} />
                      Compartir pantalla
                    </button>
                  </div>
                )}
              </div>
            )}
            {sourceTab === "files" && admin && (
              <div
                className="file-deck"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  const file = event.dataTransfer.files[0];
                  if (file && progress === null) void uploadFile(file);
                }}
              >
                <div className="library-heading">
                  <p>Imágenes y videos para tu programa, y música para las pantallas.</p>
                  <button
                    className="button"
                    disabled={progress !== null}
                    onClick={() => fileRef.current?.click()}
                  >
                    <Icon name="upload" size={15} />
                    Subir archivo
                  </button>
                </div>
                {progress !== null && (
                  <div className="upload-progress">
                    <progress value={progress} max={100} />
                    <span>{progress}%</span>
                    <button
                      className="text-button"
                      onClick={() => upload.current?.abort()}
                    >
                      Cancelar
                    </button>
                  </div>
                )}
                {assets.length > 0 ? (
                  <div className="asset-library">
                    {assets.map((item) => (
                      <article
                        className={`asset-card ${p.media_asset === item.id ? "selected" : ""}`}
                        key={item.id}
                      >
                        <div className="asset-thumbnail">
                          {item.kind === "image" ? (
                            <img
                              src={assetUrl(item.id)}
                              alt=""
                              loading="lazy"
                            />
                          ) : item.kind === "audio" ? (
                            <span>
                              <Icon name="volume" size={18} />
                            </span>
                          ) : (
                            <>
                              <video
                                src={assetUrl(item.id)}
                                muted
                                playsInline
                                preload="metadata"
                              />
                              <span>
                                <Icon name="play" size={18} />
                              </span>
                            </>
                          )}
                          <span className="asset-kind">
                            {item.kind === "video"
                              ? "VIDEO"
                              : item.kind === "audio"
                                ? "AUDIO"
                                : "IMAGEN"}
                          </span>
                        </div>
                        <b title={item.name}>{item.name}</b>
                        <small>
                          {(item.bytes / 1024 / 1024).toFixed(1)} MB
                        </small>
                        <div>
                          {item.kind === "audio" ? (
                            <small>Música para pantallas</small>
                          ) : (
                            <button
                              className="button"
                              disabled={pending}
                              onClick={() =>
                                p.media_asset === item.id
                                  ? clearContent()
                                  : showAsset(item.id)
                              }
                            >
                              {p.media_asset === item.id ? "Retirar" : "Mostrar"}
                            </button>
                          )}
                          <button
                            className="quiet-icon"
                            title="Eliminar archivo"
                            aria-label={`Eliminar ${item.name}`}
                            disabled={
                              p.media_asset === item.id ||
                              p.background_asset === item.id ||
                              usedBySlate(item.id) ||
                              pending
                            }
                            onClick={() => {
                              if (
                                confirm(
                                  `¿Eliminar «${item.name}» de la biblioteca?`,
                                )
                              )
                                void onAction(() =>
                                  api(`/assets/${item.id}`, "DELETE"),
                                );
                            }}
                          >
                            <Icon name="trash" size={14} />
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <button
                    className="upload-dropzone"
                    onClick={() => fileRef.current?.click()}
                  >
                    <Icon name="upload" size={30} />
                    <b>Arrastra una imagen o un video</b>
                    <span>o haz clic para buscar en tu equipo</span>
                    <small>PNG, JPG, WebP · 20 MB / MP4, WebM · 500 MB / MP3, OGG, WAV, M4A · 50 MB</small>
                  </button>
                )}
                <p className="source-caption">
                  Los archivos se guardan en tu servidor. Un video entra en
                  pausa para que decidas cuándo reproducirlo. Para manuales PDF,
                  comparte su ventana.
                </p>
              </div>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,audio/mpeg,audio/ogg,audio/wav,audio/mp4,.mp3,.ogg,.wav,.m4a"
              className="visually-hidden"
              aria-label="Subir imagen, video o audio"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void uploadFile(file);
              }}
            />
          </section>
  );
  const waitingList = admin && waiting.length > 0 && (
            <section className="waiting-list">
              <div>
                <h3>Sala de espera</h3>
                <span>
                  {waiting.length} pendiente{waiting.length !== 1 ? "s" : ""}
                </span>
              </div>
              {waiting.map((person) => (
                <div className="waiting-person" key={person.id}>
                  <span className="mini-avatar">{person.name.slice(0, 1)}</span>
                  <b>{person.name}</b>
                  <small>{roomFull ? `Cupo de ${roomCap} en sala completo` : "Esperando admisión"}</small>
                  <button
                    className="button primary"
                    disabled={pending || roomFull}
                    title={roomFull ? "Sube el cupo o saca a alguien de la sala" : undefined}
                    onClick={() =>
                      onAction(() =>
                        api(`/participants/${person.id}`, "POST", {
                          action: "admit",
                        }),
                      )
                    }
                  >
                    Admitir
                  </button>
                  <button
                    className="quiet-icon"
                    aria-label={`Rechazar ${person.name}`}
                    onClick={() =>
                      onAction(() =>
                        api(`/participants/${person.id}`, "POST", {
                          action: "remove",
                        }),
                      )
                    }
                  >
                    <Icon name="close" size={15} />
                  </button>
                </div>
              ))}
            </section>
  );
  const inspectorPanel = (
          <aside className="workspace-inspector">
            <div
              className="inspector-tabs"
              role="tablist"
              aria-label="Ajustes del programa"
            >
              <button
                role="tab"
                aria-selected={inspector === "design"}
                onClick={() => setInspector("design")}
              >
                <Icon name="grid" size={15} />
                Escenario
              </button>
              <button
                role="tab"
                aria-selected={inspector === "audio"}
                onClick={() => setInspector("audio")}
              >
                <Icon name="volume" size={15} />
                Audio
              </button>
            </div>
            {inspector === "design" ? (
              <>
                <section className="inspector-section">
                  <div className="inspector-section-heading">
                    <h3>
                      {content
                        ? "Contenido al centro"
                        : "Una buena conversación"}
                    </h3>
                    <span className="subtle-label">{format === "portrait" ? "9:16" : "16:9"}</span>
                  </div>
                  <p>
                    {content
                      ? "Código, diapositivas y manuales completos. Sin estirar ni recortar."
                      : "Las cámaras mantienen una proporción equilibrada, también con dos o tres participantes."}
                  </p>
                  {content && (
                    <>
                      <label>
                        Distribución del contenido
                        <select
                          value={p.content_mode}
                          onChange={(e) =>
                            onProgram({
                              content_mode: e.target.value as ContentMode,
                            })
                          }
                        >
                          {Object.entries(contentLabels).map(([key, label]) => (
                            <option value={key} key={key}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                      {p.content_mode === "pip" && (
                        <>
                          <label>
                            Cámara flotante
                            <select
                              value={p.spotlight || p.identities[0] || ""}
                              onChange={(e) =>
                                onProgram({ spotlight: e.target.value })
                              }
                            >
                              <option value="" disabled>
                                Selecciona una cámara
                              </option>
                              {p.identities.map((id) => (
                                <option value={id} key={id}>
                                  {names[id]}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            Posición
                            <select
                              aria-label="Posición de cámara"
                              value={p.pip_position}
                              onChange={(e) =>
                                onProgram({
                                  pip_position: e.target
                                    .value as Program["pip_position"],
                                })
                              }
                            >
                              <option value="bottom_right">
                                Abajo a la derecha
                              </option>
                              <option value="bottom_left">
                                Abajo a la izquierda
                              </option>
                              <option value="top_right">
                                Arriba a la derecha
                              </option>
                              <option value="top_left">
                                Arriba a la izquierda
                              </option>
                            </select>
                          </label>
                        </>
                      )}
                    </>
                  )}
                  {(p.layout === "spotlight" || p.layout === "featured") && (
                    <label>
                      Protagonista
                      <select
                        value={p.spotlight || ""}
                        onChange={(e) =>
                          onProgram({ spotlight: e.target.value })
                        }
                      >
                        {p.identities.map((id) => (
                          <option key={id} value={id}>
                            {names[id]}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <div className="tutorial-tip">
                    <Icon name={content ? "monitor" : "people"} size={17} />
                    <p>
                      {content
                        ? "¿El texto se ve pequeño? Usa «Solo contenido» mientras explicas el código o el manual."
                        : "En un conversatorio, añade a los participantes y ordénalos con las flechas. Destaca a quien presenta con la estrella."}
                    </p>
                  </div>
                </section>
                <section className="inspector-section">
                  <h3>Identidad del programa</h3>
                  <label className="switch-row">
                    Mostrar nombres
                    <input
                      type="checkbox"
                      checked={p.names}
                      disabled={pending}
                      onChange={(e) => onProgram({ names: e.target.checked })}
                    />
                  </label>
                  <label>
                    Fondo del escenario
                    <select
                      aria-label="Imagen de fondo del escenario"
                      value={p.background_asset || ""}
                      disabled={pending}
                      onChange={(e) =>
                        onProgram({ background_asset: e.target.value || null })
                      }
                    >
                      <option value="">Color sólido</option>
                      {assets
                        .filter((a) => a.kind === "image")
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <p>Sube imágenes desde Archivos para usarlas como fondo.</p>
                  <div className="background-palette">
                    {[
                      "#101923",
                      "#172820",
                      "#202032",
                      "#2d2027",
                      "#142f38",
                      "#111111",
                    ].map((color) => (
                      <button
                        key={color}
                        style={{ background: color }}
                        title={`Fondo ${color}`}
                        aria-label={`Fondo ${color}`}
                        aria-pressed={
                          !p.background_asset && p.background === color
                        }
                        disabled={pending}
                        onClick={() =>
                          onProgram({
                            background: color,
                            background_asset: null,
                          })
                        }
                      >
                        {!p.background_asset && p.background === color && (
                          <Icon name="check" size={15} />
                        )}
                      </button>
                    ))}
                  </div>
                  <label className="logo-upload">
                    <Icon name="image" size={15} />
                    {p.logo ? "Cambiar logo" : "Añadir tu logo"}
                    <input
                      type="file"
                      accept="image/png,image/jpeg"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (!file) return;
                        void onAction(async () => {
                          if (file.size > 290000)
                            throw Error("El logo debe pesar menos de 290 KB");
                          const value = await new Promise<string>(
                            (resolve, reject) => {
                              const reader = new FileReader();
                              reader.onload = () =>
                                resolve(String(reader.result));
                              reader.onerror = () =>
                                reject(Error("No se pudo leer el logo"));
                              reader.readAsDataURL(file);
                            },
                          );
                          await onProgram({ logo: value });
                        });
                      }}
                    />
                  </label>
                  {p.logo && (
                    <button
                      className="text-button"
                      onClick={() => onProgram({ logo: null })}
                    >
                      Quitar logo
                    </button>
                  )}
                </section>
              </>
            ) : (
              <section className="inspector-section">
                <h3>Lo que escucha tu audiencia</h3>
                <label className="switch-row">
                  Micrófonos en programa
                  <input
                    type="checkbox"
                    checked={p.microphones_enabled}
                    disabled={pending}
                    onChange={(e) =>
                      onProgram({ microphones_enabled: e.target.checked })
                    }
                  />
                </label>
                <p>
                  Solo se incluyen los micrófonos de las personas añadidas al
                  programa. Pueden seguir conversando en la sala cuando los
                  retires.
                </p>
                {content && p.screen && (
                  <label className="switch-row">
                    Audio de pantalla
                    <input
                      type="checkbox"
                      checked={p.screen_audio}
                      onChange={(e) =>
                        onProgram({ screen_audio: e.target.checked })
                      }
                    />
                  </label>
                )}
                {asset?.kind === "video" && (
                  <label>
                    Volumen del video · {Math.round(p.playback.volume * 100)}%
                    <input
                      aria-label="Volumen del video"
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      defaultValue={p.playback.volume}
                      onPointerUp={(e) =>
                        setPlayback({ volume: Number(e.currentTarget.value) })
                      }
                      onKeyUp={(e) =>
                        setPlayback({ volume: Number(e.currentTarget.value) })
                      }
                    />
                  </label>
                )}
                <div className="tutorial-tip">
                  <Icon name="volume" size={17} />
                  <p>
                    Usa auriculares para evitar eco. El audio de una pestaña se
                    comparte solo si lo permites en el navegador y aquí.
                  </p>
                </div>
              </section>
            )}
            <section className="inspector-destination">
              <div>
                <span className="destination-logo">▶</span>
                <div>
                  <b>
                    {studio.destination_configured
                      ? (() => {
                          const on = (studio.destinations ?? []).filter((d) => d.enabled);
                          return on.length > 1 ? `${on.length} destinos activos` : "Destino preparado";
                        })()
                      : "Prepara tu directo"}
                  </b>
                  <small>
                    {studio.destination_configured
                      ? (studio.destinations ?? [])
                          .filter((d) => d.enabled)
                          .map((d) => d.name)
                          .join(" · ") || "1080p"
                      : "Configura YouTube, Twitch u otro destino RTMP"}
                  </small>
                </div>
              </div>
              <ul className="output-status-list" aria-label="Estado de cada destino">
                {(studio.destinations ?? []).filter((d) => d.enabled).map((d) => <li key={d.id}>
                  <span><b>{d.name}</b> · {d.format === "portrait" ? "9:16" : "16:9"}<small role="status">{destinationLabels[d.status] ?? "Preparado"}</small></span>
                  {running && ["reconnecting", "finished"].includes(d.status) && <button className="text-button" disabled={pending}
                    onClick={() => void onAction(() => api(`/broadcast/retry?destination_id=${encodeURIComponent(d.id)}`, "POST"))}>Reintentar</button>}
                </li>)}
              </ul>
              <button className="text-button" onClick={onSettings}>
                {studio.destination_configured
                  ? "Gestionar destinos"
                  : "Configurar destino"}
                <Icon name="arrow" size={13} />
              </button>
            </section>
          </aside>
  );
  const returnLabel = [
    p.layout === "grid"
      ? "Conversación"
      : p.layout === "spotlight"
        ? "Protagonista"
        : p.layout === "featured"
          ? "Con acompañantes"
        : contentLabels[p.content_mode || "side"],
    p.identities.length === 1 ? "1 cámara" : `${p.identities.length} cámaras`,
  ].join(" · ");
  const slateControls = studio.slates && (
    <div className="slate-controls" role="group" aria-label="Pantallas de la emisión">
      {slateKinds.map((kind) => (
        <button
          key={kind}
          className={`slate-button ${activeSlate?.kind === kind ? "is-on" : ""}`}
          aria-pressed={activeSlate?.kind === kind}
          aria-label={`Pantalla de ${slateNames[kind].toLowerCase()}`}
          title={studio.slates![kind].title}
          disabled={pending || activeSlate?.kind === kind}
          onClick={() => onAction(() => api(`/slates/${kind}/show`, "POST"))}
        >
          {slateNames[kind]}
        </button>
      ))}
      <button
        className="quiet-icon"
        aria-label="Configurar pantallas"
        title="Configurar pantallas"
        onClick={onSettings}
      >
        <Icon name="settings" size={14} />
      </button>
      {activeSlate && (
        <span className="slate-return">
          <button
            className="button primary"
            disabled={pending}
            onClick={() => onAction(() => api("/slates/hide", "POST"))}
          >
            Volver al programa
          </button>
          <small title={returnLabel}>{returnLabel}</small>
        </span>
      )}
    </div>
  );
  const elapsed = broadcast ? Math.max(0, (clock + (studio.clock_offset || 0)) / 1000 - broadcast.created) : 0;
  const airing = (studio.destinations ?? []).filter((d) => d.enabled);
  const focusStrip = (
    <div className="focus-strip">
      <span className={`broadcast-state ${broadcast?.status === "live" && live ? "is-live" : ""}`}>
        <i />
        {broadcast
          ? broadcast.status === "live" && !live
            ? statusLabels.recording
            : statusLabels[broadcast.status]
          : "Preparando"}
      </span>
      {running && <span className="focus-clock" role="timer" aria-label="Tiempo de la sesión">{formatCountdown(elapsed)}</span>}
      {recording && (
        <span className="focus-rec">
          <i className="record-mark" aria-hidden="true" />
          REC
        </span>
      )}
      {live && airing.length > 0 && (
        <span className="focus-destinations">
          {airing.map((d) => (
            <span key={d.id} className={`focus-destination is-${d.status}`} title={`${d.name}: ${destinationLabels[d.status]}`}>
              <i />
              {d.name}
            </span>
          ))}
        </span>
      )}
      <span className="session-meta">
        {counters}
      </span>
      {waiting.length > 0 && (
        <button
          className="button focus-waiting"
          onClick={() => {
            setPanelClosed(false);
            setPanelTab("sources");
            setSourceTab("people");
          }}
        >
          {waiting.length === 1 ? "1 persona espera" : `${waiting.length} personas esperan`}
        </button>
      )}
      <span className="focus-strip-end">
        {admin && <RemoteLinkPill version={studio} />}
        <ResourceMonitor />
        {onInvite && (
          <button className="button" disabled={pending} onClick={onInvite}>
            Invitar
          </button>
        )}
        <button className="button" onClick={() => onFocus?.(false)}>
          Salir del foco
        </button>
      </span>
    </div>
  );
  const panelTabs = [
    { key: "scenes", label: "Escenas", icon: "grid" },
    { key: "sources", label: "Fuentes", icon: "people" },
    { key: "settings", label: "Ajustes", icon: "settings" },
  ] as const;
  const focusPanel = (
    <aside className={`focus-panel ${panelClosed ? "is-closed" : ""}`} aria-label="Panel del estudio">
      <div className="focus-panel-tabs" role="tablist" aria-label="Panel del estudio">
        {panelTabs.map((item) => (
          <button
            key={item.key}
            role="tab"
            aria-selected={!panelClosed && panelTab === item.key}
            title={item.label}
            className={!panelClosed && panelTab === item.key ? "active" : ""}
            onClick={() => {
              setPanelTab(item.key);
              setPanelClosed(false);
            }}
          >
            <Icon name={item.icon} size={15} />
            <span>{item.label}</span>
          </button>
        ))}
        <button
          className="focus-panel-toggle"
          aria-label={panelClosed ? "Abrir panel" : "Cerrar panel"}
          aria-expanded={!panelClosed}
          title={panelClosed ? "Abrir panel" : "Cerrar panel"}
          onClick={() => setPanelClosed(!panelClosed)}
        >
          {panelClosed ? "‹" : "›"}
        </button>
      </div>
      {!panelClosed && (
        <div className="focus-panel-body" role="tabpanel">
          {panelTab === "scenes" && scenes}
          {panelTab === "sources" && (
            <>
              {waitingList}
              {sourceDeck}
            </>
          )}
          {panelTab === "settings" && inspectorPanel}
        </div>
      )}
    </aside>
  );
  const broadcastBar = (
        <footer className="workspace-broadcast-bar">
          <div className="broadcast-summary">
            <span
              className={`ready-indicator ${studio.destination_configured ? "ready" : ""}`}
            />
            <div>
              <b>
                {live && recording
                  ? "En directo y grabando"
                  : live
                    ? "En directo, sin grabar"
                    : recording
                      ? "Grabando, sin emitir"
                      : studio.destination_configured
                    ? "Listo para salir al aire"
                    : "Prepara tu programa a tu ritmo"}
              </b>
              <small>
                {running
                  ? "Mantén el estudio abierto hasta terminar"
                  : "Vista previa privada hasta que emitas o grabes"}
              </small>
            </div>
          </div>
          {slateControls}
          {focus && compositionBar}
          <div>
            {independent ? (
              <>
                <button
                  className={`button ${recording ? "danger" : ""} broadcast-button`}
                  disabled={pending || ending}
                  aria-pressed={recording}
                  onClick={() =>
                    onAction(() =>
                      api(`/recording/${recording ? "stop" : "start"}`, "POST"),
                    )
                  }
                >
                  <i className="record-mark" aria-hidden="true" />
                  {recording ? "Detener grabación" : "Grabar"}
                </button>
                <button
                  className={`button ${live ? "danger" : "primary"} broadcast-button`}
                  disabled={
                    pending ||
                    ending ||
                    (!live && !studio.destination_configured)
                  }
                  aria-pressed={live}
                  onClick={() =>
                    onAction(() =>
                      api(`/broadcast/${live ? "stop" : "start"}`, "POST"),
                    )
                  }
                >
                  <Icon name={live ? "close" : "play"} size={16} />
                  {pending
                    ? "Procesando…"
                    : live
                      ? "Finalizar directo"
                      : "Iniciar directo"}
                </button>
              </>
            ) : running ? (
              <button
                className="button danger broadcast-button"
                disabled={pending || ending}
                onClick={() =>
                  onAction(() => api("/broadcast/stop?all=true", "POST"))
                }
              >
                <Icon name="close" size={16} />
                {pending ? "Procesando…" : "Finalizar sesión"}
              </button>
            ) : (
              <>
                <label className="record-option">
                  <input
                    type="checkbox"
                    checked={recordWithLive}
                    onChange={(e) => setRecordWithLive(e.target.checked)}
                  />
                  Grabar también
                </label>
                <button
                  className="button broadcast-button"
                  disabled={pending}
                  onClick={() =>
                    onAction(() => api("/recording/start", "POST"))
                  }
                >
                  <i className="record-mark" aria-hidden="true" />
                  Solo grabar
                </button>
                <button
                  className="button primary broadcast-button"
                  disabled={pending || !studio.destination_configured}
                  onClick={() =>
                    onAction(() =>
                      api(
                        `/broadcast/start${recordWithLive ? "?record=true" : ""}`,
                        "POST",
                      ),
                    )
                  }
                >
                  <Icon name="play" size={16} />
                  {pending ? "Procesando…" : "Iniciar directo"}
                </button>
              </>
            )}
          </div>
        </footer>
  );
  return (
    <div className={`studio-workspace ${focus ? "is-focus" : ""}`}>
      {focus && focusStrip}
      {!focus && <div className="workspace-heading">
        <div>
          <span className="section-kicker">ESTUDIO PERSONAL</span>
          <h2>
            Mi estudio <span className="pill">{format === "portrait" ? "9:16" : "16:9"} · 1080p · 30 fps</span>
          </h2>
        </div>
        <div className="workspace-heading-right">
          {admin && <ResourceMonitor />}
          <span
            className={`broadcast-state ${broadcast?.status === "live" && live ? "is-live" : ""}`}
          >
            <i />
            {broadcast
              ? broadcast.status === "live" && !live
                ? statusLabels.recording
                : statusLabels[broadcast.status]
              : "Preparando"}
          </span>
          <span className="session-meta">
            {counters}
          </span>
          {admin && onFocus && (
            <button className="button" onClick={() => onFocus(true)}>
              <Icon name="maximize" size={14} />
              Modo foco
            </button>
          )}
        </div>
      </div>}
      {!admin && shown && (
        <div className="alert">
          Se está mostrando una pantalla de {slateNames[activeSlate!.kind].toLowerCase()}: ahora no estás al aire, y el público no te ve ni te oye.
        </div>
      )}
      <div className={`studio-grid ${admin ? "" : "guest-workspace"}`}>
        <section className="workspace-main">
          <div className="studio-preview" ref={stageRef}>
            <div className="preview-title">
              <span>
                <Icon name="eye" size={14} /> VISTA DEL PROGRAMA
              </span>
              <div>
                {shown ? (
                  <span>Pantalla de {slateNames[activeSlate!.kind].toLowerCase()} al aire</span>
                ) : content ? (
                  <span className="preview-source-name">
                    {asset?.name ||
                      `Pantalla de ${names[p.screen || ""] || "invitado"}`}
                  </span>
                ) : (
                  <span>Cámaras · {p.identities.length} en programa</span>
                )}
                <button
                  className="quiet-icon"
                  aria-label="Ampliar vista previa"
                  title="Ampliar vista previa"
                  onClick={() => void stageRef.current?.requestFullscreen()}
                >
                  <Icon name="maximize" size={15} />
                </button>
              </div>
            </div>
            <Stage
              format={format}
              program={p}
              slate={shown}
              room={media.room}
              names={names}
              revision={media.revision}
              assets={assets}
              clockOffset={studio.clock_offset || 0}
              onMediaInfo={mediaInfo}
              previewAudio={previewAudio}
            />
            <div className="program-status">
              <span>
                <i className={running ? "live-dot" : ""} />
                {live
                  ? "Programa en emisión"
                  : recording
                    ? "Programa en grabación"
                    : "La emisión aún no ha comenzado"}
              </span>
              {shown ? (
                <span className="audio-off">
                  <Icon name="mic" size={12} /> Cámaras y micrófonos fuera del aire
                  {shown.slate.music_asset ? " · con música" : ""}
                </span>
              ) : !p.microphones_enabled ? (
                <span className="audio-off">
                  <Icon name="mic" size={12} /> Micrófonos fuera del programa
                </span>
              ) : (
                <span className={p.identities.length > visibleCount ? "audio-off" : ""}>
                  <Icon name="mic" size={12} />
                  {visibleCount === 1 ? "1 cámara visible" : `${visibleCount} cámaras visibles`} ·{" "}
                  {p.identities.length === 1 ? "1 voz al aire" : `${p.identities.length} voces al aire`}
                </span>
              )}
            </div>
          </div>
          {!focus && compositionBar}
          {content && admin && (
            <div className="content-toolbar">
              <div>
                <Icon
                  name={
                    asset?.kind === "video"
                      ? "film"
                      : asset
                        ? "image"
                        : "monitor"
                  }
                />
                <span title={asset?.name}>
                  {asset?.name ||
                    `Pantalla de ${names[p.screen || ""] || "invitado"}`}
                </span>
                <span className="pill">Sin recortes</span>
              </div>
              <button
                className="text-button"
                disabled={pending}
                onClick={clearContent}
              >
                <Icon name="close" size={14} /> Retirar del programa
              </button>
            </div>
          )}
          {asset?.kind === "video" && content && admin && (
            <div className="clip-controls">
              <button
                className="clip-play"
                aria-label={
                  p.playback.playing && !finished
                    ? "Pausar video"
                    : "Reproducir video"
                }
                disabled={pending || Boolean(mediaError)}
                onClick={() =>
                  setPlayback({
                    playing: !p.playback.playing || finished,
                    position:
                      selectedPosition >= duration - 0.1 ? 0 : selectedPosition,
                    started_at_ms: null,
                  })
                }
              >
                <Icon
                  name={p.playback.playing && !finished ? "pause" : "play"}
                  size={17}
                />
              </button>
              <button
                className="quiet-icon"
                aria-label="Reiniciar video"
                disabled={pending}
                onClick={() =>
                  setPlayback({
                    position: 0,
                    playing: true,
                    started_at_ms: null,
                  })
                }
              >
                <Icon name="refresh" size={15} />
              </button>
              <span className="clip-time">
                {formatTime(scrub ?? selectedPosition)} / {formatTime(duration)}
              </span>
              <input
                aria-label="Posición del video"
                type="range"
                min={0}
                max={duration || 1}
                step={0.1}
                value={scrub ?? Math.min(selectedPosition, duration || 1)}
                onChange={(e) => setScrub(Number(e.target.value))}
                onPointerUp={() => {
                  if (scrub !== null) {
                    void setPlayback({ position: scrub, started_at_ms: null });
                    setScrub(null);
                  }
                }}
                onKeyUp={() => {
                  if (scrub !== null) {
                    void setPlayback({ position: scrub, started_at_ms: null });
                    setScrub(null);
                  }
                }}
              />
              <button
                className={`quiet-icon ${previewAudio ? "selected" : ""}`}
                aria-label={
                  previewAudio
                    ? "Dejar de escuchar archivo"
                    : "Escuchar archivo en este equipo"
                }
                title="Escuchar archivo en este equipo"
                onClick={() => setPreviewAudio(!previewAudio)}
              >
                <Icon name="volume" size={16} />
              </button>
              <label className="clip-loop">
                <input
                  type="checkbox"
                  checked={p.playback.looped}
                  onChange={(e) => setPlayback({ looped: e.target.checked })}
                />
                Repetir
              </label>
            </div>
          )}
          {mediaError && <div className="alert error">{mediaError}</div>}
          {hint && (
            <div className="studio-hint">
              <Icon name="monitor" size={16} />
              <span>{hint}</span>
              <button
                className="quiet-icon"
                aria-label="Cerrar ayuda"
                onClick={() => setHint("")}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          )}
          <div className="studio-controls">
            <button
              className="control-button"
              onClick={() => setEffectsOpen(true)}
            >
              <Icon name="camera" />
              <span>Efectos de cámara</span>
            </button>
            <button
              className="control-button"
              onClick={() => setQualityOpen(true)}
            >
              <Icon name="camera" />
              <span>Calidad de cámara</span>
            </button>
            {!media.room ? (
              <>
                <button
                  className="button primary"
                  disabled={media.busy || pending}
                  onClick={onConnect}
                >
                  <Icon name="camera" />
                  {media.busy
                    ? "Conectando a la sala…"
                    : "Conectar cámara y audio"}
                </button>
                <button
                  className="button"
                  onClick={() => setDeviceOpen(!deviceOpen)}
                >
                  <Icon name="settings" />
                  Probar dispositivos
                </button>
              </>
            ) : (
              <>
                <button
                  className={`control-button ${media.room.localParticipant.isMicrophoneEnabled ? "" : "is-off"}`}
                  title="Control de tu micrófono en la sala"
                  onClick={() =>
                    onAction(() =>
                      media.room!.localParticipant.setMicrophoneEnabled(
                        !media.room!.localParticipant.isMicrophoneEnabled,
                      ),
                    )
                  }
                >
                  <Icon name="mic" />
                  <span>
                    {media.room.localParticipant.isMicrophoneEnabled
                      ? "Silenciar"
                      : "Activar micrófono"}
                  </span>
                </button>
                <button
                  className={`control-button ${media.room.localParticipant.isCameraEnabled ? "" : "is-off"}`}
                  disabled={pending || media.busy}
                  onClick={() =>
                    onAction(() =>
                      media.setCameraEnabled(
                        !media.room!.localParticipant.isCameraEnabled,
                      ),
                    )
                  }
                >
                  <Icon name="camera" />
                  <span>
                    {media.room.localParticipant.isCameraEnabled
                      ? "Apagar cámara"
                      : "Activar cámara"}
                  </span>
                </button>
                <span className="control-divider" />
                {typeof navigator.mediaDevices?.getDisplayMedia ===
                  "function" && (
                  <button
                    className={`control-button ${media.room.localParticipant.isScreenShareEnabled ? "sharing" : ""}`}
                    onClick={share}
                  >
                    <Icon name="monitor" />
                    <span>
                      {media.room.localParticipant.isScreenShareEnabled
                        ? "Dejar de compartir"
                        : "Compartir pantalla"}
                    </span>
                  </button>
                )}
                {admin && (
                  <button
                    className="control-button"
                    onClick={() => {
                      setSourceTab("files");
                      fileRef.current?.click();
                    }}
                  >
                    <Icon name="upload" />
                    <span>Subir archivo</span>
                  </button>
                )}
                <LiveDevices
                  switchDevice={media.switchActiveDevice}
                  action={onAction}
                />
                <button
                  className="quiet-icon"
                  title="Activar audio de la sala"
                  aria-label="Activar audio de la sala"
                  onClick={() => onAction(() => media.room!.startAudio())}
                >
                  <Icon name="volume" />
                </button>
              </>
            )}
          </div>
          {!media.room && deviceOpen && (
            <DeviceSetup
              onPreferences={onPreferences}
              suspended={media.busy || pending}
            />
          )}
          {!focus && sourceDeck}
          {!focus && waitingList}
        </section>
        {admin && (focus ? focusPanel : inspectorPanel)}
      </div>
      {qualityOpen && (
        <CameraQualityDialog
          track={
            publication(media.room?.localParticipant, "camera")?.track as
              | LocalCameraTrack
              | undefined
          }
          current={media.cameraQuality}
          onApply={media.setCameraQuality}
          onClose={() => setQualityOpen(false)}
        />
      )}
      {effectsOpen && (
        <CameraEffectsDialog
          current={media.cameraEffect}
          source={
            publication(media.room?.localParticipant, "camera")?.track as
              | LocalCameraTrack
              | undefined
          }
          onApply={media.applyCameraEffect}
          onClose={() => setEffectsOpen(false)}
        />
      )}
      {broadcast?.error && (
        <div className="alert warning">
          {broadcast.error}
          {broadcast.status === "reconnecting" && (
            <button
              className="button"
              onClick={() => onAction(() => api("/broadcast/retry", "POST"))}
            >
              Reintentar salida
            </button>
          )}
        </div>
      )}
      {admin && broadcastBar}
    </div>
  );
}
function LiveDevices({
  switchDevice,
  action,
}: {
  switchDevice: (kind: string, id: string) => Promise<boolean>;
  action: Action;
}) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  return (
    <details className="live-devices">
      <summary
        className="control-button"
        onClick={() =>
          void action(async () => {
            assertMediaSupport();
            setDevices(await navigator.mediaDevices.enumerateDevices());
          })
        }
      >
        <Icon name="settings" />
        <span>Dispositivos</span>
      </summary>
      <div>
        {(["audioinput", "videoinput", "audiooutput"] as const).map((kind) => (
          <label key={kind}>
            {
              {
                audioinput: "Micrófono",
                videoinput: "Cámara",
                audiooutput: "Altavoz",
              }[kind]
            }
            <select
              defaultValue=""
              onChange={(e) =>
                void action(async () => {
                  try {
                    await switchDevice(kind, e.target.value);
                  } catch (error) {
                    throw Error(deviceError(error));
                  }
                })
              }
            >
              <option value="" disabled>
                Selecciona un dispositivo
              </option>
              {devices
                .filter((d) => d.kind === kind)
                .map((device, index) => (
                  <option
                    key={device.deviceId || index}
                    value={device.deviceId}
                  >
                    {device.label || `Dispositivo ${index + 1}`}
                  </option>
                ))}
            </select>
          </label>
        ))}
      </div>
    </details>
  );
}
