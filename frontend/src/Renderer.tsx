import { useEffect, useRef, useState } from "react";
import { Stage } from "./Stage";
import { startProgramCapture } from "./compositor";
import { allowedTrack, participants, useRoom } from "./media";
import { layerDimensions } from "./composition";
import { shownSlate, slateProgram } from "./slate";
import {
  initialProgram,
  normalizeProgram,
  type Program,
  type Asset,
  type ActiveSlate,
  type Slates,
} from "./types";
export function Renderer() {
  const query = new URLSearchParams(location.search);
  const token = query.get("render_token") || "";
  const format = query.get("format") === "portrait" ? "portrait" : "landscape";
  const formatQuery = `&format=${format}`;
  const media = useRoom(true);
  const [state, setState] = useState<{
    program: Program;
    assets: Asset[];
    server_time_ms: number;
    names: Record<string, string>;
    slates?: Slates;
    active_slate?: ActiveSlate | null;
  } | null>(null);
  const [error, setError] = useState("");
  const [clockOffset, setClockOffset] = useState(0);
  const [contentReady, setContentReady] = useState(false);
  const [backgroundReady, setBackgroundReady] = useState(false);
  const started = useRef(false);
  const stopCapture = useRef<(() => void) | null>(null);
  useEffect(() => () => stopCapture.current?.(), []);
  const inFlight = useRef(false);
  const connecting = useRef(false);
  useEffect(() => {
    document.documentElement.classList.add("render-mode");
    let cancelled = false;
    const refresh = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const response = await fetch(
          `/api/v1/renderer/state?render_token=${encodeURIComponent(token)}${formatQuery}`,
          { signal: AbortSignal.timeout(1500) },
        );
        if (!response.ok) throw Error("Acceso al compositor rechazado");
        const next = await response.json();
        if (!cancelled) {
          next.program = normalizeProgram(next.program);
          next.assets ??= [];
          setClockOffset(
            Number.isFinite(next.server_time_ms)
              ? next.server_time_ms - Date.now()
              : 0,
          );
          setState(next);
          setError("");
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        inFlight.current = false;
      }
    };
    void refresh();
    const timer = setInterval(refresh, 500);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.documentElement.classList.remove("render-mode");
    };
  }, [token]);
  useEffect(() => {
    if (!state || connecting.current) return;
    connecting.current = true;
    const credentials = async () => {
      const url = query.get("url"),
        jwt = query.get("token");
      if (url && jwt) return { url, token: jwt }; // Egress las inyecta
      if (!query.get("ingest"))
        throw Error("Faltan las credenciales de Egress");
      // Modo escritorio: credenciales propias del compositor local.
      const r = await fetch(
        `/api/v1/renderer/session?render_token=${encodeURIComponent(token)}${formatQuery}`,
      );
      if (!r.ok) throw Error("Acceso al compositor rechazado");
      return (await r.json()) as { url: string; token: string };
    };
    void credentials()
      .then((c) => media.connect(c))
      .catch((e) => setError(String(e)));
  }, [Boolean(state)]);
  const shown = shownSlate(state?.slates, state?.active_slate);
  useEffect(() => {
    if (!state || !media.room) return;
    const room = media.room;
    // Con una pantalla al aire no se suscribe a cámaras, micrófonos ni pantallas.
    const program = error
      ? initialProgram
      : shown
        ? slateProgram(state.program, shown.slate)
        : state.program;
    let cancelled = false;
    for (const p of room.remoteParticipants.values())
      for (const pub of p.trackPublications.values())
        pub.setSubscribed?.(allowedTrack(program, p.identity, pub.source));
    const ready = async () => {
      if (
        error ||
        room.state !== "connected" ||
        (program.media_asset && !contentReady)
      )
        return;
      if (program.background_asset && !backgroundReady) return;
      const pending = participants(room).flatMap((p) =>
        [...p.trackPublications.values()].filter(
          (pub) =>
            allowedTrack(program, p.identity, pub.source) &&
            !pub.isMuted &&
            !pub.track,
        ),
      );
      if (pending.length) return;
      await document.fonts.ready;
      // Off-screen browser iframes can suspend animation frames. Fonts and media
      // are already ready; a bounded wait also lets their compositor start.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 100);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          clearTimeout(timer);
          resolve();
        }));
      });
      if (cancelled) return;
      const ack = await fetch("/api/v1/renderer/ack", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          revision: program.revision,
          format,
          screen_missing: false,
        }),
      });
      if (!ack.ok) throw Error("No se pudo confirmar la composición");
      if (!started.current) {
        started.current = true;
        console.log("START_RECORDING");
        // Modo escritorio: el propio renderer compone y envía el programa al backend.
        if (query.get("ingest")) {
          const stage = document.querySelector<HTMLElement>(".stage");
          const proto = location.protocol === "https:" ? "wss" : "ws";
          if (stage)
            stopCapture.current = startProgramCapture({
              stage,
              width: format === "portrait" ? 1080 : 1920,
              height: format === "portrait" ? 1920 : 1080,
              url: `${proto}://${location.host}/api/v1/ingest?render_token=${encodeURIComponent(token)}${formatQuery}`,
              onError: setError,
            });
        }
      }
    };
    void ready().catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [
    state?.program.revision,
    state?.active_slate?.kind,
    shown?.slate.background_asset,
    media.room,
    media.revision,
    error,
    contentReady,
    backgroundReady,
  ]);
  // Cada cuadro de cámara pide solo la capa simulcast que necesita (según su tamaño real en el lienzo):
  // decodificar 720p/1080p para pintar 576×324 px es trabajo de CPU tirado. `?layers=full` lo desactiva.
  useEffect(() => {
    const room = media.room;
    if (!room || query.get("layers") === "full") return;
    const apply = () => {
      for (const tile of document.querySelectorAll<HTMLElement>(".camera-tile[data-identity]")) {
        const video = tile.querySelector("video");
        const rect = (video ?? tile).getBoundingClientRect();
        const person = room.remoteParticipants.get(tile.dataset.identity || "");
        const camera = person && [...person.trackPublications.values()].find((x) => x.source === "camera");
        if (camera && rect.width > 0) camera.setVideoDimensions?.(layerDimensions(rect));
      }
    };
    apply();
    const timer = setInterval(apply, 1000);
    return () => clearInterval(timer);
  }, [media.room, media.revision]);
  // A stale control connection must not keep broadcasting a guest removed from the program.
  if (error || media.room?.state !== "connected")
    return <div className="render-black" />;
  return state ? (
    <Stage
      format={format}
      program={state.program}
      slate={shown}
      room={media.room}
      names={state.names}
      renderer
      revision={media.revision}
      assets={state.assets}
      renderToken={token}
      clockOffset={clockOffset}
      onBackgroundReady={setBackgroundReady}
      onContentReady={setContentReady}
    />
  ) : (
    <div />
  );
}
