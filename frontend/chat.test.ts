import { describe, expect, test } from "bun:test";
import {
  formatBytes,
  isChatImage,
  linkParts,
  mergeMessages,
  type ChatMessage,
} from "./src/chat";
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

describe("chat links and files", () => {
  test("only http(s) links become links, without trailing punctuation", () => {
    expect(linkParts("Mira https://ejemplo.com/guion.pdf, y luego.")).toEqual([
      { text: "Mira " },
      {
        text: "https://ejemplo.com/guion.pdf",
        href: "https://ejemplo.com/guion.pdf",
      },
      { text: ", y luego." },
    ]);
    expect(
      linkParts("javascript:alert(1) data:text/html,x <b>hola</b>"),
    ).toEqual([{ text: "javascript:alert(1) data:text/html,x <b>hola</b>" }]);
    expect(
      linkParts("(https://es.wikipedia.org/wiki/Abeja_(insecto))").map(
        (p) => p.href,
      ),
    ).toContain("https://es.wikipedia.org/wiki/Abeja_(insecto)");
    expect(linkParts("sin enlaces")).toEqual([{ text: "sin enlaces" }]);
  });
  test("sizes read naturally", () => {
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1,5 MB");
    expect(formatBytes(25 * 1024 * 1024)).toBe("25 MB");
  });
  test("only real images get a preview", () => {
    expect(isChatImage("image/png")).toBe(true);
    expect(isChatImage("application/pdf")).toBe(false);
    expect(isChatImage("image/svg+xml")).toBe(false);
  });
});
