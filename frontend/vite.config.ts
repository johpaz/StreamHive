import { defineConfig } from "vite";
const target = process.env.STREAMHIVE_API_TARGET || "http://127.0.0.1:8080";
export default defineConfig({
  server: {
    proxy: {
      "/api": { target, ws: true },
      "/healthz": target,
    },
  },
  build: { target: "es2022" },
});
