import { createRequire } from "node:module";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Version, commit, tag and build number, shared with the Go binary's
// stamp (scripts/buildstamp.js); read in the page from src/buildInfo.ts.
const { stamp } = createRequire(import.meta.url)("../scripts/buildstamp.js");

// Note: OXIS's PTY only exists inside a running native window
// (internal/wailsapp mounts the Go handler as the Wails asset server —
// there's no standalone TCP listener to proxy to). `vite dev` here is
// useful for iterating on pure UI in isolation, but the terminal won't
// connect to a real shell outside the actual app. For an end-to-end
// dev loop use `npm run dev` from the project root (scripts/dev.js),
// which rebuilds and relaunches the real window on every change.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  define: {
    __OXIS_BUILD__: JSON.stringify({ ...stamp(), ...(command === "serve" ? { channel: "dev" } : {}) }),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
}));
