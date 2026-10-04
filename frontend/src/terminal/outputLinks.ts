/**
 * outputLinks.ts — what's clickable in terminal output: URLs, and file
 * paths the way compilers, linters and test runners print them, with
 * the line and column when they give one:
 *
 *   src/app.ts:12:5   ./main.go:40   C:\dev\api\index.js:7
 *   src/app.ts(12,5)  (tsc)          /home/me/app.py, line 3 (Python)
 *
 * A relative path counts only with a file extension that code uses, so
 * "example.com" and "v1.2.3" stay plain text. Paths are opened relative
 * to the shell's folder when clicked.
 */

export interface OutputLink {
  start: number;
  end: number;
  url?: string;
  path?: string;
  line?: number;
  col?: number;
}

const CODE_EXT = new Set((
  "ts tsx mts cts js jsx mjs cjs json jsonc go rs py pyi rb java kt kts scala c h cc cpp cxx hpp hh cs fs vb php swift m mm " +
  "lua dart ex exs erl hs ml clj zig nim jl r sql sh bash zsh fish ps1 psm1 bat cmd md mdx rst txt log csv yml yaml toml ini " +
  "cfg conf env xml html htm css scss sass less vue svelte astro graphql gql proto tf hcl gradle lock dockerfile mk cmake"
).split(" "));

const URL_RE = /https?:\/\/[^\s"'<>()]+[^\s"'<>().,;:!?]/y;
// A path: an optional drive or ./ ../ ~/ start, then names joined by
// slashes, ending in a name with an extension.
const PATH_RE = /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/]|[\\/])?(?:[\w@.+-]+[\\/])*[\w@+-][\w@.+-]*\.([A-Za-z][A-Za-z0-9]{0,9})/y;
// Where in the file: :12  :12:5  (12,5)  (12)  , line 12
const POS_RE = /:(\d+)(?::(\d+))?|\((\d+)(?:,(\d+))?\)|", line (\d+)/y;

export function findLinks(text: string): OutputLink[] {
  const links: OutputLink[] = [];
  let i = 0;
  while (i < text.length) {
    // Links start a word (or follow a quote, bracket, = or :).
    if (i > 0 && !/[\s"'(=:[<]/.test(text[i - 1])) { i++; continue; }
    URL_RE.lastIndex = i;
    const u = URL_RE.exec(text);
    if (u) { links.push({ start: i, end: URL_RE.lastIndex, url: u[0] }); i = URL_RE.lastIndex; continue; }
    PATH_RE.lastIndex = i;
    const p = PATH_RE.exec(text);
    if (p) {
      const path = p[0];
      let end = PATH_RE.lastIndex;
      const absolute = /^([A-Za-z]:[\\/]|[\\/]|~[\\/])/.test(path);
      // The match must end the word (so "a.b.c" doesn't link "a.b").
      const next = text[end] ?? "";
      const known = CODE_EXT.has(p[1].toLowerCase());
      if ((known || absolute) && !/[\w\\/]/.test(next) && !/^[\\/]{2}/.test(path)) {
        const link: OutputLink = { start: i, end, path };
        POS_RE.lastIndex = end;
        const pos = POS_RE.exec(text);
        if (pos && (pos[1] || pos[3] || pos[5])) {
          link.line = Number(pos[1] ?? pos[3] ?? pos[5]);
          const col = pos[2] ?? pos[4];
          if (col) link.col = Number(col);
          end = POS_RE.lastIndex;
          link.end = end;
        }
        links.push(link);
        i = end;
        continue;
      }
      i = end;
      continue;
    }
    i++;
  }
  return links;
}

/** A clicked path as a file to open: relative ones from `cwd`, Git Bash's
 *  /c/… as C:\…, ~ from `home`. */
export function resolveLinkPath(path: string, cwd: string, windows: boolean, home = ""): string {
  if (windows && /^\/[A-Za-z]\//.test(path)) return `${path[1].toUpperCase()}:${path.slice(2)}`;
  if (/^~[\\/]/.test(path)) return home ? home.replace(/[\\/]+$/, "") + path.slice(1) : path;
  if (/^([A-Za-z]:[\\/]|[\\/])/.test(path) || !cwd) return path;
  const sep = windows && !cwd.includes("/") ? "\\" : "/";
  return cwd.replace(/[\\/]+$/, "") + sep + path.replace(/^\.[\\/]/, "").replace(/[\\/]/g, sep);
}
