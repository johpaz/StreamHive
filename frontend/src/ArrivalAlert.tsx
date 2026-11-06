import { useEffect, useRef, useState } from "react";
import { desktopNotify } from "./desktop";

type Waiting = { id: string; name: string };

/** Dos tonos cortos y suaves: alguien llegó a la sala de espera. */
function chime() {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const at = ctx.currentTime + i * 0.16;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.15);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.16);
    });
    setTimeout(() => void ctx.close().catch(() => {}), 600);
  } catch {
    // Sin audio disponible: queda el aviso visual.
  }
}

/** Nombres nuevos respecto a los ya vistos (los que estaban al abrir la app no avisan). */
export function arrivals(seen: Set<string>, waiting: Waiting[]): Waiting[] {
  return waiting.filter((p) => !seen.has(p.id));
}

/**
 * Aviso de llegada a la sala de espera, para invitados locales y del servidor de sesiones:
 * sonido, aviso con Admitir/Ver (visible también en modo foco) y notificación del sistema si
 * la ventana no está a la vista.
 */
export function ArrivalAlert({
  waiting,
  onAdmit,
  onShow,
}: {
  waiting: Waiting[];
  onAdmit: (id: string) => void;
  onShow: () => void;
}) {
  const seen = useRef<Set<string> | null>(null);
  const [latest, setLatest] = useState<Waiting | null>(null);
  useEffect(() => {
    if (!seen.current) {
      seen.current = new Set(waiting.map((p) => p.id));
      return;
    }
    const fresh = arrivals(seen.current, waiting);
    for (const p of waiting) seen.current.add(p.id);
    if (!fresh.length) return;
    const person = fresh[fresh.length - 1];
    setLatest(person);
    chime();
    const body = `${person.name} quiere entrar`;
    // En la app de escritorio avisa el sistema (si la ventana no está al frente); en un navegador,
    // la notificación web cuando la pestaña no está a la vista o no tiene el foco.
    void desktopNotify(body).then((handled) => {
      if (handled !== null) return;
      if (!(document.hidden || !document.hasFocus()) || !("Notification" in window)) return;
      const notify = () => {
        const n = new Notification("StreamHive", {
          body,
          tag: "streamhive-waiting",
        });
        n.onclick = () => window.focus();
      };
      if (Notification.permission === "granted") notify();
      else if (Notification.permission !== "denied")
        void Notification.requestPermission().then(
          (p) => p === "granted" && notify(),
        );
    });
  }, [waiting.map((p) => p.id).join(",")]);
  // Aviso pasajero: el sonido y el contador «N personas esperan» se quedan.
  useEffect(() => {
    if (!latest) return;
    const timer = setTimeout(() => setLatest(null), 12000);
    return () => clearTimeout(timer);
  }, [latest]);
  const current = latest && waiting.find((p) => p.id === latest.id);
  if (!current) return null;
  const others = waiting.length - 1;
  return (
    <div className="arrival-alert" role="alert">
      <span className="arrival-dot" aria-hidden="true" />
      <div>
        <b>{current.name} quiere entrar</b>
        <small>
          {others > 0
            ? `y ${others} persona${others > 1 ? "s" : ""} más en la sala de espera`
            : "Está en la sala de espera"}
        </small>
      </div>
      <button
        className="button primary"
        onClick={() => {
          onAdmit(current.id);
          setLatest(null);
        }}
      >
        Admitir
      </button>
      <button
        className="button"
        onClick={() => {
          onShow();
          setLatest(null);
        }}
      >
        Ver
      </button>
      <button
        className="icon-button"
        aria-label="Cerrar aviso"
        onClick={() => setLatest(null)}
      >
        ×
      </button>
    </div>
  );
}
