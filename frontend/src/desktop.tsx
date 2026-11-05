import { useEffect, useState } from "react";

type DesktopBridge = {
  openRenderer: (path: string) => Promise<void>;
  closeRenderer: () => Promise<void>;
};
// Lo expone el preload de Electron (desktop/electron/preload.js).
export const desktopBridge = (): DesktopBridge | undefined =>
  (window as unknown as { streamhiveDesktop?: DesktopBridge }).streamhiveDesktop;
export const isDesktop = () => Boolean(desktopBridge());

/** En la app de escritorio abre/cierra la ventana oculta del compositor según la emisión. */
export function DesktopRenderer({ active }: { active: boolean }) {
  // Sin la app de escritorio (ENGINE=ffmpeg en un navegador) el compositor corre en un iframe oculto
  // del mismo origen; la pestaña del estudio debe permanecer abierta durante el directo.
  const [frames, setFrames] = useState<{ url: string; format: string }[]>([]);
  useEffect(() => {
    const t = desktopBridge();
    if (!active) {
      setFrames([]);
      void t?.closeRenderer().catch(() => {});
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await fetch("/api/v1/desktop/renderer");
        if (!r.ok) throw new Error("No se pudieron abrir los compositores");
        const { url, renderers } = (await r.json()) as { url: string | null; renderers?: { url: string; format: string }[] };
        if (!cancelled && url) {
          const paths = renderers?.length ? renderers : [{ url, format: "landscape" }];
          if (t) { for (const path of paths) await t.openRenderer(path.url); }
          else setFrames(paths);
          return true;
        }
      } catch {
        /* se reintenta */
      }
      return false;
    };
    const timer = setInterval(async () => {
      if (await poll()) clearInterval(timer);
    }, 1000);
    void poll().then((ok) => ok && clearInterval(timer));
    return () => {
      cancelled = true;
      clearInterval(timer);
      void t?.closeRenderer().catch(() => {});
    };
  }, [active]);
  return <> {frames.map((frame) => (
    <iframe
      key={frame.format}
      title={`Compositor ${frame.format}`}
      src={frame.url}
      aria-hidden="true"
      style={{
        position: "fixed",
        left: "-10000px",
        top: 0,
        width: frame.format === "portrait" ? 1080 : 1920,
        height: frame.format === "portrait" ? 1920 : 1080,
        border: 0,
        pointerEvents: "none",
      }}
    />
  ))} </>;
}
