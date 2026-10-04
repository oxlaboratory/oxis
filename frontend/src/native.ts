/**
 * native.ts — typed wrappers for the Go methods bound on
 * window.go.wailsapp.App (files, plugins, git, processes, window, update).
 *
 * They only exist in the native window. In a browser tab at
 * http://127.0.0.1:1420 most throw NativeUnavailableError;
 * isNativeApp() tells the two apart.
 */

declare global {
  interface Window {
    go?: {
      wailsapp?: {
        App?: {
          ReadFile?: (path: string) => Promise<string>;
          WriteFile?: (path: string, content: string) => Promise<void>;
          AppDir?: () => Promise<string>;
          UserConfigDir?: () => Promise<string>;
          WindowMinimise?: () => void;
          WindowClose?: () => void;
          // No drag method: dragging uses the --wails-draggable CSS
          // property (Titlebar.tsx).
          GetPTYPort?: () => Promise<number>;
          ListPlugins?: () => Promise<string[]>;
          ReadPluginFile?: (name: string) => Promise<string>;
          WritePluginFile?: (name: string, source: string) => Promise<void>;
          DeletePluginFile?: (name: string) => Promise<void>;
          // Core System APIs — see README § Core System APIs and
          // internal/wailsapp/app.go. Backs oxis.fs.*/oxis.process.*/
          // oxis.system.* in pluginAPI.ts.
          ListDir?: (path: string) => Promise<NativeFileEntry[]>;
          SearchFiles?: (root: string, query: string, opts: NativeSearchOptions) => Promise<NativeSearchResult>;
          StatPath?: (path: string) => Promise<NativeStatResult>;
          MakeDir?: (path: string) => Promise<void>;
          DeletePath?: (path: string) => Promise<void>;
          TrashPath?: (path: string) => Promise<void>;
          CopyPath?: (src: string, dst: string) => Promise<void>;
          MovePath?: (src: string, dst: string) => Promise<void>;
          RunCommand?: (requestId: string, dir: string, name: string, args: string[]) => Promise<NativeRunCommandResult>;
          CancelCommand?: (requestId: string) => Promise<boolean>;
          SystemInfo?: () => Promise<NativeSystemInfo>;
          ListProcesses?: () => Promise<NativeProcessInfo[]>;
          KillProcess?: (pid: number) => Promise<void>;
          OpenURL?: (url: string) => Promise<void>;
          WriteClipboard?: (text: string) => Promise<void>;
          FlashWindow?: () => Promise<boolean>;
          Shells?: () => Promise<{ name: string; label: string; path: string }[]>;
          ReadClipboard?: () => Promise<string>;
          CheckForUpdate?: () => Promise<NativeUpdateInfo>;
          /** Builds the latest source and swaps it in (see
           *  PerformUpdate in selfupdate.go); fallbackBinaryUrl is used
           *  only if building isn't possible. */
          PerformUpdate?: (fallbackBinaryUrl: string) => Promise<NativeUpdateResult>;
          WriteTempScript?: (ext: string, content: string) => Promise<string>;
          HTTPRequest?: (opts: NativeHTTPRequest) => Promise<NativeHTTPResponse>;
          PreviewURL?: (servePath: string, content: string) => Promise<string>;
          WindowGetSize?: () => Promise<NativeWindowSize>;
          // Streams (streams.go): spawned processes, file watching and
          // streamed HTTP, delivered through one long poll.
          StreamsReset?: () => Promise<number>;
          PollStreams?: (session: number, waitMs: number) => Promise<NativeStreamEvent[] | null>;
          StreamClose?: (id: string) => Promise<boolean>;
          ProcessStart?: (id: string, opts: NativeProcessOptions) => Promise<number>;
          ProcessWrite?: (id: string, data: string) => Promise<void>;
          ProcessCloseInput?: (id: string) => Promise<void>;
          WatchStart?: (id: string, opts: NativeWatchOptions) => Promise<void>;
          HTTPStreamStart?: (id: string, opts: NativeHTTPRequest) => Promise<void>;
          WindowSetSize?: (width: number, height: number) => Promise<NativeWindowSize>;
          ReadImage?: (path: string) => Promise<string>;
        };
      };
    };
    // Host objects WebView2/WKWebView inject before any page script,
    // unlike window.go, which can arrive a tick later.
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
/** Mirrors internal/wailsapp/search.go. */
export interface NativeSearchOptions { caseSensitive: boolean; wholeWord: boolean; regex: boolean; maxResults?: number; }
/** col and len are in the line (UTF-16, as JS counts); at is len's start in text. */
export interface NativeSearchMatch { path: string; line: number; col: number; len: number; text: string; at: number; }
export interface NativeSearchResult { matches: NativeSearchMatch[]; files: number; truncated: boolean; superseded: boolean; error?: string; }
export interface NativeRunCommandResult { stdout: string; stderr: string; exitCode: number; }
/** osName is readable, e.g. "Windows 11 24H2 (build 26100)". */
export interface NativeDiskInfo { mount: string; totalGB: number; freeGB: number; }
export interface NativeSystemInfo {
  os: string; osName: string; arch: string; numCPU: number; goVersion: string; allocMB: number; numGoroutine: number;
  /** The machine right now (internal/wailsapp/sysstats*.go). */
  hostname?: string; memTotalMB?: number; memUsedMB?: number; cpuPercent?: number; uptimeSec?: number;
  load?: number[]; disks?: NativeDiskInfo[];
}
/** cpu is -1 where it isn't known (Windows). */
export interface NativeProcessInfo { pid: number; name: string; memMB?: number; cpu?: number; }
/** Mirrors WindowResult in internal/wailsapp/window.go. */
export interface NativeWindowSize { width: number; height: number; configPath: string; persisted: boolean; }
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
  /** Bare executable (oxis.exe / oxis) that performUpdate() can swap
   *  in; empty when the release has none for this platform. */
  rawBinaryUrl: string;
  notes: string;
  /** Commits main has that this build doesn't, and the reverse (local
   *  work); -1 when GitHub couldn't say. */
  behind: number;
  ahead: number;
  /** GitHub doesn't have this build's commit (local work); the build
   *  only counts as outdated when it was committed before main's tip. */
  unpushed?: boolean;
  /** Why the latest build couldn't be found (offline, rate limited). */
  error?: string;
}
/** Mirror HTTPRequestOptions / HTTPResponse in internal/wailsapp/httprequest.go. */
export interface NativeHTTPRequest { url: string; method: string; headers: Record<string, string>; body: string; timeoutSeconds: number; idleSeconds?: number; }
export interface NativeHTTPResponse { status: number; ok: boolean; body: string; headers: Record<string, string>; /** how long it took */ ms?: number; }
/** Mirrors StreamEvent in internal/wailsapp/streams.go: "stdout",
 *  "stderr", "change", "response", "data", "error", and a final "end". */
export interface NativeStreamEvent {
  id: string; type: string; data?: string; code: number;
  path?: string; op?: string; headers?: Record<string, string>; error?: string;
}
/** Mirrors ProcessOptions in internal/wailsapp/process.go. */
export interface NativeProcessOptions { cmd: string; args: string[]; shell: string; cwd: string; env: Record<string, string>; }
/** Mirrors WatchOptions in internal/wailsapp/watch.go. */
export interface NativeWatchOptions { path: string; recursive: boolean; ignore: string[] | null; debounceMs: number; }
/** Mirrors UpdateResult in internal/wailsapp/selfupdate.go. */
export interface NativeUpdateResult { installed: boolean; error: string; /** "source" (built here) or "release" (the prebuilt download). */ from?: "source" | "release" | ""; }

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

/** Image files the editor shows as pictures (see ReadImage in app.go). */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"];

export function isImagePath(path: string): boolean {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return !!ext && IMAGE_EXTENSIONS.includes(ext);
}

/** An image file as a data: URL, for the editor's image viewer. */
export async function readImage(path: string): Promise<string> {
  const fn = window.go?.wailsapp?.App?.ReadImage;
  if (!fn) throw new NativeUnavailableError();
  return fn(path);
}

/** Write a file's contents, creating parent directories as needed. */
export async function writeFile(path: string, content: string): Promise<void> {
  const fn = window.go?.wailsapp?.App?.WriteFile;
  if (!fn) throw new NativeUnavailableError();
  return fn(path, content);
}

/** The folder OXIS keeps its data in (AppDirPath in app.go). Not
 *  cached, so moving a portable install keeps working. */
export async function appDir(): Promise<string> {
  const fn = window.go?.wailsapp?.App?.AppDir;
  if (!fn) throw new NativeUnavailableError();
  return fn();
}

/** ~/.oxis — config.lua and user themes (see userConfig.ts). */
export async function userConfigDir(): Promise<string> {
  const fn = window.go?.wailsapp?.App?.UserConfigDir;
  if (!fn) throw new NativeUnavailableError();
  return fn();
}

/**
 * The PTY server's port (native window only; a browser tab uses its own
 * origin). window.go can take a moment to appear, so this retries for
 * several seconds; ptyClient treats a failure as retryable.
 */
export async function getPtyPort(): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const fn = window.go?.wailsapp?.App?.GetPTYPort;
    if (fn) return fn();
    await new Promise(r => setTimeout(r, 50));
  }
  throw new NativeUnavailableError();
}

