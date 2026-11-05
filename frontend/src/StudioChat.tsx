import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { api, ApiError } from "./api";
import { ChatBee } from "./ChatBee";
import {
  CHAT_FILE_ACCEPT,
  chatFileUrl,
  formatBytes,
  isChatImage,
  linkParts,
  mergeMessages,
  uploadChatFile,
  type ChatAttachment,
  type ChatMessage,
  type ChatPage,
  type ChatSize,
} from "./chat";
import "./chat.css";

type Pending = {
  id: string;
  text: string;
  failed: boolean;
  conversation: string;
  attachment?: ChatAttachment;
};
/** Texto plano con los enlaces http(s) clicables; nunca se interpreta HTML. */
function ChatText({ text }: { text: string }) {
  return (
    <>
      {linkParts(text).map((part, i) =>
        part.href ? (
          <a key={i} href={part.href} target="_blank" rel="noopener noreferrer">
            {part.text}
          </a>
        ) : (
          part.text
        ),
      )}
    </>
  );
}
function ChatFile({
  file,
  conversation,
  admin,
  onLibrary,
}: {
  file: ChatAttachment;
  conversation: string;
  admin: boolean;
  onLibrary: (file: ChatAttachment) => void;
}) {
  const url = chatFileUrl(file.id, conversation);
  const image = isChatImage(file.mime);
  return (
    <div className="chat-file">
      {image && (
        <a href={url} download={file.name} className="chat-file-preview">
          <img src={url} alt={file.name} loading="lazy" />
        </a>
      )}
      <div className="chat-file-info">
        <span className="chat-file-icon" aria-hidden="true">
          {image ? "🖼" : "📄"}
        </span>
        <div>
          <b title={file.name}>{file.name}</b>
          <small>{formatBytes(file.size)}</small>
        </div>
      </div>
      <div className="chat-file-actions">
        <a
          href={url}
          download={file.name}
          aria-label={`Descargar ${file.name}`}
        >
          Descargar
        </a>
        {admin && image && (
          <button type="button" onClick={() => onLibrary(file)}>
            Llevar a Archivos
          </button>
        )}
      </div>
    </div>
  );
}
/** Altura que ocupa la barra de emisión fija al fondo de la ventana. El chat
 * flotante se coloca encima para no tapar Grabar ni Finalizar directo. */
function useBroadcastBarLift() {
  const [lift, setLift] = useState(0);
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const bar = document.querySelector<HTMLElement>(
        ".workspace-broadcast-bar",
      );
      const rect = bar?.getBoundingClientRect();
      // Solo cuando la barra está pegada al fondo (o lo pisa); si está a media
      // pantalla por el desplazamiento, el chat sigue en su esquina.
      const next =
        rect &&
        rect.height > 0 &&
        rect.top < window.innerHeight &&
        rect.bottom > window.innerHeight - 48
          ? Math.ceil(window.innerHeight - rect.top)
          : 0;
      setLift((prev) => (prev === next ? prev : next));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    const resize = new ResizeObserver(schedule);
    let observed: Element | null = null;
    const watch = () => {
      const bar = document.querySelector(".workspace-broadcast-bar");
      if (bar === observed) return;
      resize.disconnect();
      observed = bar;
      if (bar) resize.observe(bar);
      schedule();
    };
    watch();
    const mutations = new MutationObserver(watch);
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, {
      capture: true,
      passive: true,
    });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, { capture: true });
    };
  }, []);
  return lift;
}

