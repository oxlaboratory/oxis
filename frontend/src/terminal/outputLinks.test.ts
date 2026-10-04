import { describe, expect, it } from "vitest";
import { findLinks, resolveLinkPath } from "./outputLinks";

const links = (t: string) => findLinks(t).map(l => ({ text: t.slice(l.start, l.end), ...(l.url ? { url: l.url } : { path: l.path, line: l.line, col: l.col }) }));

describe("links in output", () => {
  it("URLs, without trailing punctuation", () => {
    expect(links("ready on http://localhost:5173/, press h")).toEqual([{ text: "http://localhost:5173/", url: "http://localhost:5173/" }]);
    expect(links("see https://oxis.space.")).toEqual([{ text: "https://oxis.space", url: "https://oxis.space" }]);
  });

  it("compiler and linter positions", () => {
    expect(links("src/app.ts:12:5 - error TS2304")).toEqual([{ text: "src/app.ts:12:5", path: "src/app.ts", line: 12, col: 5 }]);
    expect(links("src/app.ts(12,5): error TS2304")).toEqual([{ text: "src/app.ts(12,5)", path: "src/app.ts", line: 12, col: 5 }]);
    expect(links("./main.go:40: undefined: x")).toEqual([{ text: "./main.go:40", path: "./main.go", line: 40, col: undefined }]);
    expect(links('  File "/home/me/app.py", line 3, in <module>')).toEqual([{ text: '/home/me/app.py", line 3', path: "/home/me/app.py", line: 3, col: undefined }]);
    expect(links("   --> src\\lib.rs:7:9")).toEqual([{ text: "src\\lib.rs:7:9", path: "src\\lib.rs", line: 7, col: 9 }]);
    expect(links("C:\\dev\\api\\index.js:7")).toEqual([{ text: "C:\\dev\\api\\index.js:7", path: "C:\\dev\\api\\index.js", line: 7, col: undefined }]);
  });

  it("plain file names with code extensions", () => {
    expect(links("modified:   package.json")).toEqual([{ text: "package.json", path: "package.json", line: undefined, col: undefined }]);
    expect(links(" M frontend/src/App.tsx")).toEqual([{ text: "frontend/src/App.tsx", path: "frontend/src/App.tsx", line: undefined, col: undefined }]);
  });

  it("leaves versions, domains, numbers and words alone", () => {
    for (const t of ["v1.2.1 released", "visit example.com today", "took 1.5s", "e.g. this", "3.14", "a.b.c.d"]) {
      expect(links(t), t).toEqual([]);
    }
  });

  it("absolute paths with any extension, not network paths", () => {
    expect(links("wrote /tmp/out.bin")).toEqual([{ text: "/tmp/out.bin", path: "/tmp/out.bin", line: undefined, col: undefined }]);
    expect(links("\\\\server\\share\\a.ts")).toEqual([]);
  });
});

describe("opening a clicked path", () => {
  it("relative to the shell's folder", () => {
    expect(resolveLinkPath("src/app.ts", "C:\\proj", true)).toBe("C:\\proj\\src\\app.ts");
    expect(resolveLinkPath("./main.go", "/home/me/api", false)).toBe("/home/me/api/main.go");
    expect(resolveLinkPath("/c/Users/me/a.ts", "C:\\proj", true)).toBe("C:/Users/me/a.ts");
    expect(resolveLinkPath("C:\\x\\a.ts", "C:\\proj", true)).toBe("C:\\x\\a.ts");
    expect(resolveLinkPath("~/notes.md", "/x", false, "/home/me")).toBe("/home/me/notes.md");
  });
});
