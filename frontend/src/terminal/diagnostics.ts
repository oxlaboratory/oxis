/**
 * diagnostics.ts — recent-errors ring buffer backing 'diagnostics.
 *
 * Purely local, in-memory, never transmitted anywhere — 'diagnostics
 * exists to show YOU what's going on, not to phone home. There's no
 * telemetry in OXIS at all; this file doesn't add any.
 *
 * Two sources feed the same buffer:
 *  - recordError() — called explicitly from the few places that
 *    already produce a real, actionable error message (plugin load
 *    failures, permission denials — see pluginManager.ts), so
 *    'diagnostics shows the SAME text you'd have already seen printed
 *    to the terminal, not a paraphrase of it.
 *  - a window "error"/"unhandledrejection" listener (installed once,
 *    see installGlobalErrorCapture below), which catches genuinely
 *    uncaught JS exceptions — the ones that would otherwise only ever
 *    show up in the browser devtools console, invisible to a user who
 *    doesn't have that open.
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