export function StudioChat({
  me,
  sessionId,
}: {
  me: { id: string; role: "admin" | "guest" };
  sessionId?: string;
}) {
  const [viewerId, setViewerId] = useState(me.id);
  const viewer = useRef(me.id);
  const scroll = useRef(0);
  const [size, setSize] = useState<ChatSize>("reduced");
  const lift = useBroadcastBarLift();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [canReset, setCanReset] = useState(false);
  const [conversation, setConversation] = useState("");
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<ChatAttachment | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const [fileError, setFileError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const uploading = useRef<AbortController | null>(null);
  const [error, setError] = useState("");
  const [online, setOnline] = useState(false);
  const [unread, setUnread] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [mood, setMood] = useState<"idle" | "message" | "sent">("idle");
  const [older, setOlder] = useState<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const bubble = useRef<HTMLButtonElement>(null);
  const expand = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const state = useRef({
    cursor: undefined as number | undefined,
    conversation: "",
    busy: false,
    rerun: false,
    generation: 0,
    size,
    atBottom: true,
    visible: !document.hidden,
  });
  state.current.size = size;
  const alive = useRef(true);
  const known = useRef(new Set<string>());
  const moodTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const pulse = (next: "message" | "sent") => {
    setMood(next);
    clearTimeout(moodTimer.current);
    moodTimer.current = setTimeout(() => setMood("idle"), 1600);
  };
  const clear = useCallback(() => {
    state.current.generation++;
    state.current.cursor = undefined;
    state.current.conversation = "";
    known.current.clear();
    setMessages([]);
    setPending([]);
    setDraft("");
    uploading.current?.abort();
    setAttachment(null);
    setProgress(null);
    setFileError("");
    setNotice("");
    setConversation("");
    setUnread(0);
    setAnnouncement("");
    setCanReset(false);
    scroll.current = 0;
    state.current.atBottom = true;
    setOlder(null);
    setConfirmReset(false);
  }, []);
  const sync = useCallback(async () => {
    const s = state.current;
    if (s.busy) {
      s.rerun = true;
      return;
    }
    s.busy = true;
    const generation = s.generation;
    try {
      let more = true;
      while (more && alive.current && generation === s.generation) {
        const initial = s.cursor === undefined;
        const query = new URLSearchParams();
        if (sessionId || s.conversation)
          query.set("session_id", sessionId || s.conversation);
        if (!initial) query.set("after", String(s.cursor));
        const page = await api<ChatPage>(`/chat/messages?${query}`);
        if (!alive.current || generation !== s.generation) return;
        if (s.conversation && s.conversation !== page.conversation_id) {
          clear();
          s.rerun = true;
          return;
        }
        s.conversation = page.conversation_id;
        setConversation(page.conversation_id);
        setCanReset(page.can_reset === true);
        viewer.current = page.viewer_id || me.id;
        setViewerId(viewer.current);
        const incoming = [
          ...page.messages,
          ...page.events.map((e) => e.message),
        ];
        const fresh = incoming.filter((m) => !known.current.has(m.id));
        incoming.forEach((m) => known.current.add(m.id));
        setMessages((previous) => mergeMessages(previous, incoming));
        setPending((previous) =>
          previous.filter(
            (p) => !incoming.some((m) => m.client_message_id === p.id),
          ),
        );
        if (initial) {
          setOlder(page.has_more ? page.next_before : null);
        } else {
          const count = fresh.filter(
            (m) => m.sender_id !== viewer.current && !m.deleted,
          ).length;
          if (count) {
            pulse("message");
            if (s.size === "reduced" || !s.atBottom || !s.visible)
              setUnread((n) => n + count);
            else
              setAnnouncement(
                count === 1
                  ? "Nuevo mensaje en el chat"
                  : `${count} mensajes nuevos en el chat`,
              );
          }
        }
        s.cursor = page.cursor;
        more = !initial && page.has_more;
      }
      if (alive.current && generation === s.generation) {
        setOnline(true);
        setError("");
      }
    } catch (e) {
      if (!alive.current || generation !== s.generation) return;
      setOnline(false);
      if (e instanceof ApiError && [401, 403, 404, 410].includes(e.status)) {
        const hadConversation = !!s.conversation;
        clear();
        if (e.status === 410 && hadConversation && !sessionId) s.rerun = true;
      }
      setError(
        e instanceof Error ? e.message : "No se pudo actualizar el chat",
      );
    } finally {
      s.busy = false;
      if (s.rerun && alive.current) {
        s.rerun = false;
        void sync();
      }
    }
  }, [clear, me.id, sessionId]);
  useEffect(() => {
    alive.current = true;
    const onSignal = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (
        detail?.type === "chat.closed" &&
        detail.conversation_id === state.current.conversation
      )
        clear();
      void sync();
    };
    const visible = () => {
      state.current.visible = !document.hidden;
      if (!document.hidden) {
        if (state.current.size !== "reduced" && state.current.atBottom)
          setUnread(0);
        void sync();
      }
    };
    window.addEventListener("streamhive-chat", onSignal);
    window.addEventListener("online", onSignal);
    document.addEventListener("visibilitychange", visible);
    void sync();
    const timer = setInterval(() => void sync(), 5000);
    return () => {
      alive.current = false;
      state.current.generation++;
      clearInterval(timer);
      clearTimeout(moodTimer.current);
      window.removeEventListener("streamhive-chat", onSignal);
      window.removeEventListener("online", onSignal);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [sync, clear]);
  // Follow messages only while the reader is already at the bottom.
  useLayoutEffect(() => {
    if (size !== "reduced" && state.current.atBottom && list.current) {
      list.current.scrollTop = list.current.scrollHeight;
      if (!document.hidden) setUnread(0);
    }
  }, [messages, pending, size]);
  useLayoutEffect(() => {
    if (size !== "reduced" && list.current && !state.current.atBottom)
      list.current.scrollTop = scroll.current;
  }, [size]);
  const previousSize = useRef<ChatSize>("reduced");
  useEffect(() => {
    const previous = previousSize.current;
    previousSize.current = size;
    setConfirmReset(false);
    if (size === "reduced") {
      if (previous !== "reduced") bubble.current?.focus();
      return;
    }
    if (previous === "full") expand.current?.focus({ preventScroll: true });
    else if (previous === "reduced")
      input.current?.focus({ preventScroll: true });
  }, [size]);
  useEffect(() => {
    if (size === "reduced") return;
    const key = (e: KeyboardEvent) => {
      const dialogs = [
        ...document.querySelectorAll(
          "dialog[open], [role='dialog'][aria-modal='true']",
        ),
      ];
      if (
        dialogs.some((d) => d !== panel.current && !panel.current?.contains(d))
      )
        return;
      if (e.key === "Escape") {
        e.preventDefault();
        setSize(size === "full" ? "medium" : "reduced");
      }
      if (size === "full" && e.key === "Tab") {
        const items = [
          ...(panel.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),textarea:not(:disabled),[tabindex='0']",
          ) || []),
        ];
        const first = items[0],
          last = items.at(-1);
        if (
          e.shiftKey &&
          (document.activeElement === first ||
            !panel.current?.contains(document.activeElement))
        ) {
          e.preventDefault();
          last?.focus();
        } else if (
          !e.shiftKey &&
          (document.activeElement === last ||
            !panel.current?.contains(document.activeElement))
        ) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    // In full mode, isolate the studio while keeping top-layer dialogs usable.
    const root = document.getElementById("root");
    const wasInert = root?.inert;
    const overflow = document.body.style.overflow;
    if (size === "full") {
      if (root) root.inert = true;
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.removeEventListener("keydown", key);
      if (size === "full") {
        if (root) root.inert = !!wasInert;
        document.body.style.overflow = overflow;
      }
    };
  }, [size]);
  const send = async (item: Pending) => {
    const generation = state.current.generation;
    setPending((p) => [
      ...p.filter((x) => x.id !== item.id),
      { ...item, failed: false },
    ]);
    try {
      const message = await api<ChatMessage>("/chat/messages", "POST", {
        session_id: item.conversation,
        client_message_id: item.id,
        text: item.text,
        ...(item.attachment ? { attachment_id: item.attachment.id } : {}),
      });
      if (!alive.current || generation !== state.current.generation) return;
      known.current.add(message.id);
      setMessages((p) => mergeMessages(p, [message]));
      setPending((p) => p.filter((x) => x.id !== item.id));
      setError("");
      pulse("sent");
      void sync();
    } catch (e) {
      if (!alive.current || generation !== state.current.generation) return;
      setPending((p) =>
        p.map((x) => (x.id === item.id ? { ...x, failed: true } : x)),
      );
      setError(e instanceof Error ? e.message : "No se pudo enviar");
      if (e instanceof ApiError && [401, 403, 404, 410].includes(e.status))
        void sync();
    }
  };
  const submit = () => {
    const text = draft.trim();
    if (
      (!text && !attachment) ||
      progress !== null ||
      [...text].length > 2000 ||
      new TextEncoder().encode(text).length > 8192 ||
      !conversation ||
      !online
    )
      return;
    setDraft("");
    setAttachment(null);
    state.current.atBottom = true;
    void send({
      id: crypto.randomUUID(),
      text,
      failed: false,
      conversation,
      ...(attachment ? { attachment } : {}),
    });
  };
  const attach = async (file: File) => {
    if (!conversation) return;
    const generation = state.current.generation;
    uploading.current?.abort();
    const controller = new AbortController();
    uploading.current = controller;
    setAttachment(null);
    setProgress(0);
    setFileError("");
    try {
      const uploaded = await uploadChatFile(
        file,
        conversation,
        (n) => alive.current && setProgress(n),
        controller.signal,
      );
      if (alive.current && generation === state.current.generation)
        setAttachment(uploaded);
    } catch (e) {
      if (alive.current && !controller.signal.aborted)
        setFileError(
          e instanceof Error ? e.message : "No se pudo subir el archivo",
        );
    } finally {
      if (uploading.current === controller) {
        uploading.current = null;
        if (alive.current) setProgress(null);
      }
      input.current?.focus();
    }
  };
  const toLibrary = async (file: ChatAttachment) => {
    try {
      await api(
        `/chat/files/${encodeURIComponent(file.id)}/library?session_id=${encodeURIComponent(conversation)}`,
        "POST",
      );
      if (alive.current) {
        setFileError("");
        setNotice(`«${file.name}» ya está en Archivos`);
        setTimeout(() => alive.current && setNotice(""), 4000);
      }
    } catch (e) {
      if (alive.current)
        setFileError(
          e instanceof Error ? e.message : "No se pudo llevar a Archivos",
        );
    }
  };
  const loadOlder = async () => {
    if (!older || loadingOlder) return;
    const generation = state.current.generation;
    setLoadingOlder(true);
    try {
      const page = await api<ChatPage>(
        `/chat/messages?session_id=${encodeURIComponent(conversation)}&before=${older}`,
      );
      if (!alive.current || generation !== state.current.generation) return;
      const el = list.current,
        height = el?.scrollHeight || 0,
        top = el?.scrollTop || 0;
      state.current.atBottom = false;
      page.messages.forEach((m) => known.current.add(m.id));
      setMessages((p) => mergeMessages(p, page.messages));
      setOlder(page.has_more ? page.next_before : null);
      requestAnimationFrame(() => {
        if (el) el.scrollTop = top + el.scrollHeight - height;
      });
    } catch (e) {
      if (alive.current)
        setError(
          e instanceof Error ? e.message : "No se pudo cargar el historial",
        );
    } finally {
      if (alive.current) setLoadingOlder(false);
    }
  };
  const remove = async (id: string) => {
    const generation = state.current.generation;
    try {
      const m = await api<ChatMessage>(
        `/chat/messages/${id}?session_id=${encodeURIComponent(conversation)}`,
        "DELETE",
      );
      if (alive.current && generation === state.current.generation)
        setMessages((p) => mergeMessages(p, [m]));
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : "No se pudo borrar");
    }
  };
  const reset = async () => {
    setResetting(true);
    try {
      await api("/chat/conversation", "POST", { session_id: conversation });
      clear();
      void sync();
    } catch (e) {
      if (alive.current)
        setError(
          e instanceof Error ? e.message : "No se pudo abrir otra conversación",
        );
    } finally {
      if (alive.current) setResetting(false);
    }
  };
  const full = size === "full";
  return createPortal(
    <div
      className={`studio-chat studio-chat-${size}`}
      style={{ "--chat-lift": `${full ? 0 : lift}px` } as CSSProperties}
    >
      <div
        className="chat-sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </div>
      {size === "reduced" ? (
        <button
          ref={bubble}
          className="chat-bubble"
          aria-label={`Abrir chat general${unread ? `, ${unread} mensajes sin leer` : ""}`}
          onClick={() => setSize("medium")}
        >
          <ChatBee mood={!online ? "reconnecting" : mood} />
          {unread > 0 && (
            <span className="chat-unread">{unread > 99 ? "99+" : unread}</span>
          )}
        </button>
      ) : (
        <section
          ref={panel}
          className="chat-window"
          role={full ? "dialog" : "region"}
          aria-modal={full ? true : undefined}
          aria-label="Chat general"
        >
          <header className="chat-header">
            <ChatBee mood={!online ? "reconnecting" : mood} />
            <div>
              <strong>Chat general</strong>
              <small>
                {online ? "Directo y sala de espera" : "Reconectando…"}
              </small>
            </div>
            <button
              ref={expand}
              type="button"
              aria-label={
                full ? "Tamaño medio" : "Ampliar chat a pantalla completa"
              }
              onClick={() => setSize(full ? "medium" : "full")}
            >
              {full ? "↙" : "⛶"}
            </button>
            <button
              type="button"
              aria-label="Reducir chat"
              onClick={() => setSize("reduced")}
            >
              −
            </button>
          </header>
          {confirmReset ? (
            <div className="chat-confirm">
              <p>
                ¿Cerrar esta conversación y empezar otra vacía? Los
                participantes pasarán al nuevo chat.
              </p>
              <button disabled={resetting} onClick={() => void reset()}>
                Nueva conversación
              </button>
              <button onClick={() => setConfirmReset(false)}>Cancelar</button>
            </div>
          ) : null}
          <div
            className="chat-messages"
            ref={list}
            tabIndex={0}
            aria-label="Mensajes del chat"
            onScroll={() => {
              const el = list.current;
              if (!el) return;
              scroll.current = el.scrollTop;
              state.current.atBottom =
                el.scrollHeight - el.scrollTop - el.clientHeight < 32;
              if (state.current.atBottom && !document.hidden) setUnread(0);
            }}
          >
            {older !== null && (
              <button
                className="chat-load"
                disabled={loadingOlder}
                onClick={() => void loadOlder()}
              >
                {loadingOlder ? "Cargando…" : "Ver mensajes anteriores"}
              </button>
            )}
            {!messages.length && !pending.length && (
              <div className="chat-empty">
                <ChatBee />
                <strong>La conversación empieza aquí</strong>
                <p>Saluda al anfitrión y a los invitados del estudio.</p>
              </div>
            )}
            {messages.map((m) => (
              <article
                key={m.id}
                className={`chat-message ${m.sender_id === viewerId ? "chat-own" : ""}`}
              >
                <div className="chat-message-meta">
                  <strong>{m.sender_name}</strong>
                  {m.sender_role === "admin" && <span>Anfitrión</span>}
                  {m.sender_role === "waiting" && (
                    <span className="chat-waiting">En sala de espera</span>
                  )}
                  <time dateTime={new Date(m.created_at * 1000).toISOString()}>
                    {new Date(m.created_at * 1000).toLocaleTimeString("es", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </div>
                {(m.deleted || m.text) && (
                  <p className={m.deleted ? "chat-deleted" : ""}>
                    {m.deleted ? (
                      "Mensaje eliminado"
                    ) : (
                      <ChatText text={m.text} />
                    )}
                  </p>
                )}
                {!m.deleted && m.attachment && (
                  <ChatFile
                    file={m.attachment}
                    conversation={conversation}
                    admin={me.role === "admin"}
                    onLibrary={(f) => void toLibrary(f)}
                  />
                )}
                {me.role === "admin" && !m.deleted && (
                  <button
                    className="chat-delete"
                    aria-label={`Borrar mensaje de ${m.sender_name}`}
                    onClick={() => void remove(m.id)}
                  >
                    Borrar
                  </button>
                )}
              </article>
            ))}
            {pending.map((p) => (
              <article
                className="chat-message chat-own chat-pending"
                key={p.id}
              >
                {p.text && <p>{p.text}</p>}
                {p.attachment && (
                  <p className="chat-pending-file">📎 {p.attachment.name}</p>
                )}
                <small>{p.failed ? "No enviado" : "Enviando…"}</small>
                {p.failed && (
                  <button onClick={() => void send(p)}>Reintentar envío</button>
                )}
              </article>
            ))}
          </div>
          {unread > 0 && (
            <button
              className="chat-new"
              onClick={() => {
                state.current.atBottom = true;
                if (list.current)
                  list.current.scrollTop = list.current.scrollHeight;
                setUnread(0);
              }}
            >
              {unread} mensajes nuevos ↓
            </button>
          )}
          {notice && (
            <div className="chat-notice" role="status">
              {notice}
            </div>
          )}
          {fileError && (
            <div className="chat-error" role="alert">
              {fileError}
              <button onClick={() => setFileError("")}>Cerrar</button>
            </div>
          )}
          {error && (
            <div className="chat-error" role="alert">
              {error}
              <button onClick={() => void sync()}>Reconectar</button>
            </div>
          )}
          <form
            className="chat-composer"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            {(progress !== null || attachment) && (
              <div className="chat-attachment">
                <span aria-hidden="true">📎</span>
                {progress !== null ? (
                  <>
                    <span>Subiendo… {progress}%</span>
                    <progress
                      max={100}
                      value={progress}
                      aria-label="Progreso de la subida"
                    />
                    <button
                      type="button"
                      onClick={() => uploading.current?.abort()}
                    >
                      Cancelar
                    </button>
                  </>
                ) : (
                  attachment && (
                    <>
                      <span
                        className="chat-attachment-name"
                        title={attachment.name}
                      >
                        {attachment.name}
                      </span>
                      <small>{formatBytes(attachment.size)}</small>
                      <button
                        type="button"
                        aria-label={`Quitar ${attachment.name}`}
                        onClick={() => setAttachment(null)}
                      >
                        Quitar
                      </button>
                    </>
                  )
                )}
              </div>
            )}
            <label className="chat-sr-only" htmlFor="studio-chat-input">
              Mensaje para todos
            </label>
            <textarea
              id="studio-chat-input"
              ref={input}
              placeholder="Escribe para todos…"
              value={draft}
              rows={2}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <div>
              <input
                ref={fileInput}
                type="file"
                hidden
                accept={CHAT_FILE_ACCEPT}
                aria-label="Archivo para el chat"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void attach(file);
                }}
              />
              <button
                type="button"
                className="chat-attach"
                aria-label="Adjuntar archivo"
                title="Adjuntar archivo (PDF, imágenes, Office, texto o ZIP, hasta 25 MB)"
                disabled={!online || !conversation || progress !== null}
                onClick={() => fileInput.current?.click()}
              >
                📎
              </button>
              <small className={[...draft].length > 2000 ? "chat-limit" : ""}>
                {[...draft].length}/2000
              </small>
              <button
                type="submit"
                disabled={
                  !online ||
                  !conversation ||
                  progress !== null ||
                  (!draft.trim() && !attachment) ||
                  [...draft.trim()].length > 2000
                }
              >
                Enviar
              </button>
            </div>
          </form>
          {me.role === "admin" && canReset && (
            <footer className="chat-footer">
              <button disabled={!online} onClick={() => setConfirmReset(true)}>
                Nueva conversación local
              </button>
            </footer>
          )}
        </section>
      )}
    </div>,
    document.body,
  );
}
