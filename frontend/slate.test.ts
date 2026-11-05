import { expect, test } from "bun:test";
import { allowedTrack } from "./src/media";
import { fittedSize, formatCountdown, inkFor, remainingSeconds, shownSlate, slateProgram } from "./src/slate";
import { focusAfter } from "./src/useFocusMode";
import { initialProgram, type Program, type Slate, type Slates } from "./src/types";

const slate: Slate = {
  title: "Volvemos", subtitle: "", timer_seconds: 60, timer_label: "", done_label: "",
  background: "#112233", background_asset: "wall", show_logo: false, music_asset: null,
  music_volume: 0.5, auto_on_timer_end: false, show_on_go_live: false,
};
test("countdown format", () => {
  expect(formatCountdown(0)).toBe("00:00");
  expect(formatCountdown(65)).toBe("01:05");
  expect(formatCountdown(3725)).toBe("1:02:05");
  expect(formatCountdown(-4)).toBe("00:00");
});
test("remaining time follows the server clock and stops at zero", () => {
  expect(remainingSeconds(10_000, 5_000)).toBe(5);
  expect(remainingSeconds(10_000, 5_000, 2_000)).toBe(3);
  expect(remainingSeconds(10_000, 9_001)).toBe(1);
  expect(remainingSeconds(10_000, 20_000)).toBe(0);
});
test("nothing of the program goes on air during a slate", () => {
  const program: Program = {
    ...initialProgram, layout: "screen", identities: ["host", "ana"], spotlight: "ana", screen: "ana",
    screen_audio: true, microphones_enabled: true, logo: "logo.png", revision: 7,
  };
  for (const source of ["microphone", "camera", "screen_share", "screen_share_audio"])
    expect(allowedTrack(program, "ana", source)).toBe(true);
  const covered = slateProgram(program, slate);
  for (const source of ["microphone", "camera", "screen_share", "screen_share_audio"])
    expect(allowedTrack(covered, "ana", source)).toBe(false);
  expect(covered.background_asset).toBe("wall");
  expect(covered.logo).toBeNull();
  expect(slateProgram(program, { ...slate, show_logo: true }).logo).toBe("logo.png");
  expect(covered.revision).toBe(7);
  expect(program.identities).toEqual(["host", "ana"]);
});
test("the shown slate comes from the active kind", () => {
  const slates = { start: slate, pause: { ...slate, title: "P" }, end: slate } as Slates;
  expect(shownSlate(slates, null)).toBeNull();
  expect(shownSlate(null, { kind: "pause", started_at_ms: 1, ends_at_ms: 5 })).toBeNull();
  expect(shownSlate(slates, { kind: "pause", started_at_ms: 1, ends_at_ms: 5 })).toEqual({ slate: slates.pause, endsAtMs: 5 });
});
test("long text shrinks to fit one line and ink contrasts", () => {
  expect(fittedSize("Corto", 6)).toBe(6);
  expect(fittedSize("x".repeat(60), 6)).toBeLessThan(3);
  expect(inkFor("#ffffff")).toBe("#10151c");
  expect(inkFor("#101923")).toBe("#f5f8fa");
});
test("focus opens with each session, respects leaving it and closes at the end", () => {
  // Empieza una sesión.
  expect(focusAfter(false, null, "a", null)).toBe(true);
  // Salir del foco dura hasta la sesión siguiente, también tras recargar.
  expect(focusAfter(false, "a", "a", "a")).toBe(false);
  expect(focusAfter(false, null, "a", "a")).toBe(false);
  expect(focusAfter(false, "a", "b", "a")).toBe(true);
  // Termina: se sale solo, también si se entró a mano.
  expect(focusAfter(true, "a", null, null)).toBe(false);
  // Ensayo manual sin sesión: no se toca.
  expect(focusAfter(true, null, null, null)).toBe(true);
});
