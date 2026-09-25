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
          MovePath?: (src: string, dst: string) => Promise<void>;
          RunCommand?: (requestId: string, dir: string, name: string, args: string[]) => Promise<NativeRunCommandResult>;
          CancelCommand?: (requestId: string) => Promise<boolean>;
          SystemInfo?: () => Promise<NativeSystemInfo>;
          ListProcesses?: () => Promise<NativeProcessInfo[]>;
          KillProcess?: (pid: number) => Promise<void>;
          OpenURL?: (url: string) => Promise<void>;
          WriteClipboard?: (text: string) => Promise<void>;
          CheckForUpdate?: () => Promise<NativeUpdateInfo>;
          /** Builds a fresh binary FROM SOURCE (clones the repo, runs
           *  the real build script) and swaps it in, in Go — never a
           *  browser download link. fallbackBinaryUrl (from
           *  NativeUpdateInfo.rawBinaryUrl) is only ever used if the
           *  source build itself can't run (no git/node on this
           *  machine); still a plain in-process download, still no
           *  browser involved either way. See selfupdate.go's
           *  PerformUpdate doc comment for the full design. */
          PerformUpdate?: (fallbackBinaryUrl: string) => Promise<[boolean, string]>;
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
export interface NativeRunCommandResult { stdout: string; stderr: string; exitCode: number; }
export interface NativeSystemInfo { os: string; arch: string; numCPU: number; goVersion: string; allocMB: number; numGoroutine: number; }
export interface NativeProcessInfo { pid: number; name: string; }
export interface NativeUpdateInfo {
  /** true when the rolling release's recorded commit differs from
   *  this binary's own BuildCommit — see internal/update/update.go
   *  for the full "why commits, not semver tags" design. */
  available: boolean;
  currentCommit: string; latestCommit: string;
  releaseUrl: string;
  /** The platform's proper INSTALLER asset (.msi on Windows, .deb on
   *  Linux) — for a person to download and run themselves. NEVER pass
   *  this to performUpdate(); see rawBinaryUrl. */
  downloadUrl: string;
  /** The platform's bare, directly-executable binary (oxis.exe /
   *  oxis) — the only thing performUpdate() can safely rename over
   *  the running exe. Empty when this platform/build has no such
   *  asset yet, in which case 'update install has nothing to do and
   *  should point the user at downloadUrl/releaseUrl instead. */
  rawBinaryUrl: string;
  notes: string;
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

/** Moves/renames a file or directory — a real, atomic os.Rename on
 *  the Go side. Refuses if the destination already exists (see
 *  MovePath in app.go) rather than silently overwriting. Path safety
 *  (staying inside a connected project) is the CALLER's job — see
 *  safeJoinWithinDir in App.tsx — this is a thin wrapper. */
export async function movePath(src: string, dst: string): Promise<void> {
  const fn = window.go?.wailsapp?.App?.MovePath;
  if (!fn) throw new NativeUnavailableError();
  return fn(src, dst);
}

/** Runs a real external command (git, most commonly) and captures its
 *  output structurally — see RunCommand in internal/wailsapp/app.go
 *  for the full contract (argv-based, never shell-interpreted; a
 *  generous multi-minute timeout for real network operations like a
 *  git push, not just fast local ones; a non-zero exit is a normal
 *  result here, not a thrown error — only a genuine failure to start
 *  the command throws).
 *
 *  requestId is optional — pass one (any string unique to this
 *  specific call) if the caller might want to cancel it later via
 *  cancelCommand() below; omit it (undefined becomes "" on the Go
 *  side, which just means "don't bother registering this one for
 *  cancellation") for fire-and-wait calls nothing will ever try to
 *  interrupt. Generating a fresh ID per call, not a shared/reused one,
 *  is what lets cancelCommand target the exact in-flight call the
 *  caller means, even if something else also happens to be running a
 *  command concurrently. */
export async function runCommand(dir: string, name: string, args: string[], requestId?: string): Promise<NativeRunCommandResult> {
  const fn = window.go?.wailsapp?.App?.RunCommand;
  if (!fn) throw new NativeUnavailableError();
  return fn(requestId ?? "", dir, name, args);
}

/** Cancels an in-flight runCommand() call by the same requestId it
 *  was started with — real cancellation (the Go side kills the actual
 *  child process via context cancellation, not just "stop waiting for
 *  it" on this end), not a UI-only "give up on it". Returns false
 *  (not an error) if that call already finished on its own by the
 *  time this reaches the backend — nothing to cancel, not a failure. */
export async function cancelCommand(requestId: string): Promise<boolean> {
  const fn = window.go?.wailsapp?.App?.CancelCommand;
  if (!fn) return false;
  return fn(requestId);
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

/** Writes `text` to the real OS clipboard via a native, OS-level call
 *  (see clipboard_windows.go / clipboard_other.go) — native window
 *  only; throws NativeUnavailableError in browser mode, where
 *  App.tsx's copyToClipboard() already has the JS Clipboard API as
 *  its first attempt anyway. Exists specifically as the fallback for
 *  when navigator.clipboard.writeText() silently fails inside the
 *  WebView2-hosted page (a real, previously-unrecoverable failure —
 *  see the Go side's doc comment for the full story). */
export async function writeClipboard(text: string): Promise<void> {
  const fn = window.go?.wailsapp?.App?.WriteClipboard;
  if (!fn) throw new NativeUnavailableError();
  await fn(text);
}

/** Checks this project's GitHub repo for a newer BUILD (a different,
 *  more recent commit on the default branch — see internal/update/
 *  update.go for the full commit-based design) against this binary's
 *  own build commit. Native window only — in browser mode there's no
 *  running-binary version to compare against, so this just reports
 *  nothing available rather than throwing (unlike the other
 *  native-only calls above): a stray 'update in a browser tab
 *  shouldn't look like an error. */
export async function checkForUpdate(): Promise<NativeUpdateInfo> {
  const fn = window.go?.wailsapp?.App?.CheckForUpdate;
  if (!fn) return { available: false, currentCommit: "", latestCommit: "", releaseUrl: "", downloadUrl: "", rawBinaryUrl: "", notes: "" };
  return fn();
}

/** Actually installs a new build in place — clones this project's own
 *  source, builds it locally (the same thing `npm run build` does),
 *  backs up the running exe, replaces it, launches the new one,
 *  confirms it's still alive a moment later. Never opens a browser or
 *  hands the person a link; the whole thing happens here. fallbackUrl
 *  (pass checkForUpdate()'s rawBinaryUrl) is only used if the source
 *  build itself can't run on this machine (no git/node found) — still
 *  a plain in-process download when that happens, still no browser.
 *  See PerformUpdate in internal/wailsapp/selfupdate.go for the full
 *  design and every safety guarantee this makes (never a partial
 *  install, the previous version is only ever removed by the NEW
 *  process itself once its own startup is confirmed, any failure
 *  rolls back to the exact working state from before this was
 *  called).
 *
 *  Returns [true, ""] on success, having already launched the new
 *  process — the CALLER is responsible for quitting the current one
 *  afterward (see quitApp() below), since this function shouldn't
 *  unilaterally kill the app out from under whatever the caller still
 *  needs to do first (print a message, etc.). Returns [false, reason]
 *  on any failure, having left the current install completely
 *  untouched. Native app only — there's nothing to replace in browser
 *  mode. */
export async function performUpdate(fallbackUrl: string): Promise<[boolean, string]> {
  const fn = window.go?.wailsapp?.App?.PerformUpdate;
  if (!fn) return [false, "updating isn't available outside the native app"];
  return fn(fallbackUrl);
}

/** Quits the running app — the same real WindowClose binding the
 *  titlebar's own close button uses (see Titlebar.tsx), reused here
 *  specifically for performUpdate()'s own "hand off to the new
 *  process" step: once PerformUpdate has confirmed the new version is
 *  up and running, THIS process's job is done. */
export function quitApp(): void {
  window.go?.wailsapp?.App?.WindowClose?.();
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