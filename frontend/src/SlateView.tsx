import { useEffect, useRef, useState } from "react";
import { ticker } from "./compositor";
import { assetUrl } from "./composition";
import {
  fittedSize,
  formatCountdown,
  inkFor,
  remainingSeconds,
  type ShownSlate,
} from "./slate";
import type { OutputFormat } from "./types";

/**
 * Textos de una pantalla, pintados dentro del mismo `.stage` para que el compositor
 * siga capturando el mismo elemento. Cada texto es una sola línea: `fillText` no parte.
 */
export function SlateView({
  shown,
  clockOffset = 0,
  renderer = false,
  renderToken,
  preview = false,
  format = "landscape",
}: {
  format?: OutputFormat;
  shown: ShownSlate;
  clockOffset?: number;
  renderer?: boolean;
  renderToken?: string;
  /** En el editor el temporizador se ve completo y parado. */
  preview?: boolean;
}) {
  const { slate, endsAtMs } = shown;
  const [now, setNow] = useState(Date.now());
  const counting = !preview && endsAtMs !== null;
  useEffect(() => {
    if (!counting) return;
    // Un Worker no se frena aunque la ventana del compositor esté oculta.
    return ticker(250, () => setNow(Date.now()));
  }, [counting]);
  const remaining = preview
    ? slate.timer_seconds
    : endsAtMs === null
      ? null
      : remainingSeconds(endsAtMs, now, clockOffset);
  const hasTimer = remaining !== null && (preview ? slate.timer_seconds > 0 : true);
  const done = hasTimer && remaining === 0;
  const ink = slate.background_asset ? "#f5f8fa" : inkFor(slate.background);
  const line = (text: string, base: number) => ({
    fontSize: `${fittedSize(text, format === "portrait" ? base * 1.6 : base)}cqw`,
    color: ink,
  });
  const timerText = done && slate.done_label ? slate.done_label : formatCountdown(remaining ?? 0);
  return (
    <div className={`slate-view ${slate.background_asset ? "has-image" : ""}`}>
      <div className="slate-card">
        <div className="slate-title" style={line(slate.title, 6)}>
          {slate.title}
        </div>
        {slate.subtitle && (
          <div className="slate-subtitle" style={line(slate.subtitle, 2.6)}>
            {slate.subtitle}
          </div>
        )}
        {hasTimer && !done && slate.timer_label && (
          <div className="slate-timer-label" style={line(slate.timer_label, 2.2)}>
            {slate.timer_label}
          </div>
        )}
        {hasTimer && (
          <div
            className={`slate-timer ${done ? "is-done" : ""}`}
            role="timer"
            style={line(timerText, done && slate.done_label ? 3.4 : 8)}
          >
            {timerText}
          </div>
        )}
      </div>
      {renderer && slate.music_asset && (
        <SlateMusic
          key={slate.music_asset}
          src={assetUrl(slate.music_asset, renderToken)}
          volume={slate.music_volume}
        />
      )}
    </div>
  );
}
/** Música de la pantalla: el mezclador del compositor la engancha como cualquier otro audio. */
function SlateMusic({ src, volume }: { src: string; volume: number }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const audio = ref.current;
    if (!audio) return;
    audio.volume = volume;
    const play = () => {
      if (audio.paused) void audio.play().catch(() => {});
    };
    play();
    const timer = setInterval(play, 1000);
    return () => {
      clearInterval(timer);
      audio.pause();
    };
  }, [volume]);
  return <audio ref={ref} className="slate-music" src={src} loop preload="auto" />;
}
