import { useEffect, useRef } from "react";
import { BrandMark } from "./Brand";
import { SlateView } from "./SlateView";
import { slateProgram, type ShownSlate } from "./slate";
import type { Program, Asset, OutputFormat } from "./types";
import {
  participants,
  publication,
  allowedTrack,
  type MediaRoom,
  type MediaTrack,
} from "./media";
import {
  cameraPositions,
  playbackTime,
  playbackFinished,
  assetUrl,
} from "./composition";
export function TrackView({
  track,
  audio = false,
  muted = false,
  contain = false,
}: {
  track?: MediaTrack;
  audio?: boolean;
  muted?: boolean;
  contain?: boolean;
}) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !track) return;
    track.attach(el);
    el.muted = muted;
    void el.play().catch(() => {});
    return () => {
      track.detach(el);
      el.srcObject = null;
    };
  }, [track, muted]);
  return audio ? (
    <audio ref={ref} autoPlay />
  ) : (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      className={contain ? "contain" : ""}
    />
  );
}
function AssetView({
  asset,
  program,
  renderer,
  previewAudio,
  renderToken,
  clockOffset,
  onMediaInfo,
  onContentReady,
}: {
  asset: Asset;
  program: Program;
  renderer: boolean;
  previewAudio?: boolean;
  renderToken?: string;
  clockOffset: number;
  onMediaInfo?: (info: { duration: number; error?: string }) => void;
  onContentReady?: (ready: boolean) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const offset = useRef(clockOffset);
  offset.current = clockOffset;
  const src = assetUrl(asset.id, renderToken);
  const playback = program.playback;
  useEffect(() => {
    onContentReady?.(
      asset.kind === "image"
        ? Boolean(imageRef.current?.complete && imageRef.current.naturalWidth)
        : (ref.current?.readyState || 0) >= 2,
    );
    const video = ref.current;
    return () => {
      onContentReady?.(false);
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
    };
  }, [asset.id]);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const sync = (force = false) => {
      if (video.readyState < 1) return;
      const target = playbackTime(
        playback,
        Date.now() + offset.current,
        video.duration,
      );
      if (force || Math.abs(video.currentTime - target) > 0.6)
        video.currentTime = target;
      video.volume = playback.volume;
      video.loop = playback.looped;
      if (
        playback.playing &&
        !playbackFinished(playback, Date.now() + offset.current, video.duration)
      ) {
        void video.play().catch(() => {});
      } else video.pause();
    };
    const loaded = () => sync(true);
    sync(true);
    video.addEventListener("loadedmetadata", loaded);
    const timer = setInterval(() => sync(), 500);
    return () => {
      clearInterval(timer);
      video.removeEventListener("loadedmetadata", loaded);
    };
  }, [
    asset.id,
    playback.playing,
    playback.position,
    playback.started_at_ms,
    playback.volume,
    playback.looped,
  ]);
  if (asset.kind === "image")
    return (
      <img
        ref={imageRef}
        className="stage-asset"
        src={src}
        alt={asset.name}
        onLoad={() => onContentReady?.(true)}
        onError={() => {
          onContentReady?.(false);
          onMediaInfo?.({ duration: 0, error: "No se pudo cargar la imagen" });
        }}
      />
    );
  return (
    <video
      ref={ref}
      className="stage-asset"
      src={src}
      muted={!renderer && !previewAudio}
      playsInline
      preload="auto"
      onLoadedMetadata={() =>
        onMediaInfo?.({ duration: ref.current?.duration || 0 })
      }
      onLoadedData={() => onContentReady?.(true)}
      onError={() => {
        onContentReady?.(false);
        onMediaInfo?.({
          duration: 0,
          error:
            "Este video no se puede reproducir. Prueba MP4 con H.264 y AAC, o WebM.",
        });
      }}
    />
  );
}
export function Stage({
  format = "landscape",
  program: base,
  slate = null,
  slatePreview = false,
  room,
  names = {},
  renderer = false,
  revision: _revision = 0,
  assets = [],
  renderToken,
  clockOffset = 0,
  onMediaInfo,
  onContentReady,
  onBackgroundReady,
  previewAudio = false,
}: {
  program: Program;
  /** Pantalla al aire: sustituye al programa dentro de la misma raíz `.stage`. */
  slate?: ShownSlate | null;
  slatePreview?: boolean;
  format?: OutputFormat;
  room: MediaRoom | null;
  names?: Record<string, string>;
  renderer?: boolean;
  revision?: number;
  assets?: Asset[];
  renderToken?: string;
  clockOffset?: number;
  onMediaInfo?: (info: { duration: number; error?: string }) => void;
  onContentReady?: (ready: boolean) => void;
  onBackgroundReady?: (ready: boolean) => void;
  previewAudio?: boolean;
}) {
  const backgroundRef = useRef<HTMLImageElement>(null);
  const program = slate ? slateProgram(base, slate.slate) : base;
  const people = participants(room);
  const find = (id: string) => people.find((p) => p.identity === id);
  const content = program.layout === "screen";
  const mode = program.content_mode || "side";
  const ids =
    program.layout === "spotlight"
      ? program.spotlight
        ? [program.spotlight]
        : []
      : content && mode === "pip"
        ? program.identities.length
          ? [
              program.spotlight &&
              program.identities.includes(program.spotlight)
                ? program.spotlight
                : program.identities[0],
            ]
          : []
        : content && mode === "full"
          ? []
          : program.identities;
  const positions = cameraPositions(ids.length, format);
  const screen =
    content && program.screen
      ? publication(find(program.screen), "screen_share")
      : undefined;
  const asset =
    content && program.media_asset
      ? assets.find((a) => a.id === program.media_asset)
      : undefined;
  const backgroundAsset = assets.find(
    (a) => a.id === program.background_asset && a.kind === "image",
  );
  useEffect(() => {
    onBackgroundReady?.(
      !program.background_asset ||
        Boolean(
          backgroundRef.current?.complete && backgroundRef.current.naturalWidth,
        ),
    );
  }, [program.background_asset, backgroundAsset?.id, onBackgroundReady]);
  return (
    <div
      className={`stage format-${format} layout-${program.layout} content-${mode} pip-${program.pip_position || "bottom_right"}`}
      style={{ background: program.background || "#101923" }}
    >
      {backgroundAsset && (
        <img
          ref={backgroundRef}
          key={backgroundAsset.id}
          onLoad={() => onBackgroundReady?.(true)}
          onError={() => onBackgroundReady?.(false)}
          className="stage-background"
          src={assetUrl(backgroundAsset.id, renderToken)}
          alt=""
          aria-hidden="true"
        />
      )}
      {program.logo && (
        <img className="program-logo" src={program.logo} alt="Logo" />
      )}
      {content && (
        <div className="screen-area">
          {asset ? (
            <AssetView
              key={asset.id}
              asset={asset}
              program={program}
              renderer={renderer}
              previewAudio={previewAudio}
              renderToken={renderToken}
              clockOffset={clockOffset}
              onMediaInfo={onMediaInfo}
              onContentReady={onContentReady}
            />
          ) : screen?.track ? (
            <TrackView track={screen.track} muted contain />
          ) : (
            <div className="empty-source">
              <span>▱</span>
              <p>Esperando contenido</p>
            </div>
          )}
        </div>
      )}
      <div className={`camera-grid count-${ids.length}`}>
        {ids.map((identity, index) => {
          const person = find(identity),
            camera = publication(person, "camera"),
            name =
              names[identity] ||
              person?.name ||
              (identity === "host" ? "Anfitrión" : "Invitado");
          const rect = positions[index];
          return (
            <div
              className="camera-tile"
              data-identity={identity}
              key={identity}
              style={
                !content
                  ? {
                      position: "absolute",
                      left: `${rect.left}%`,
                      top: `${rect.top}%`,
                      width: `${rect.width}%`,
                      height: `${rect.height}%`,
                    }
                  : undefined
              }
            >
              {camera?.track && !camera.isMuted ? (
                <TrackView track={camera.track} muted />
              ) : (
                <div className="avatar">
                  <span>{name.slice(0, 1).toUpperCase()}</span>
                </div>
              )}
              {program.names && <span className="lower-third">{name}</span>}
            </div>
          );
        })}
      </div>
      {slate && (
        <SlateView
          shown={slate}
          clockOffset={clockOffset}
          renderer={renderer}
          renderToken={renderToken}
          preview={slatePreview}
          format={format}
        />
      )}
      {!slate && !ids.length && !content && !backgroundAsset && (
        <div className="stage-empty">
          <div className="stage-orbit">
            <BrandMark className="stage-brand-mark" />
          </div>
          <h2>Este es tu escenario</h2>
          <p>Añade una cámara, comparte pantalla o muestra un archivo.</p>
        </div>
      )}
      {renderer &&
        people.flatMap((person) =>
          [...person.trackPublications.values()]
            .filter(
              (pub) =>
                pub.kind === "audio" &&
                allowedTrack(program, person.identity, pub.source) &&
                !pub.isMuted &&
                pub.track,
            )
            .map((pub) => (
              <TrackView key={pub.trackSid} track={pub.track} audio />
            )),
        )}
    </div>
  );
}
export function MonitorAudio({
  room,
  revision: _revision = 0,
}: {
  room: MediaRoom | null;
  revision?: number;
}) {
  return (
    <>
      {[...(room?.remoteParticipants.values() || [])].flatMap((person) =>
        [...person.trackPublications.values()]
          .filter((pub) => pub.kind === "audio" && !pub.isMuted && pub.track)
          .map((pub) => (
            <TrackView key={pub.trackSid} track={pub.track} audio />
          )),
      )}
    </>
  );
}
