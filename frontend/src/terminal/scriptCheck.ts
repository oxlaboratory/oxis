/**
 * scriptCheck.ts — JS/TS syntax errors from Babel's parser (error
 * recovery on, so several are found at once). Used by the checker's
 * worker (scriptCheck.worker.ts), so a large file is parsed without
 * holding up typing, and directly where there are no workers.
 */

import type { Problem } from "./codeCheck";

export type BabelParse = typeof import("@babel/parser").parse;

/** The syntax errors in `t` (a file with extension `ext`); `base` is
 *  where the code starts in the file (a <script> block). */
export function babelProblems(parse: BabelParse, t: string, ext: string, base = 0): Problem[] {
  const ts = ext === "ts" || ext === "tsx" || ext === "mts" || ext === "cts";
  const jsx = ext !== "ts" && ext !== "mts" && ext !== "cts";
  const plugins: NonNullable<Parameters<BabelParse>[1]>["plugins"] = [];
  if (ts) plugins.push("typescript", "decorators-legacy");
  if (jsx) plugins.push("jsx");
  const problems: Problem[] = [];
  const add = (e: { pos?: number; loc?: { index?: number }; message?: string }) => {
    const pos = e.loc?.index ?? e.pos ?? 0;
    const word = /^[\w$]+/.exec(t.slice(pos, pos + 60))?.[0].length ?? 1;
    const message = String(e.message ?? "syntax error").replace(/\s*\(\d+:\d+\)\s*$/, "");
    problems.push({ from: base + pos, to: base + pos + Math.max(1, word), severity: "error", message: message.charAt(0).toLowerCase() + message.slice(1) });
  };
  try {
    const file = parse(t, {
      sourceType: ext === "mjs" || ext === "mts" ? "module" : "unambiguous",
      errorRecovery: true,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowUndeclaredExports: true,
      allowSuperOutsideMethod: true,
      allowNewTargetOutsideFunction: true,
      plugins,
    });
    for (const e of (file as unknown as { errors?: Array<{ pos?: number; loc?: { index?: number }; message?: string }> }).errors ?? []) add(e);
  } catch (e) {
    add(e as { pos?: number; loc?: { index?: number }; message?: string });
  }
  return problems;
}
