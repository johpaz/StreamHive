export type ChatSize = "reduced" | "medium" | "full";
export interface ChatMessage {
  id: string;
  conversation_id: string;
  sender_id: string;
  sender_name: string;
  sender_role: "admin" | "guest";
  text: string;
  created_at: number;
  deleted: boolean;
  client_message_id: string;
  sequence: number;
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
