import { createRequire } from "node:module";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Version, commit, tag and build number, shared with the Go binary's
// stamp (scripts/buildstamp.js); read in the page from src/buildInfo.ts.
const { stamp } = createRequire(import.meta.url)("../scripts/buildstamp.js");

// `npm run dev` (scripts/dev.js) serves this through the real OXIS
// window: Wails proxies the page from here, so edits reload in place
// while the shells keep running. Wails' proxy can't carry WebSockets,
// so the hot-reload socket goes straight to Vite.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  define: {
    __OXIS_BUILD__: JSON.stringify({ ...stamp(), ...(command === "serve" ? { channel: "dev" } : {}) }),
  },
  // fengari reads process.env.FENGARICONF; a build replaces process.env
  // with {}, the dev server's pre-bundling has to be told to.
  optimizeDeps: {
    esbuildOptions: { define: { "process.env": "{}" } },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    hmr: { host: "localhost", port: 5173, protocol: "ws" },
  },
}));
