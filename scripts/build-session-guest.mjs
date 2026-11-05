import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const result = await Bun.build({ entrypoints: [resolve(root,"frontend/src/SessionGuest.tsx")], target: "browser", minify: true, define: {"process.env.NODE_ENV": '"production"'}, outdir: resolve(root,"sessions/web"), naming: "guest.js" });
if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1); }
