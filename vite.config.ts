import { defineConfig } from "vite";

// Project Pages site: https://<owner>.github.io/crypto-orderflow/
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/crypto-orderflow/" : "/",
  build: {
    target: "es2022",
    sourcemap: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
}));
