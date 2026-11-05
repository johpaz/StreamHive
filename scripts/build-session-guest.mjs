import { existsSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const result = await Bun.build({
  entrypoints: [resolve(root, "frontend/src/SessionGuest.tsx")],
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  outdir: resolve(root, "frontend/dist/session-guest"),
  naming: { entry: "guest.[ext]", asset: "[name].[ext]" },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

await Bun.write(
  resolve(root, "sessions/web/guest.js"),
  Bun.file(resolve(root, "frontend/dist/session-guest/guest.js")),
);
await Bun.write(
  resolve(root, "sessions/web/chat.css"),
  Bun.file(resolve(root, "frontend/dist/session-guest/guest.css")),
);

// Cámara y audio del invitado: el SDK de LiveKit se sirve desde el propio servidor (su CSP solo
// admite scripts propios). Si no está, se descarga con verificación de integridad (vendor-sdk).
const sdk = resolve(root, "frontend/public/livekit-client.umd.js");
if (!existsSync(sdk)) await import("./vendor-sdk.mjs");
await Bun.write(resolve(root, "sessions/web/livekit-client.umd.js"), Bun.file(sdk));
