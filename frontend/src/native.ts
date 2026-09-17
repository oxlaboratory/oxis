/**
 * native.ts — typed wrappers around the Wails-bound Go methods on
 * window.go.wailsapp.App.*, used by the built-in editor for direct native
 * file I/O (no PTY round-trip — see internal/wailsapp/app.go), by the
 * PTY client to find its WebSocket port, and by plugin persistence to
 * read/write real .lua files on disk.
 *
 * OXIS runs in two different contexts now: the native Wails window,
 * and a plain browser pointed at http://127.0.0.1:1420 (see
 * server.Listen in internal/server/server.go) — everything in this
 * file that's Go-bound (native file I/O, plugin files, the PTY port
 * lookup) is naturally native-window-only, since a plain browser has
 * no window.go at all. isNativeApp() is how the rest of the frontend
 * (ptyClient's connection strategy, whether to render the custom
 * titlebar) tells the two apart.
 */

declare global {
  interface Window {
    go?: {
      wailsapp?: {
        App?: {
          ReadFile?: (path: string) => Promise<string>;
          WriteFile?: (path: string, content: string) => Promise<void>;
          AppDir?: () => Promise<string>;
          WindowMinimise?: () => void;
          WindowClose?: () => void;
          // No WindowStartDrag here (and none on the JS runtime side
          // either — verified against Wails v2's Go runtime package,
          // its JS runtime docs, and its internal Frontend interface;
          // it exists in none of them). Dragging is handled entirely
          // by the native `--wails-draggable` CSS mechanism instead —
          // see Titlebar.tsx and .wails-titlebar/.wails-drag in
          // index.css. No JS/Go call needed.
          GetPTYPort?: () => Promise<number>;
          ListPlugins?: () => Promise<string[]>;
          ReadPluginFile?: (name: string) => Promise<string>;
          WritePluginFile?: (name: string, source: string) => Promise<void>;
          DeletePluginFile?: (name: string) => Promise<void>;
          // Core System APIs — see README § Core System APIs and
          // internal/wailsapp/app.go. Backs oxis.fs.*/oxis.process.*/
          // oxis.system.* in pluginAPI.ts.
          ListDir?: (path: string) => Promise<NativeFileEntry[]>;
          StatPath?: (path: string) => Promise<NativeStatResult>;
          MakeDir?: (path: string) => Promise<void>;
          DeletePath?: (path: string) => Promise<void>;
          SystemInfo?: () => Promise<NativeSystemInfo>;
          ListProcesses?: () => Promise<NativeProcessInfo[]>;
          KillProcess?: (pid: number) => Promise<void>;
          OpenURL?: (url: string) => Promise<void>;
          CheckForUpdate?: () => Promise<NativeUpdateInfo>;
          WriteTempScript?: (ext: string, content: string) => Promise<string>;
        };
      };
    };
    // WebView2 (Windows) and WKWebView (macOS) both inject their own
    // host objects synchronously, before any page script runs — unlike
    // window.go (added by a script Wails injects, which can trail page
    // load by a tick). Checking for these is an immediate, reliable
    // "am I inside the native window" signal that doesn't need the
    // retry/poll dance getPtyPort() below needs.
    chrome?: { webview?: unknown };
    webkit?: { messageHandlers?: unknown };
  }
}

export class NativeUnavailableError extends Error {
  constructor() {
    super("native file access isn't available (window.go bindings missing)");
    this.name = "NativeUnavailableError";
  }
}

// ── Core System API types (mirror internal/wailsapp/app.go's Go structs) ──
export interface NativeFileEntry { name: string; isDir: boolean; size: number; modTime: number; }
export interface NativeStatResult { exists: boolean; isDir: boolean; size: number; modTime: number; }
export interface NativeSystemInfo { os: string; arch: string; numCPU: number; goVersion: string; allocMB: number; numGoroutine: number; }
export interface NativeProcessInfo { pid: number; name: string; }
export interface NativeUpdateInfo {
  available: boolean; current: string; latest: string;
  releaseUrl: string; downloadUrl: string; notes: string;
}

/** True if running inside the native Wails window; false in a plain
 *  browser tab (e.g. http://127.0.0.1:1420 opened directly). Synchronous
 *  — safe to call at render time, no race with window.go injection. */
export function isNativeApp(): boolean {
  if (typeof window === "undefined") return false;
  return !!(window.chrome?.webview || window.webkit?.messageHandlers);
}

/** Read a file's contents. Relative paths resolve against the app's own working directory — see ReadFile in internal/wailsapp/app.go. */
export async function readFile(path: string): Promise<string> {
  const fn = window.go?.wailsapp?.App?.ReadFile;
  if (!fn) throw new NativeUnavailableError();
  return fn(path);
}

/** Write a file's contents, creating parent directories as needed. */
export async function writeFile(path: string, content: string): Promise<void> {
  const fn = window.go?.wailsapp?.App?.WriteFile;
  if (!fn) throw new NativeUnavailableError();
  return fn(path, content);
}

/** The directory the running executable lives in (e.g. the "dist"
 *  folder the app was extracted/installed into) — see AppDirPath in
 *  internal/wailsapp/app.go. Every OXIS-managed folder (created
 *  documents, created plugins, workspaces) is built from this rather
 *  than a hardcoded or cached path, specifically so moving the whole
 *  install folder doesn't orphan any of it: each call re-resolves
 *  against wherever the executable currently is. Not cached here
 *  either, for the same reason — the cost of one extra native round
 *  trip is trivial next to correctness after a move. */
export async function appDir(): Promise<string> {
  const fn = window.go?.wailsapp?.App?.AppDir;
  if (!fn) throw new NativeUnavailableError();
  return fn();
}

