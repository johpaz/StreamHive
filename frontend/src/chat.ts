export type ChatSize = "reduced" | "medium" | "full";
export interface ChatMessage {
  id: string;
  conversation_id: string;
  sender_id: string;
  sender_name: string;
  sender_role: "admin" | "guest" | "waiting";
  text: string;
  created_at: number;
  deleted: boolean;
  client_message_id: string;
  sequence: number;
  attachment?: ChatAttachment | null;
}
export interface ChatAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
}
export interface ChatEvent {
  type: string;
  message: ChatMessage;
  sequence: number;
}
export interface ChatPage {
  conversation_id: string;
  messages: ChatMessage[];
  events: ChatEvent[];
  viewer_id?: string;
  can_reset?: boolean;
  cursor: number;
  has_more: boolean;
  next_before: number | null;
}
export function mergeMessages(
  previous: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] {
  const map = new Map(previous.map((m) => [m.id, m]));
  for (const message of incoming) {
    const old = map.get(message.id);
    // A late POST response must never resurrect text removed by a moderator.
    map.set(
      message.id,
      old?.deleted ? { ...message, deleted: true, text: "" } : message,
    );
  }
  return [...map.values()].sort((a, b) => a.sequence - b.sequence);
}
export function chatSignal(data?: string) {
  if (!data) {
    window.dispatchEvent(new CustomEvent("streamhive-chat"));
    return;
  }
  try {
    const event = JSON.parse(data);
    if (typeof event.type === "string" && event.type.startsWith("chat."))
      window.dispatchEvent(
        new CustomEvent("streamhive-chat", { detail: event }),
      );
  } catch {
    /* Legacy refresh notifications are handled by the studio. */
  }
}

/** Materiales del chat: los mismos tipos que admite el servidor. */
export const CHAT_FILE_ACCEPT =
  ".pdf,.png,.jpg,.jpeg,.webp,.txt,.csv,.md,.docx,.xlsx,.pptx,.odt,.ods,.odp,.zip";
export const CHAT_FILE_MAX = 25 * 1024 * 1024;
export function chatFileUrl(id: string, conversation: string) {
  return `/api/v1/chat/files/${encodeURIComponent(id)}?session_id=${encodeURIComponent(conversation)}`;
}
export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0).replace(".", ",")} MB`;
}
export function isChatImage(mime: string) {
  return ["image/png", "image/jpeg", "image/webp"].includes(mime);
}
/** Parte el texto en trozos y enlaces http(s); el resto queda como texto. */
export function linkParts(text: string): { text: string; href?: string }[] {
  const parts: { text: string; href?: string }[] = [];
  const pattern = /\bhttps?:\/\/[^\s<>"]+/gi;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    let url = match[0];
    // La puntuación final suele ser de la frase, no del enlace; un ")" final
    // solo se quita si no cierra un paréntesis del propio enlace.
    const count = (c: string) => url.split(c).length - 1;
    while (
      /[.,;:!?)\]}'»]$/.test(url) &&
      !(url.endsWith(")") && count("(") >= count(")"))
    )
      url = url.slice(0, -1);
    const start = match.index ?? 0;
    let href: string | undefined;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:")
        href = parsed.href;
    } catch {
      href = undefined;
    }
    if (!href) continue;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ text: url, href });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
export function uploadChatFile(
  file: File,
  conversation: string,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<ChatAttachment> {
  return new Promise((resolve, reject) => {
    if (file.size > CHAT_FILE_MAX) {
      reject(Error("Cada archivo puede pesar hasta 25 MB"));
      return;
    }
    if (!file.size) {
      reject(Error("El archivo está vacío"));
      return;
    }
    const request = new XMLHttpRequest();
    request.open(
      "POST",
      `/api/v1/chat/files?session_id=${encodeURIComponent(conversation)}`,
    );
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.setRequestHeader(
      "X-File-Name",
      btoa(
        Array.from(new TextEncoder().encode(file.name), (b) =>
          String.fromCharCode(b),
        ).join(""),
      ),
    );
    request.upload.onprogress = (event) => {
      if (event.lengthComputable)
        onProgress(Math.round((event.loaded / event.total) * 100));
    };
    const abort = () => request.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const done = () => signal?.removeEventListener("abort", abort);
    request.onload = () => {
      done();
      let body: { error?: string } & Partial<ChatAttachment> = {};
      try {
        body = JSON.parse(request.responseText);
      } catch {
        /* Se informa abajo. */
      }
      if (request.status >= 200 && request.status < 300 && body.id)
        resolve(body as ChatAttachment);
      else reject(Error(body.error || "No se pudo subir el archivo"));
    };
    request.onerror = () => {
      done();
      reject(Error("Se interrumpió la subida; vuelve a intentarlo"));
    };
    request.onabort = () => {
      done();
      reject(Error("Subida cancelada"));
    };
    request.send(file);
  });
}
