import { useState } from "react";

/**
 * vps: enlace del servidor de sesiones (internet). network: LAN o dirección pública
 * propia. device: solo abre en este equipo. help: no hay forma de invitar desde fuera.
 */
export type Invite =
  | {
      kind: "vps" | "network" | "device";
      url: string;
      ca?: string;
      media?: boolean;
    }
  | { kind: "help" };

/** Muestra el dominio y oculta el código secreto de la invitación. */
export const maskInvite = (url: string) => {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/join\/.+$/, "/join/");
    return `${u.origin}${path}${path.endsWith("/join/") ? "•••••••" : ""}`;
  } catch {
    return "•••••••";
  }
};

export function InviteBanner({
  invite,
  onClose,
  onSettings,
}: {
  invite: Invite;
  onClose: () => void;
  onSettings: () => void;
}) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState("");
  const close = (
    <button
      className="icon-button"
      aria-label="Cerrar invitación"
      onClick={onClose}
    >
      ×
    </button>
  );
  if (invite.kind === "help")
    return (
      <div className="invite-banner" role="status">
        <div>
          <b>Conecta tu servidor de sesiones para invitar</b>
          <p>
            Esta app solo es accesible desde este equipo, así que un enlace
            local no le serviría a nadie más. Con tu servidor de sesiones (VPS),
            la invitación sale con tu dominio.
          </p>
        </div>
        <button className="button primary" onClick={onSettings}>
          Configurar servidor
        </button>
        {close}
      </div>
    );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(invite.url);
      setCopied("Enlace copiado");
    } catch {
      setShown(true);
      setCopied("Cópialo a mano: el portapapeles no está disponible");
    }
  };
  return (
    <div className="invite-banner">
      <div>
        <b>
          {invite.kind === "device"
            ? "Enlace de prueba (solo este equipo)"
            : "Invita a tu próxima conversación"}
        </b>
        <p>
          {invite.kind === "vps"
            ? invite.media
              ? "Enlace de tu servidor de sesiones. Caduca en 24 horas. Quien lo abra entra a la sala de espera; cuando lo admitas, conecta su cámara y su micrófono y aparece en Fuentes → Participantes."
              : "Enlace de tu servidor de sesiones. Caduca en 24 horas. Quien lo abra entra a la sala de espera y al chat; este servidor no tiene cámara ni audio."
            : invite.kind === "device"
              ? "Solo abre en este equipo, por ejemplo en otra ventana del navegador. Para invitar a alguien de fuera, conecta tu servidor de sesiones."
              : "El enlace caduca en 24 horas."}
        </p>
        {invite.ca && (
          <p>
            Red local con HTTPS propio: cada invitado debe instalar una vez el{" "}
            <a href={invite.ca} target="_blank" rel="noreferrer">
              certificado de StreamHive
            </a>{" "}
            para poder usar cámara y micrófono.
          </p>
        )}
        <code className="invite-link" aria-label="Enlace de invitación">
          {shown ? invite.url : maskInvite(invite.url)}
        </code>
        {copied && (
          <p className="hint" role="status">
            {copied}
          </p>
        )}
      </div>
      <button className="button" onClick={() => setShown(!shown)}>
        {shown ? "Ocultar" : "Mostrar"}
      </button>
      <button className="button primary" onClick={() => void copy()}>
        Copiar enlace
      </button>
      {close}
    </div>
  );
}
