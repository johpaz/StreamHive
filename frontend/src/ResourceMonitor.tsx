import { useEffect, useRef, useState } from "react";
import { api } from "./api";

type Group = { cpu: number; mem: number; procs: number };
export type Resources =
  | { ready: false }
  | {
      ready: true;
      sample: {
        cpu: number;
        cpus: number;
        mem_used: number;
        mem_total: number;
        disk_free: number;
        groups: Record<string, Group>;
      };
      history: [number, number, number][];
      encoder: {
        encoder?: string;
        fps?: number;
        speed?: number;
        bitrate?: number;
        drop_frames?: number;
        dup_frames?: number;
      } | null;
      participants: number;
      admitted: number;
      max_guests: number;
      can_admit: boolean;
      on_program: number;
      live: boolean;
      advice: {
        level: "ok" | "warn" | "critical";
        reasons: string[];
        more_guests: number;
        tip: string;
      };
    };

const labels: Record<string, string> = {
  app: "Aplicación (ventanas y vídeo)",
  backend: "Servidor de StreamHive",
  livekit: "LiveKit (sala de vídeo)",
  ffmpeg: "Codificador (ffmpeg)",
};
const levelText = { ok: "Todo bien", warn: "Cerca del límite", critical: "Sobrecargado" };
const gb = (b: number) => (b / 1e9).toFixed(b > 1e11 ? 0 : 1);

export function Sparkline({ values, max = 100 }: { values: number[]; max?: number }) {
  if (values.length < 2) return <svg className="spark" aria-hidden="true" />;
  const w = 160, h = 34;
  const pts = values
    .map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - Math.min(1, v / max) * (h - 3) - 1.5).toFixed(1)}`)
    .join(" ");
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Meter({ label, value, text }: { label: string; value: number; text: string }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="rm-meter">
      <div className="rm-meter-head"><span>{label}</span><b>{text}</b></div>
      <div className="rm-bar" role="progressbar" aria-label={label} aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100}>
        <i className={v >= 90 ? "crit" : v >= 70 ? "warn" : ""} style={{ width: `${v}%` }} />
      </div>
    </div>
  );
}

/** Indicador compacto en la cabecera del estudio + panel con el detalle. Solo administrador. */
export function ResourceMonitor() {
  const [data, setData] = useState<Resources | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const r = await api<Resources>("/resources");
        if (!stop) setData(r);
      } catch {
        if (!stop) setData(null);
      }
    };
    void tick();
    const id = setInterval(tick, 2000);
    return () => { stop = true; clearInterval(id); };
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", key); };
  }, [open]);
  if (!data || !data.ready) return null;
  const { sample: s, advice, encoder } = data;
  const mem = s.mem_total ? (s.mem_used * 100) / s.mem_total : 0;
  // Lo que consume StreamHive (app, servidor, LiveKit y ffmpeg) frente al total del equipo.
  const own = Object.values(s.groups);
  const ownCpu = own.reduce((a, g) => a + g.cpu, 0);
  const ownMem = own.reduce((a, g) => a + g.mem, 0);
  const others = Math.max(0, s.mem_used - ownMem);
  return (
    <div className="rm" ref={box}>
      <button
        className={`rm-pill level-${advice.level}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
        title={`Uso de TODO el equipo. StreamHive usa ${ownCpu.toFixed(1)}% de CPU y ${gb(ownMem)} GB de RAM. ${advice.tip}`}
      >
        <i aria-hidden="true" />
        Equipo · CPU {s.cpu.toFixed(0)}% · RAM {mem.toFixed(0)}%
      </button>
      {open && (
        <div className="rm-panel" role="dialog" aria-label="Recursos del equipo">
          <div className={`rm-status level-${advice.level}`}>
            <b>{levelText[advice.level]}</b>
            <span>{advice.tip}</span>
          </div>
          {advice.reasons.length > 0 && (
            <ul className="rm-reasons">{advice.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          )}
          <h3 className="rm-section">Todo el equipo</h3>
          <Meter label="Procesador (total)" value={s.cpu} text={`${s.cpu.toFixed(0)}% de ${s.cpus} núcleos`} />
          <Sparkline values={data.history.map((h) => h[1])} />
          <Meter label="Memoria (total)" value={mem} text={`${gb(s.mem_used)} / ${gb(s.mem_total)} GB`} />
          <h3 className="rm-section">Solo StreamHive</h3>
          <div className="rm-row"><span>Procesador</span><b>{ownCpu.toFixed(1)}% · ≈{((ownCpu * s.cpus) / 100).toFixed(1)} núcleos</b></div>
          <div className="rm-row" title="Suma de la memoria de cada proceso; puede contar la compartida más de una vez, así que es una cota alta"><span>Memoria</span><b>{gb(ownMem)} GB ({s.mem_total ? ((ownMem * 100) / s.mem_total).toFixed(1) : "0"}% del equipo)</b></div>
          <div className="rm-row"><span>Otras aplicaciones</span><b>{gb(others)} GB</b></div>
          <h3 className="rm-section">Disco y personas</h3>
          <div className="rm-row"><span>Disco libre (grabaciones)</span><b>{gb(s.disk_free)} GB</b></div>
          <div className="rm-row">
            <span>Invitados admitidos</span>
            <b>{data.admitted} · {data.can_admit ? "caben más" : "equipo al límite"}</b>
          </div>
          <div className="rm-row"><span>Personas conectadas</span><b>{data.participants} · {data.on_program} en pantalla</b></div>
          {encoder && data.live && (
            <div className="rm-enc">
              <div className="rm-row"><span>Codificador{encoder.encoder ? ` (${encoder.encoder})` : ""}</span><b>{encoder.fps?.toFixed(0) ?? "—"} fps · {encoder.speed?.toFixed(2) ?? "—"}x</b></div>
              <div className="rm-row"><span>Bitrate / frames perdidos</span><b>{encoder.bitrate ? `${(encoder.bitrate / 1000).toFixed(1)} Mb/s` : "—"} · {encoder.drop_frames ?? 0}</b></div>
            </div>
          )}
          <details className="rm-detail">
            <summary>Desglose de StreamHive</summary>
            {Object.entries(s.groups)
              .sort((a, b) => b[1].cpu - a[1].cpu)
              .map(([k, g]) => (
                <div className="rm-row" key={k}>
                  <span>{labels[k] ?? k}</span>
                  <b>{g.cpu.toFixed(1)}% · {(g.mem / 1e6).toFixed(0)} MB</b>
                </div>
              ))}
          </details>
        </div>
      )}
    </div>
  );
}
