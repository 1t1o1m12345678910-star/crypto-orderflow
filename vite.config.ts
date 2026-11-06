import { defineConfig } from "vite";

// Project Pages site: https://<owner>.github.io/crypto-orderflow/
// `vite preview` reuses the built HTML, so it must use the same base as `vite build`.
const pagesBase = process.argv.includes("preview");
export default defineConfig(({ command }) => ({
  base: command === "build" || pagesBase ? "/crypto-orderflow/" : "/",
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
