import React, { useEffect, useState } from "react";
import { DesktopRenderer } from "./desktop";
import { audioMode, loadAudioMode } from "./audio-quality";
import { RemoteSessions } from "./RemoteSessions";
import { Scenes } from "./Scenes";
import { Slates } from "./Slates";
import { useFocusMode, useStoredFlag } from "./useFocusMode";
import { Destinations } from "./Destinations";
import { RecordingsFolder } from "./RecordingsFolder";
import { createRoot } from "react-dom/client";
import { api, ApiError } from "./api";
import { useRoom } from "./media";
import { MonitorAudio } from "./Stage";
import { Renderer } from "./Renderer";
import { StudioWorkspace } from "./StudioWorkspace";
import { BrandMark } from "./Brand";
import {
  statusLabels,
  normalizeProgram,
  type OutputFormat,
  type Me,
  type Studio,
  type Program,
  type Health,
  type Recording,
} from "./types";
import { DeviceSetup } from "./DeviceSetup";
import {
  assertMediaSupport,
  deviceError,
  type CapturePreferences,
} from "./devices";
import "./style.css";
import "./workspace.css";

function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [studio, setStudio] = useState<Studio | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [tab, setTab] = useState("studio");
  const [format, setFormat] = useState<OutputFormat>("landscape");
  const [health, setHealth] = useState<Health | null>(null);
  const [records, setRecords] = useState<Recording[]>([]);
  const [invite, setInvite] = useState("");
  const [inviteCa, setInviteCa] = useState("");
  const [invites, setInvites] = useState<
    { id: string; expires: number; revoked: boolean }[]
  >([]);
  const media = useRoom();
  const [sidebarClosed, setSidebarClosed] = useStoredFlag("streamhive.sidebar-collapsed");
  const liveSession =
    studio?.broadcast &&
    ["starting", "live", "reconnecting", "ending", "uncertain"].includes(studio.broadcast.status)
      ? studio.broadcast.id
      : null;
  const focusMode = useFocusMode(me?.role === "admin" ? liveSession : null);
  const [capturePreferences, setCapturePreferences] =
    useState<CapturePreferences>({});
  const joinToken = location.pathname.startsWith("/join/")
    ? decodeURIComponent(location.pathname.slice(6))
    : null;
  const refresh = async () => {
    try {
      const next = await api<Studio>("/studio");
      next.program = normalizeProgram(next.program);
      next.portrait_program = normalizeProgram(next.portrait_program ?? {});
      next.clock_offset = Number.isFinite(next.server_time_ms)
        ? next.server_time_ms - Date.now()
        : 0;
      setStudio(next);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setMe(null);
        await media.disconnect();
      } else setError(String(e));
    }
  };
  useEffect(() => {
    void api<Me>("/me")
      .then(setMe)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (!me) return;
    void refresh();
    let socket: WebSocket | null = null;
    let stopped = false;
    let reconnect: ReturnType<typeof setTimeout>;
    const open = () => {
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/v1/events`,
      );
      socket.onmessage = () => void refresh();
      socket.onclose = () => {
        if (!stopped) reconnect = setTimeout(open, 3000);
      };
    };
    open();
    const poll = setInterval(refresh, 5000);
    return () => {
      stopped = true;
      clearTimeout(reconnect);
      clearInterval(poll);
      socket?.close();
    };
  }, [me?.id]);
  useEffect(() => {
    if (me?.role !== "admin") return;
    const tick = () => {
      void api<Health>("/status")
        .then(setHealth)
        .catch(() => {});
      void api<Recording[]>("/recordings")
        .then(setRecords)
        .catch(() => {});
      void api<typeof invites>("/invitations")
        .then(setInvites)
        .catch(() => {});
    };
    tick();
    const timer = setInterval(tick, 10000);
    return () => clearInterval(timer);
  }, [me?.role]);
  const run = async (action: () => Promise<unknown>, message?: string) => {
    setPending(true);
    setError("");
    setNotice("");
    try {
      await action();
      await refresh();
      if (message) setNotice(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };
  const admitted =
    me?.role === "admin" ||
    studio?.participants.find((p) => p.id === me?.id)?.status === "admitted";
  useEffect(() => {
    if (me && !admitted && media.room) void media.disconnect();
  }, [admitted]);
  const setProgram = (patch: Partial<Program>) =>
    run(() => api(`/program?format=${format}`, "PUT", { ...(format === "portrait" ? studio!.portrait_program : studio!.program), ...patch }));
  const connect = () =>
    run(async () => {
      assertMediaSupport();
      const room = await media.connect();
      if (room) {
        if (capturePreferences.quality) await media.setCameraQuality(capturePreferences.quality);
        const outcomes = await Promise.allSettled([
          room.localParticipant.setMicrophoneEnabled(
            true,
            {
              ...audioMode(capturePreferences.audio ?? loadAudioMode()).constraints,
              ...(capturePreferences.audioinput
                ? { deviceId: capturePreferences.audioinput }
                : {}),
            },
            {
              audioPreset: {
                maxBitrate: audioMode(capturePreferences.audio ?? loadAudioMode()).bitrate,
              },
            },
          ),
          media.setCameraEnabled(
            true,
            capturePreferences.videoinput
              ? { deviceId: capturePreferences.videoinput }
              : undefined,
          ),
        ]);
        const warnings = outcomes.flatMap((outcome, i) =>
          outcome.status === "rejected"
            ? [deviceError(outcome.reason, i === 0 ? "micrófono" : "cámara")]
            : [],
        );
        if (warnings.length) setError(warnings.join(" "));
      }
    });
  const names = Object.fromEntries([
    ["host", "Anfitrión"],
    ...(studio?.participants || []).map((p) => [p.id, p.name]),
  ]);
  if (loading) return <div className="center-page">Abriendo tu estudio…</div>;
  if (!me)
    return (
      <Access
        guestToken={joinToken}
        onDone={async () => {
          setMe(await api<Me>("/me"));
          if (!joinToken) history.replaceState(null, "", "/");
        }}
      />
    );
  const admin = me.role === "admin";
  const broadcast = studio?.broadcast;
  const running = Boolean(
    broadcast &&
    ["starting", "live", "reconnecting", "ending", "uncertain"].includes(
      broadcast.status,
    ),
  );
  const focused = admin && tab === "studio" && focusMode.focus && Boolean(studio);
  const createInvite = () =>
    run(async () => {
      const i = await api<{ url: string; ca_url?: string | null }>(
        "/invitations",
        "POST",
      );
      setInvite(i.url);
      setInviteCa(i.ca_url || "");
    });
  return (
    <div className={`app-shell ${sidebarClosed ? "sidebar-collapsed" : ""} ${focused ? "focus-mode" : ""}`}>
      <DesktopRenderer key={broadcast?.id} active={admin && running} />
      <aside className="sidebar">
        <button
          className="sidebar-toggle"
          aria-label={sidebarClosed ? "Abrir barra lateral" : "Plegar barra lateral"}
          aria-expanded={!sidebarClosed}
          title={sidebarClosed ? "Abrir barra lateral" : "Plegar barra lateral"}
          onClick={() => setSidebarClosed(!sidebarClosed)}
        >
          {sidebarClosed ? "»" : "«"}
        </button>
        <a className="brand" href="/" aria-label="StreamHive · Inicio">
          <BrandMark />StreamHive
        </a>
        <div className="workspace-label">ESPACIO PERSONAL</div>
        <div className="workspace">
          <span className="workspace-avatar">S</span>
          <div>
            Mi estudio<small>Producción en directo</small>
          </div>
        </div>
        <nav>
          <button
            title="Estudio en vivo"
            className={tab === "studio" ? "active" : ""}
            onClick={() => setTab("studio")}
          >
            <span>▣</span> Estudio en vivo
          </button>
          {admin && (
            <>
              <button
                title="Grabaciones"
                className={tab === "recordings" ? "active" : ""}
                onClick={() => setTab("recordings")}
              >
                <span>▤</span> Grabaciones <b>{records.length}</b>
              </button>
              <button
                title="Configuración"
                className={tab === "settings" ? "active" : ""}
                onClick={() => setTab("settings")}
              >
                <span>⚙</span> Configuración
              </button>
            </>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-badge">
            <i /> Alojado en tu servidor
          </div>
          <button
            title="Cerrar sesión"
            className="account"
            onClick={() =>
              run(async () => {
                await api("/logout", "POST");
                await media.disconnect();
                setMe(null);
              })
            }
          >
            <span className="workspace-avatar">{admin ? "A" : "I"}</span>
            <div>
              {admin ? "Administrador" : names[me.id] || "Invitado"}
              <small>Cerrar sesión ↗</small>
            </div>
          </button>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div>
            <span className="eyebrow">TU ESPACIO PARA CONECTAR</span>
            <h1>
              {tab === "studio"
                ? "Estudio en vivo"
                : tab === "recordings"
                  ? "Grabaciones"
                  : "Configuración"}
            </h1>
          </div>
          <div className="top-actions">
            <span
              className={`connection ${media.room?.state === "connected" ? "good" : ""}`}
            >
              <i />
              {media.room?.state === "connected"
                ? "Sala conectada"
                : "Sin conectar a la sala"}
            </span>
            {admin && (
              <button
                className="button"
                disabled={pending}
                onClick={createInvite}
              >
                ＋ Invitar personas (local)
              </button>
            )}
          </div>
        </header>
        <nav className="mobile-navigation" aria-label="Navegación del estudio">
          <button
            aria-current={tab === "studio" ? "page" : undefined}
            onClick={() => setTab("studio")}
          >
            Estudio
          </button>
          {admin && (
            <>
              <button
                aria-current={tab === "recordings" ? "page" : undefined}
                onClick={() => setTab("recordings")}
              >
                Grabaciones
              </button>
              <button
                aria-current={tab === "settings" ? "page" : undefined}
                onClick={() => setTab("settings")}
              >
                Configuración
              </button>
            </>
          )}
          <button
            onClick={() =>
              run(async () => {
                await api("/logout", "POST");
                await media.disconnect();
                setMe(null);
              })
            }
          >
            Salir
          </button>
        </nav>
        <div className="content">
          {error && (
            <div className="alert error" role="alert">
              {error}
              <button onClick={() => setError("")}>×</button>
            </div>
          )}
          {media.error && (
            <div className="alert error">
              {media.error}
              <button onClick={() => media.setError("")}>×</button>
            </div>
          )}
          {notice && <div className="alert">{notice}</div>}
          {health?.disk_warning && (
            <div className="alert warning">
              Espacio disponible: {(health.free_bytes / 1e9).toFixed(1)} GB.
              Descarga y elimina grabaciones para liberar espacio.
            </div>
          )}
          {invite && (
            <div className="invite-banner">
              <div>
                <b>Invita a tu próxima conversación</b>
                <p>
                  El enlace caduca en 24 horas. Abre el enlace en otro navegador
                  para probarlo.
                </p>
                {inviteCa && (
                  <p>
                    Red local con HTTPS propio: cada invitado debe instalar
                    una vez el{" "}
                    <a href={inviteCa} target="_blank" rel="noreferrer">
                      certificado de StreamHive
                    </a>{" "}
                    para poder usar cámara y micrófono.
                  </p>
                )}
                <input
                  aria-label="Enlace de invitación"
                  readOnly
                  value={invite}
                />
              </div>
              <button
                className="button"
                onClick={() =>
                  run(async () => {
                    await navigator.clipboard.writeText(invite);
                  }, "Enlace copiado")
                }
              >
                Copiar enlace
              </button>
              <button
                className="icon-button"
                aria-label="Cerrar invitación"
                onClick={() => {
                  setInvite("");
                  setInviteCa("");
                }}
              >
                ×
              </button>
            </div>
          )}
          {tab === "studio" &&
            (studio ? (
              <>
              {admin && !focused && <RemoteSessions version={studio} pending={pending} run={run} settings={false} onInvite={(url)=>{setInvite(url);setInviteCa("");}} />}
              {admin && !focused && <Scenes studio={studio} format={format} onFormat={setFormat} run={run} pending={pending} names={names} />}
              <StudioWorkspace
                key={format}
                format={format}
                me={me}
                studio={format === "portrait" ? { ...studio, program: studio.portrait_program ?? studio.program } : studio}
                media={media}
                pending={pending}
                names={names}
                onProgram={setProgram}
                onAction={run}
                onConnect={connect}
                onPreferences={setCapturePreferences}
                onSettings={() => setTab("settings")}
                focus={focused}
                onFocus={(on) => (on ? focusMode.enter() : focusMode.leave())}
                onInvite={() => void createInvite()}
                scenes={admin && <Scenes compact studio={studio} format={format} onFormat={setFormat} run={run} pending={pending} names={names} />}
              />
              </>
            ) : (
              <div className="panel">Abriendo el escenario…</div>
            ))}
          {tab === "recordings" && admin && (
            <section>
              <div className="section-intro">
                <h2>Cada conversación, a mano.</h2>
                <p>Descarga tus programas antes de eliminarlos del servidor.</p>
                <button className="text-button" onClick={() => setTab("settings")}>
                  Cambiar dónde se guardan
                </button>
              </div>
              {!records.length ? (
                <div className="empty-panel panel">
                  Tus grabaciones aparecerán aquí cuando grabes un programa.
                </div>
              ) : (
                <div className="recordings-grid">
                  {records.map((r) => (
                    <article className="panel recording-card" key={r.id}>
                      <div className="recording-art">
                        ▤<span>{r.id.endsWith("-portrait") ? "9:16" : "16:9"} · 1080p</span>
                      </div>
                      <h3>
                        Programa del{" "}
                        {new Date(r.created * 1000).toLocaleDateString("es")}
                      </h3>
                      <p>
                        {new Date(r.created * 1000).toLocaleTimeString("es")} ·{" "}
                        {(r.bytes / 1e9).toFixed(2)} GB ·{" "}
                        {Math.floor(r.duration / 60)} min
                      </p>
                      {r.location && <p className="folder-path" title={r.location}>{r.location}</p>}
                      <span className="pill">
                        {statusLabels[r.status] || r.status}
                      </span>
                      <div className="recording-actions">
                        {r.status === "complete" && (
                          <a
                            className="button"
                            href={`/api/v1/recordings/${r.id}`}
                          >
                            ↓ Descargar
                          </a>
                        )}
                        <button
                          className="text-button red"
                          disabled={running && r.status === "recording"}
                          onClick={() => {
                            if (
                              confirm(
                                "¿Eliminar esta grabación del servidor? Esta acción no se puede deshacer.",
                              )
                            )
                              void run(async () => {
                                await api(`/recordings/${r.id}`, "DELETE");
                                setRecords(await api("/recordings"));
                              });
                          }}
                        >
                          Eliminar
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}
          {tab === "settings" && admin && (
            <div className="settings-grid">
              <RemoteSessions version={studio} pending={pending} run={run} settings onInvite={(url)=>{setInvite(url);setInviteCa("");}} />
              {studio && <Slates studio={studio} run={run} pending={pending} />}
              <section className="panel">
                <h2>Destinos de transmisión</h2>
                <p>
                  Emite a varias plataformas a la vez con una sola codificación.
                  Elige YouTube, Twitch o Facebook, o añade un servidor RTMP
                  personalizado.
                </p>
                <Destinations
                  disabled={running || pending}
                  run={run}
                  version={studio}
                />
                <p className="hint">
                  Crea el evento en la plataforma de destino antes de iniciar el
                  directo.
                </p>
              </section>
              <section className="panel">
                <h2>Grabaciones</h2>
                <p>Elige dónde se guardan los archivos MP4 de tus programas.</p>
                <RecordingsFolder pending={pending} run={run} version={studio} />
              </section>
              <section className="panel">
                <h2>Tu servidor</h2>
                <div className="output-row">
                  <span>Motor multimedia</span>
                  <b>{health?.livekit ? "Disponible" : "Sin conexión"}</b>
                </div>
                <div className="output-row">
                  <span>Disco libre</span>
                  <b>
                    {health
                      ? `${(health.free_bytes / 1e9).toFixed(1)} GB`
                      : "Comprobando…"}
                  </b>
                </div>
                <div className="output-row">
                  <span>Estudio</span>
                  <b>
                    {studio?.limits
                      ? `Hasta ${studio.limits.on_screen} en pantalla y ${studio.limits.admitted} invitados en sala`
                      : "Comprobando…"}
                  </b>
                </div>
                <p className="hint">
                  Duración máxima: 2 horas. Al bajar de 1 GB libre se detiene
                  la grabación para proteger el archivo; el directo continúa si
                  el motor lo permite.
                </p>
              </section>
              <section className="panel">
                <h2>Invitaciones</h2>
                {!invites.length ? (
                  <p>No hay invitaciones creadas.</p>
                ) : (
                  invites.map((i) => (
                    <div className="output-row" key={i.id}>
                      <span>
                        {i.id.slice(0, 8)} ·{" "}
                        {i.revoked
                          ? "Revocada"
                          : i.expires < Date.now() / 1000
                            ? "Caducada"
                            : "Activa"}
                      </span>
                      {!i.revoked && (
                        <button
                          className="text-button red"
                          onClick={() =>
                            run(async () => {
                              await api(`/invitations/${i.id}`, "DELETE");
                              setInvites(await api("/invitations"));
                            })
                          }
                        >
                          Revocar
                        </button>
                      )}
                    </div>
                  ))
                )}
              </section>
            </div>
          )}
        </div>
        <MonitorAudio room={media.room} revision={media.revision} />
      </main>
    </div>
  );
}
function Access({
  guestToken,
  onDone,
}: {
  guestToken: string | null;
  onDone: () => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="access-page">
      <div className="access-brand">
        <BrandMark />StreamHive
      </div>
      <section className="access-card">
        <span className="eyebrow">
          {guestToken
            ? "TU LUGAR EN LA CONVERSACIÓN"
            : "ESTUDIO PERSONAL DE STREAMING"}
        </span>
        <h1>{guestToken ? "Estás invitado." : "Tu voz. Tu escenario."}</h1>
        <p>
          {guestToken
            ? "Comprueba tus dispositivos y avisa al anfitrión cuando estés listo."
            : "Todo lo que necesitas para conectar con tu audiencia, desde tu propio servidor."}
        </p>
        {guestToken && <LocalPreview />}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await api(
                guestToken ? "/join" : "/login",
                "POST",
                guestToken ? { token: guestToken, name } : { password },
              );
              await onDone();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            {guestToken ? "Tu nombre" : "Contraseña de administrador"}
            <input
              autoComplete={guestToken ? "name" : "current-password"}
              type={guestToken ? "text" : "password"}
              required
              maxLength={guestToken ? 60 : 200}
              value={guestToken ? name : password}
              onChange={(e) =>
                guestToken
                  ? setName(e.target.value)
                  : setPassword(e.target.value)
              }
              placeholder={
                guestToken ? "¿Cómo te llamas?" : "Introduce tu contraseña"
              }
            />
          </label>
          {error && (
            <div className="alert error" role="alert">
              {error}
            </div>
          )}
          <button className="button primary" disabled={busy}>
            {busy
              ? "Conectando…"
              : guestToken
                ? "Entrar a la sala de espera →"
                : "Abrir mi estudio →"}
          </button>
        </form>
        <div className="access-footer">
          <i /> Alojado en tu servidor · Tú tienes el control
        </div>
      </section>
    </div>
  );
}
function LocalPreview() {
  return <DeviceSetup />;
}
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: string }
> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <div className="center-page">
        <h1>No se pudo abrir el estudio</h1>
        <p>{this.state.error}</p>
        <button className="button" onClick={() => location.reload()}>
          Volver a cargar
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    {location.pathname === "/render" ? <Renderer /> : <App />}
  </ErrorBoundary>,
);
