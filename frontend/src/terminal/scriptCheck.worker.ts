/// <reference lib="webworker" />
/**
 * scriptCheck.worker.ts — parses JS/TS for the editor's checker off the
 * main thread (see scriptCheck.ts). Message in: { id, text, ext, base };
 * out: { id, problems }.
 */

import { parse } from "@babel/parser";
import { babelProblems } from "./scriptCheck";

self.onmessage = (e: MessageEvent<{ id: number; text: string; ext: string; base: number }>) => {
  const { id, text, ext, base } = e.data;
  let problems: ReturnType<typeof babelProblems> = [];
  try { problems = babelProblems(parse, text, ext, base); } catch { /* a parser crash is no problem to report */ }
  (self as unknown as Worker).postMessage({ id, problems });
};