/**
 * Resolve the PTY WebSocket's port (see GetPTYPort in
 * internal/wailsapp/app.go). Only meaningful inside the native window
 * — its origin (wherever Wails serves AssetServer.Assets from) isn't
 * the same as the local server's, so ptyClient can't just reuse
 * window.location.host the way it does in browser mode (see
 * ptyClient.ts's wsURL, which only calls this when isNativeApp() is
 * true). window.go is normally present within a few dozen ms of the
 * window opening, but this retries for several seconds rather than one
 * to give slower machines (or a debug build under a debugger) real
 * room, since failing here means the shell never connects for the
 * entire session — ptyClient.ts treats a failure from this function as
 * retryable rather than caching it forever.
 */
export async function getPtyPort(): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const fn = window.go?.wailsapp?.App?.GetPTYPort;
    if (fn) return fn();
    await new Promise(r => setTimeout(r, 50));
  }
  throw new NativeUnavailableError();
}

// ── Plugin file persistence (native window only) ──────────────────
// Real files in a "plugins/" folder next to the executable — see
// pluginsDir() in internal/wailsapp/app.go. Used by pluginManager.ts
// instead of localStorage, which is where these used to live (and
// which is why an installed or newly-created plugin was never
// actually findable as a file anywhere).

export async function listPluginFiles(): Promise<string[]> {
  const fn = window.go?.wailsapp?.App?.ListPlugins;
  if (!fn) throw new NativeUnavailableError();
  return fn();
}

export async function readPluginFile(name: string): Promise<string> {
  const fn = window.go?.wailsapp?.App?.ReadPluginFile;
  if (!fn) throw new NativeUnavailableError();
  return fn(name);
}

export async function writePluginFile(name: string, source: string): Promise<void> {
  const fn = window.go?.wailsapp?.App?.WritePluginFile;
  if (!fn) throw new NativeUnavailableError();
  return fn(name, source);
}

export async function deletePluginFile(name: string): Promise<void> {
  const fn = window.go?.wailsapp?.App?.DeletePluginFile;
  if (!fn) throw new NativeUnavailableError();
  return fn(name);
}

// ── Core System APIs (native window only) ──────────────────────
// Backs oxis.fs.*/oxis.process.*/oxis.system.* in pluginAPI.ts, and
// workspaceManager.ts's workspace-file detection. See
// internal/wailsapp/app.go for the Go side of each of these.

export async function listDir(path: string): Promise<NativeFileEntry[]> {
  const fn = window.go?.wailsapp?.App?.ListDir;
  if (!fn) throw new NativeUnavailableError();
  return fn(path);
}

export async function statPath(path: string): Promise<NativeStatResult> {
  const fn = window.go?.wailsapp?.App?.StatPath;
  if (!fn) throw new NativeUnavailableError();
  return fn(path);
}

export async function makeDir(path: string): Promise<void> {
  const fn = window.go?.wailsapp?.App?.MakeDir;
  if (!fn) throw new NativeUnavailableError();
  return fn(path);
}

export async function deletePath(path: string): Promise<void> {
  const fn = window.go?.wailsapp?.App?.DeletePath;
  if (!fn) throw new NativeUnavailableError();
  return fn(path);
}

export async function systemInfo(): Promise<NativeSystemInfo> {
  const fn = window.go?.wailsapp?.App?.SystemInfo;
  if (!fn) throw new NativeUnavailableError();
  return fn();
}

export async function listProcesses(): Promise<NativeProcessInfo[]> {
  const fn = window.go?.wailsapp?.App?.ListProcesses;
  if (!fn) throw new NativeUnavailableError();
  return fn();
}

export async function killProcess(pid: number): Promise<void> {
  const fn = window.go?.wailsapp?.App?.KillProcess;
  if (!fn) throw new NativeUnavailableError();
  return fn(pid);
}

/** Opens a URL in the user's real default system browser. Uses
 *  Wails' native BrowserOpenURL when running as the desktop app;
 *  falls back to a plain `window.open` new tab in browser mode (see
 *  isNativeApp() — this is one of the few native-only features that
 *  DOES have a reasonable browser-mode equivalent, unlike fs/process,
 *  since a browser tab can always open another browser tab). */
export async function openUrl(url: string): Promise<void> {
  const fn = window.go?.wailsapp?.App?.OpenURL;
  if (fn) { await fn(url); return; }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Checks gitlab.com/oxidelab/oxis's latest release against this
 *  build (see CheckForUpdate in internal/wailsapp/app.go). Native
 *  window only — in browser mode there's no running-binary version to
 *  compare against, so this just reports nothing available rather
 *  than throwing (unlike the other native-only calls above): a stray
 *  'update in a browser tab shouldn't look like an error. */
export async function checkForUpdate(): Promise<NativeUpdateInfo> {
  const fn = window.go?.wailsapp?.App?.CheckForUpdate;
  if (!fn) return { available: false, current: "", latest: "", releaseUrl: "", downloadUrl: "", notes: "" };
  return fn();
}

/** Writes content to a fresh file in the OS temp dir and returns its
 *  absolute path — see WriteTempScript in internal/wailsapp/app.go.
 *  Backs oxis.run()'s multi-line-script fix in pluginAPI.ts; not
 *  meant for general use (there's no matching read/delete wrapper —
 *  the caller cleans it up itself via a shell command, see there). */
export async function writeTempScript(ext: string, content: string): Promise<string> {
  const fn = window.go?.wailsapp?.App?.WriteTempScript;
  if (!fn) throw new NativeUnavailableError();
  return fn(ext, content);
}