import { useEffect, useState } from "react";
import { api } from "./api";
import { desktopBridge } from "./desktop";
import type { RecordingsLocation } from "./types";

/** Muestra dónde se guardan las grabaciones y permite elegir otra carpeta. */
export function RecordingsFolder({ pending, run, version }: {
  pending: boolean;
  run: (action: () => Promise<unknown>, message?: string) => Promise<void>;
  version: unknown;
}) {
  const [location, setLocation] = useState<RecordingsLocation | null>(null);
  const [path, setPath] = useState("");
  const [edited, setEdited] = useState(false);
  useEffect(() => {
    let stop = false;
    void api<RecordingsLocation>("/settings/recordings").then((l) => {
      if (stop) return;
      setLocation(l);
      setPath((current) => (edited ? current : l.path));
    }).catch(() => {});
    return () => { stop = true; };
  }, [version, edited]);
  if (!location) return <p className="hint">Comprobando la carpeta de grabaciones…</p>;
  const bridge = desktopBridge();
  const save = (next: string | null) => run(async () => {
    const saved = await api<RecordingsLocation>("/settings/recordings", "PUT", { path: next });
    setLocation(saved);
    setPath(saved.path);
    setEdited(false);
  }, "Las próximas grabaciones se guardarán en la carpeta indicada.");
  const blocked = pending || location.locked;
  return (
    <div className="recordings-folder">
      <div className="output-row">
        <span>{location.is_default ? "Carpeta actual (predeterminada)" : "Carpeta actual"}</span>
        <b className="folder-path">{location.path}</b>
      </div>
      {!location.is_default && (
        <div className="output-row">
          <span>Predeterminada</span>
          <b className="folder-path">{location.default_path}</b>
        </div>
      )}
      {location.free_bytes !== null && (
        <div className="output-row">
          <span>Libre en esa carpeta</span>
          <b>{(location.free_bytes / 1e9).toFixed(1)} GB</b>
        </div>
      )}
      {!location.available && (
        <div className="alert warning">
          Esta carpeta no está disponible. Conecta su disco o elige otra antes de grabar.
        </div>
      )}
      {location.editable ? (
        <>
          <label className="folder-field">
            Guardar las grabaciones en
            <input
              value={path}
              disabled={blocked}
              spellCheck={false}
              placeholder={location.default_path}
              onChange={(e) => { setPath(e.target.value); setEdited(true); }}
            />
          </label>
          <div className="folder-actions">
            {bridge?.chooseFolder && (
              <button className="button" disabled={blocked} onClick={() => {
                void bridge.chooseFolder?.(location.path).then((folder) => {
                  if (folder) void save(folder);
                });
              }}>Elegir carpeta…</button>
            )}
            <button className="button" disabled={blocked || !edited || !path.trim()} onClick={() => void save(path)}>
              Guardar carpeta
            </button>
            {bridge?.openFolder && location.available && (
              <button className="text-button" onClick={() => void run(() => bridge.openFolder!(location.path))}>
                Abrir carpeta
              </button>
            )}
            {!location.is_default && (
              <button className="text-button" disabled={blocked} onClick={() => void save(null)}>
                Usar la predeterminada
              </button>
            )}
          </div>
          <p className="hint">
            {location.locked
              ? "Detén la grabación para cambiar la carpeta."
              : "Es una carpeta del equipo donde se ejecuta StreamHive. Solo cambia dónde se guardan las próximas grabaciones: las anteriores se quedan donde están."}
          </p>
        </>
      ) : (
        <p className="hint">La carpeta la define el despliegue de este servidor.</p>
      )}
    </div>
  );
}
