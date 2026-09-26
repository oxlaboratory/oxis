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
          ReadClipboard?: () => Promise<string>;
          CheckForUpdate?: () => Promise<NativeUpdateInfo>;
          /** Builds the latest source and swaps it in (see
           *  PerformUpdate in selfupdate.go); fallbackBinaryUrl is used
           *  only if building isn't possible. */
          PerformUpdate?: (fallbackBinaryUrl: string) => Promise<[boolean, string]>;
          WriteTempScript?: (ext: string, content: string) => Promise<string>;
          WindowGetSize?: () => Promise<NativeWindowSize>;
          WindowSetSize?: (width: number, height: number) => Promise<NativeWindowSize>;
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
export interface NativeRunCommandResult { stdout: string; stderr: string; exitCode: number; }
export interface NativeSystemInfo { os: string; arch: string; numCPU: number; goVersion: string; allocMB: number; numGoroutine: number; }
export interface NativeProcessInfo { pid: number; name: string; }
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
  /** Why the latest build couldn't be found (offline, rate limited). */
  error?: string;
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
export async function readClipboard(): Promise<string> {
  const fn = window.go?.wailsapp?.App?.ReadClipboard;
  if (!fn) throw new NativeUnavailableError();
  return fn();
}

/** Checks GitHub for a newer build (see internal/update). Reports
 *  nothing available in browser mode instead of throwing. */
export async function checkForUpdate(): Promise<NativeUpdateInfo> {
  const fn = window.go?.wailsapp?.App?.CheckForUpdate;
  if (!fn) return { available: false, currentCommit: "", latestCommit: "", releaseUrl: "", downloadUrl: "", rawBinaryUrl: "", notes: "" };
  return fn();
}

/** Installs a newer build in place (see PerformUpdate). Returns
 *  [true, ""] with the new process already running; the caller then
 *  quits this one. [false, reason] leaves the install untouched. */
export async function performUpdate(fallbackUrl: string): Promise<[boolean, string]> {
  const fn = window.go?.wailsapp?.App?.PerformUpdate;
  if (!fn) return [false, "updating isn't available outside the native app"];
  return fn(fallbackUrl);
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