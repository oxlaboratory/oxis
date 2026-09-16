import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Note: OXIS's PTY only exists inside a running native window
// (internal/wailsapp mounts the Go handler as the Wails asset server —
// there's no standalone TCP listener to proxy to). `vite dev` here is
// useful for iterating on pure UI in isolation, but the terminal won't
// connect to a real shell outside the actual app. For an end-to-end
// dev loop use `npm run dev` from the project root (scripts/dev.js),
// which rebuilds and relaunches the real window on every change.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
});
