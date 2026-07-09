import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const serverTarget =
  process.env.VITE_SERVER_HTTP_URL ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": serverTarget,
      "/healthz": serverTarget,
    },
  },
});
