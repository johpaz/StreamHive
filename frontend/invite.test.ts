import { expect, test } from "bun:test";
import { maskInvite } from "./src/InviteBanner";

test("la invitación muestra el dominio y oculta el código", () => {
  const masked = maskInvite("https://sesiones.example.com/join/AbC123secreto");
  expect(masked).toBe("https://sesiones.example.com/join/•••••••");
  expect(masked).not.toContain("AbC123");
  expect(maskInvite("no es una url")).toBe("•••••••");
});
