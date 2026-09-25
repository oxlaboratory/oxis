/**
 * diagnostics.ts — the recent-errors list behind 'diagnostics. Local
 * only; nothing is sent anywhere.
 *
 * Fed by recordError() (plugin failures, permission denials, command
 * errors) and by window error/unhandledrejection listeners
 * (installGlobalErrorCapture).
 */

export interface DiagnosticError {
  time: number;
  message: string;
  source: "app" | "uncaught";
}

const MAX_ERRORS = 30;
const errors: DiagnosticError[] = [];

export function recordError(message: string, source: DiagnosticError["source"] = "app"): void {
  errors.push({ time: Date.now(), message, source });
  if (errors.length > MAX_ERRORS) errors.shift();
}

export function getRecentErrors(): DiagnosticError[] {
  return [...errors];
}

export function clearRecentErrors(): void {
  errors.length = 0;
}

let installed = false;
/** Call once at startup. Safe to call more than once — only installs
 *  the listeners the first time. */
export function installGlobalErrorCapture(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (e) => {
    recordError(e.message || String(e.error ?? "unknown error"), "uncaught");
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    recordError(reason instanceof Error ? reason.message : String(reason), "uncaught");
  });
}