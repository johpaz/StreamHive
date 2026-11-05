import { useEffect, useRef, useState } from "react";

const DISMISSED = "streamhive.focus-dismissed";
const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* Sin almacenamiento la preferencia dura hasta recargar. */
  }
};
/**
 * Decide el foco cuando cambia la sesión (id de la sesión en marcha, o null).
 * Entra en cada sesión nueva salvo que ya se hubiera salido de ella; sale al terminar.
 */
export function focusAfter(
  current: boolean,
  previous: string | null,
  session: string | null,
  dismissed: string | null,
) {
  if (session === previous) return current;
  if (!session) return false;
  return session !== dismissed;
}
export function useFocusMode(session: string | null) {
  const [focus, setFocus] = useState(false);
  const previous = useRef<string | null>(null);
  useEffect(() => {
    // El actualizador corre más tarde: necesita el valor anterior ya copiado.
    const before = previous.current;
    previous.current = session;
    setFocus((current) => focusAfter(current, before, session, read(DISMISSED)));
  }, [session]);
  return {
    focus,
    enter: () => {
      write(DISMISSED, null);
      setFocus(true);
    },
    leave: () => {
      if (session) write(DISMISSED, session);
      setFocus(false);
    },
  };
}
/** Preferencia sencilla recordada en este navegador. */
export function useStoredFlag(key: string) {
  const [value, setValue] = useState(() => read(key) === "1");
  return [
    value,
    (next: boolean) => {
      write(key, next ? "1" : null);
      setValue(next);
    },
  ] as const;
}
