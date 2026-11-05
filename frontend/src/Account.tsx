import { useEffect, useState } from "react";
import { api } from "./api";
import { BrandMark } from "./Brand";
import type { Profile } from "./types";

export const initials = (name?: string | null) =>
  (name || "A")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0]?.toUpperCase() ?? "")
    .join("") || "A";

/** Nombre, estudio y rol de quien maneja el estudio. */
function ProfileFields({
  value,
  onChange,
}: {
  value: Profile;
  onChange: (next: Profile) => void;
}) {
  return (
    <>
      <label>
        Tu nombre
        <input
          required
          maxLength={60}
          autoComplete="name"
          placeholder="Cómo te ven en el chat"
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
        />
      </label>
      <label>
        Nombre del estudio, programa o canal
        <input
          maxLength={80}
          placeholder="Opcional"
          value={value.studio}
          onChange={(e) => onChange({ ...value, studio: e.target.value })}
        />
      </label>
      <label>
        Tu rol
        <input
          maxLength={30}
          list="profile-titles"
          placeholder="Anfitrión"
          value={value.title}
          onChange={(e) => onChange({ ...value, title: e.target.value })}
        />
        <datalist id="profile-titles">
          <option value="Anfitrión" />
          <option value="Anfitriona" />
          <option value="Moderador" />
          <option value="Moderadora" />
          <option value="Producción" />
        </datalist>
      </label>
    </>
  );
}

/** Clave de esta app para entrar desde otro navegador o equipo. */
export function AccessKey({ compact = false }: { compact?: boolean }) {
  const [key, setKey] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<{ key: string | null }>("/settings/access")
      .then((r) => setKey(r.key))
      .catch(() => setKey(null));
  }, []);
  const copy = async () => {
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      setMessage("Clave copiada");
    } catch {
      setShown(true);
      setMessage("Cópiala a mano: el portapapeles no está disponible");
    }
  };
  const rotate = async () => {
    setBusy(true);
    setMessage("");
    try {
      const r = await api<{ key: string }>("/settings/access", "POST");
      setKey(r.key);
      setShown(true);
      setConfirming(false);
      setMessage(
        "Clave nueva creada. Los otros equipos tendrán que entrar con ella.",
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "No se pudo regenerar");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`access-key ${compact ? "compact" : ""}`}>
      <div className="access-key-row">
        <code aria-label="Clave de acceso de esta app">
          {key
            ? shown
              ? key
              : "•••••-•••••-•••••-•••••"
            : "Sin clave visible"}
        </code>
        {key && (
          <>
            <button
              type="button"
              className="button"
              onClick={() => setShown(!shown)}
            >
              {shown ? "Ocultar" : "Mostrar"}
            </button>
            <button
              type="button"
              className="button"
              onClick={() => void copy()}
            >
              Copiar
            </button>
          </>
        )}
      </div>
      {!compact &&
        (confirming ? (
          <div
            className="access-key-confirm"
            role="alertdialog"
            aria-label="Regenerar clave"
          >
            <p>
              Se creará una clave nueva y se cerrará la sesión en los demás
              navegadores y equipos. Esta app sigue dentro.
            </p>
            <button
              type="button"
              className="button danger"
              disabled={busy}
              onClick={() => void rotate()}
            >
              {busy ? "Generando…" : "Sí, generar otra clave"}
            </button>
            <button
              type="button"
              className="button"
              onClick={() => setConfirming(false)}
            >
              Cancelar
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="text-button"
            onClick={() => setConfirming(true)}
          >
            {key ? "Generar otra clave" : "Crear una clave para esta app"}
          </button>
        ))}
      {message && (
        <p className="hint" role="status">
          {message}
        </p>
      )}
    </div>
  );
}

/** Configuración → Tu perfil. */
export function ProfileSettings({
  profile,
  onSaved,
}: {
  profile: Profile | null | undefined;
  onSaved: () => void;
}) {
  const [value, setValue] = useState<Profile>(
    profile ?? { name: "", studio: "", title: "Anfitrión" },
  );
  const [state, setState] = useState<"" | "saving" | "saved">("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (profile) setValue(profile);
  }, [profile?.name, profile?.studio, profile?.title]);
  return (
    <section className="panel profile-panel" id="perfil">
      <h2>Tu perfil</h2>
      <p>
        Tu nombre aparece en el chat y en la barra lateral. Solo lo editas tú,
        desde esta app.
      </p>
      <form
        className="profile-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setState("saving");
          setError("");
          try {
            const saved = await api<Profile>("/profile", "PUT", value);
            setValue(saved);
            setState("saved");
            onSaved();
          } catch (err) {
            setState("");
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
      >
        <ProfileFields
          value={value}
          onChange={(v) => {
            setValue(v);
            setState("");
          }}
        />
        {error && (
          <div className="alert error" role="alert">
            {error}
          </div>
        )}
        <button className="button primary" disabled={state === "saving"}>
          {state === "saving"
            ? "Guardando…"
            : state === "saved"
              ? "Guardado ✓"
              : "Guardar perfil"}
        </button>
      </form>
      <h3>Clave de acceso de esta app</h3>
      <p className="hint">
        Cada instalación tiene su propia clave, creada automáticamente. En esta
        app no la necesitas: sirve para abrir el estudio desde otro navegador o
        equipo.
      </p>
      <AccessKey />
    </section>
  );
}

/** Primera vez en la app de escritorio: datos de quien maneja el estudio. */
export function Welcome({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState<Profile>({
    name: "",
    studio: "",
    title: "Anfitrión",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="access-page">
      <div className="access-brand">
        <BrandMark />
        StreamHive
      </div>
      <section className="access-card welcome-card">
        <span className="eyebrow">BIENVENIDA</span>
        <h1>Hola, empecemos.</h1>
        <p>
          Cuéntanos quién maneja este estudio. Puedes cambiarlo cuando quieras
          en Configuración → Tu perfil.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await api("/profile", "PUT", value);
              onDone();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <ProfileFields value={value} onChange={setValue} />
          <div className="welcome-key">
            <b>Tu clave de acceso ya está creada</b>
            <small>
              Es solo de esta app y entras sin escribirla. Guárdala si vas a
              abrir el estudio desde otro equipo.
            </small>
            <AccessKey compact />
          </div>
          {error && (
            <div className="alert error" role="alert">
              {error}
            </div>
          )}
          <button className="button primary" disabled={busy}>
            {busy ? "Guardando…" : "Abrir mi estudio →"}
          </button>
        </form>
      </section>
    </div>
  );
}
