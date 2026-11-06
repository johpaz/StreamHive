import { expect, test } from "bun:test";
import { arrivals } from "./src/ArrivalAlert";

test("solo avisa de quien acaba de llegar a la sala de espera", () => {
  const seen = new Set(["a"]);
  expect(arrivals(seen, [{ id: "a", name: "Ana" }])).toEqual([]);
  expect(arrivals(seen, [{ id: "a", name: "Ana" }, { id: "g-1", name: "Sara" }])).toEqual([
    { id: "g-1", name: "Sara" },
  ]);
});
