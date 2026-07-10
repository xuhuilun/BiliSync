import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const serverTarget =
  process.env.VITE_SERVER_HTTP_URL ?? "http://127.0.0.1:8787";

const protocolDir = fileURLToPath(
  new URL("../packages/protocol", import.meta.url),
);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@bili-syncplay/protocol": protocolDir,
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": serverTarget,
      "/healthz": serverTarget,
    },
  },
});