// ── Plugin files (native window only) — plugins/ in the data folder ──

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

/** Every line under `root` matching `query` (the editor's search in
 *  files). A search still running when another starts stops early. */
export async function searchFiles(root: string, query: string, opts: NativeSearchOptions): Promise<NativeSearchResult> {
  const fn = window.go?.wailsapp?.App?.SearchFiles;
  if (!fn) throw new NativeUnavailableError();
  return fn(root, query, opts);
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

/** Moves a file or folder to the Recycle Bin (the Trash on macOS and
 *  Linux), where it can be restored from. */
export async function trashPath(path: string): Promise<void> {
  const fn = window.go?.wailsapp?.App?.TrashPath;
  if (!fn) throw new NativeUnavailableError();
  return fn(path);
}

/** Copies a file, or a folder and everything in it; refuses to
 *  overwrite or to copy a folder into itself. */
export async function copyPath(src: string, dst: string): Promise<void> {
  const fn = window.go?.wailsapp?.App?.CopyPath;
  if (!fn) throw new NativeUnavailableError();
  return fn(src, dst);
}

/** Renames a file or folder; refuses to overwrite. Callers keep paths
 *  inside the project (safeJoinWithinDir). */
export async function movePath(src: string, dst: string): Promise<void> {
  const fn = window.go?.wailsapp?.App?.MovePath;
  if (!fn) throw new NativeUnavailableError();
  return fn(src, dst);
}

/** Runs an external command (argv, never a shell string) and captures
 *  its output. A non-zero exit is a normal result; only failing to start
 *  throws. Pass a unique requestId to be able to cancel it. */
export async function runCommand(dir: string, name: string, args: string[], requestId?: string): Promise<NativeRunCommandResult> {
  const fn = window.go?.wailsapp?.App?.RunCommand;
  if (!fn) throw new NativeUnavailableError();
  return fn(requestId ?? "", dir, name, args);
}

/** Kills the process started by runCommand() with this requestId.
 *  false if it had already finished. */
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

/** Opens a URL in the default browser (a new tab in browser mode). */
export async function openUrl(url: string): Promise<void> {
  const fn = window.go?.wailsapp?.App?.OpenURL;
  if (fn) { await fn(url); return; }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Writes to the OS clipboard natively; the fallback when
 *  navigator.clipboard is rejected in the WebView. */
export async function writeClipboard(text: string): Promise<void> {
  const fn = window.go?.wailsapp?.App?.WriteClipboard;
  if (!fn) throw new NativeUnavailableError();
  await fn(text);
}

/** Reads the OS clipboard's text natively. */
/** Flashes OXIS's taskbar button until it's in front again (Windows);
 *  false when it couldn't or OXIS is in front already. */
export async function flashWindow(): Promise<boolean> {
  const fn = window.go?.wailsapp?.App?.FlashWindow;
  return fn ? fn() : false;
}

/** The shells a tab can start here, by name; the default first. */
export interface NativeShell { name: string; label: string; path: string }
export async function listShells(): Promise<NativeShell[]> {
  const fn = window.go?.wailsapp?.App?.Shells;
  return fn ? fn() : [];
}

export async function readClipboard(): Promise<string> {
  const fn = window.go?.wailsapp?.App?.ReadClipboard;
  if (!fn) throw new NativeUnavailableError();
  return fn();
}

/** Checks GitHub for a newer build (see internal/update). Reports
 *  nothing available in browser mode instead of throwing. */
export async function checkForUpdate(): Promise<NativeUpdateInfo> {
  const fn = window.go?.wailsapp?.App?.CheckForUpdate;
  if (!fn) return { available: false, currentCommit: "", latestCommit: "", releaseUrl: "", downloadUrl: "", rawBinaryUrl: "", notes: "", behind: -1, ahead: -1 };
  return fn();
}

/** Installs a newer build in place (see PerformUpdate). installed:
 *  the new process is already running and the caller quits this one;
 *  otherwise error says why and the install is untouched. */
export async function performUpdate(fallbackUrl: string): Promise<NativeUpdateResult> {
  const fn = window.go?.wailsapp?.App?.PerformUpdate;
  if (!fn) return { installed: false, error: "updating isn't available outside the native app" };
  return fn(fallbackUrl);
}

/** An HTTP request made by OXIS itself rather than the page, so CORS
 *  doesn't apply (see HTTPRequest). Null when not in the native app. */
export async function nativeHttpRequest(opts: NativeHTTPRequest): Promise<NativeHTTPResponse | null> {
  const fn = window.go?.wailsapp?.App?.HTTPRequest;
  return fn ? fn(opts) : null;
}

/** A URL that shows `content` as the file at servePath, with that
 *  file's folder served around it (see preview.go). Null outside the
 *  native app. */
export async function previewUrl(servePath: string, content: string): Promise<string | null> {
  const fn = window.go?.wailsapp?.App?.PreviewURL;
  return fn ? fn(servePath, content) : null;
}

// ── Streams (see plugins/streams.ts for the poll loop) ──

/** Closes every stream and starts a new poll session. */
export async function streamsReset(): Promise<number> {
  const fn = window.go?.wailsapp?.App?.StreamsReset;
  if (!fn) throw new NativeUnavailableError();
  return fn();
}

export async function pollStreams(session: number, waitMs: number): Promise<NativeStreamEvent[]> {
  const fn = window.go?.wailsapp?.App?.PollStreams;
  if (!fn) throw new NativeUnavailableError();
  return (await fn(session, waitMs)) ?? [];
}

/** Stops a stream; its "end" event still arrives. */
export async function streamClose(id: string): Promise<boolean> {
  const fn = window.go?.wailsapp?.App?.StreamClose;
  return fn ? fn(id) : false;
}

/** Starts a process whose output streams back; resolves with its pid. */
export async function processStart(id: string, opts: NativeProcessOptions): Promise<number> {
  const fn = window.go?.wailsapp?.App?.ProcessStart;
  if (!fn) throw new NativeUnavailableError();
  return fn(id, opts);
}

export async function processWrite(id: string, data: string): Promise<void> {
  const fn = window.go?.wailsapp?.App?.ProcessWrite;
  if (!fn) throw new NativeUnavailableError();
  return fn(id, data);
}

export async function processCloseInput(id: string): Promise<void> {
  const fn = window.go?.wailsapp?.App?.ProcessCloseInput;
  if (!fn) throw new NativeUnavailableError();
  return fn(id);
}

export async function watchStart(id: string, opts: NativeWatchOptions): Promise<void> {
  const fn = window.go?.wailsapp?.App?.WatchStart;
  if (!fn) throw new NativeUnavailableError();
  return fn(id, opts);
}

/** A streamed HTTP request made by OXIS itself (no CORS). */
export async function httpStreamStart(id: string, opts: NativeHTTPRequest): Promise<void> {
  const fn = window.go?.wailsapp?.App?.HTTPStreamStart;
  if (!fn) throw new NativeUnavailableError();
  return fn(id, opts);
}

/** Quits the app (also used to hand over to an updated build). */
export function quitApp(): void {
  window.go?.wailsapp?.App?.WindowClose?.();
}

/** Writes content to a new temp file and returns its path; used by
 *  oxis.run() for multi-line scripts, which delete it afterwards. */
export async function writeTempScript(ext: string, content: string): Promise<string> {
  const fn = window.go?.wailsapp?.App?.WriteTempScript;
  if (!fn) throw new NativeUnavailableError();
  return fn(ext, content);
}

/** Live size of the native window, plus where 'oxis resize saves it. */
export async function windowGetSize(): Promise<NativeWindowSize> {
  const fn = window.go?.wailsapp?.App?.WindowGetSize;
  if (!fn) throw new NativeUnavailableError();
  return fn();
}

/** Resizes the native window and saves the size for the next launch.
 *  Resolves with the size the OS actually applied. */
export async function windowSetSize(width: number, height: number): Promise<NativeWindowSize> {
  const fn = window.go?.wailsapp?.App?.WindowSetSize;
  if (!fn) throw new NativeUnavailableError();
  return fn(width, height);
}