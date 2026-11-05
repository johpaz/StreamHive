import { expect, test } from "bun:test";
import { mergeMessages, type ChatMessage } from "./src/chat";
const message = (
  id: string,
  sequence: number,
  deleted = false,
): ChatMessage => ({
  id,
  sequence,
  conversation_id: "c",
  sender_id: "p",
  sender_name: "Ana",
  sender_role: "guest",
  text: deleted ? "" : "hola",
  created_at: 1,
  client_message_id: id,
  deleted,
});
test("reconnect merges messages in server order and deduplicates POST/event overlap", () => {
  expect(
    mergeMessages([message("b", 2)], [message("a", 1), message("b", 2)]).map(
      (m) => m.id,
    ),
  ).toEqual(["a", "b"]);
});
test("a delayed send response or older page cannot restore a deleted message", () => {
  const result = mergeMessages([message("a", 1, true)], [message("a", 1)]);
  expect(result).toHaveLength(1);
  expect(result[0].deleted).toBe(true);
  expect(result[0].text).toBe("");
});
