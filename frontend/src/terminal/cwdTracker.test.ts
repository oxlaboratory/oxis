import { describe, expect, it, vi } from "vitest";

// The tracker loads workspaces when the directory changes; these tests
// only need the parsing.
vi.mock("./workspaceManager", () => ({ workspaceManager: { detectAndLoad: () => Promise.resolve() } }));

const { buildCwdProbe, cwdFromMark, isProbeLine, looksLikeDirectoryChange } = await import("./cwdTracker");

const MARK = "\u2063OXISCWD\u2063";

describe("buildCwdProbe", () => {
  it("never contains the whole marker, so the shell's echo isn't read as an answer", () => {
    for (const ps of [true, false]) for (const win of [true, false]) {
      const probe = buildCwdProbe(ps, win);
      expect(probe).not.toContain(MARK);
      expect(isProbeLine(probe)).toBe(true);
    }
  });

  it("asks cmd with echo, the marker split by an empty %CD:~0,0%", () => {
    const probe = buildCwdProbe(false, true, true);
    expect(probe.startsWith("echo ")).toBe(true);
    expect(probe).not.toContain(MARK);
    expect(probe.replace(/%CD:~0,0%/g, "")).toContain(MARK);
    expect(probe).toContain("%CD%");
  });

  it("reads WSL's /mnt/c/… as C:\\… on Windows", async () => {
    const { CwdTracker } = await import("./cwdTracker");
    vi.stubGlobal("navigator", { platform: "Win32" });
    const t = new CwdTracker();
    t.set("/mnt/c/Users/me/app");
    expect(t.get()).toBe("C:\\Users\\me\\app");
    vi.unstubAllGlobals();
  });

  it("asks Git Bash for the Windows path", () => {
    expect(buildCwdProbe(false, true)).toContain("pwd -W");
    expect(buildCwdProbe(false, false)).toContain('"$PWD"');
    expect(buildCwdProbe(true)).toContain("$PWD.Path");
  });
});

describe("looksLikeDirectoryChange", () => {
  it("spots commands that change directory", () => {
    for (const cmd of ["cd src", "  cd ..", "pushd /tmp", "popd", "Set-Location C:\\dev", "z proj"]) {
      expect(looksLikeDirectoryChange(cmd), cmd).toBe(true);
    }
    for (const cmd of ["cdk deploy", "echo cd", "git checkout main"]) {
      expect(looksLikeDirectoryChange(cmd), cmd).toBe(false);
    }
  });
});

describe("cwdFromMark", () => {
  it("reads OSC 7 file URLs", () => {
    expect(cwdFromMark("7;file://host/home/me/my%20app", false)).toBe("/home/me/my app");
    expect(cwdFromMark("7;file:///C:/Users/me", true)).toBe("C:\\Users\\me");
    expect(cwdFromMark("7;file://server/share/dir", true)).toBe("\\\\server\\share\\dir");
    // Git Bash: its /c/… paths are drives; its own folders aren't.
    expect(cwdFromMark("7;file://DESKTOP-1/c/Users/me/my%20app", true)).toBe("C:\\Users\\me\\my app");
    expect(cwdFromMark("7;file://DESKTOP-1/d", true)).toBe("D:\\");
    expect(cwdFromMark("7;file://DESKTOP-1/usr/bin", true)).toBeNull();
    expect(cwdFromMark("7;file://localhost/tmp", true)).toBeNull(); // an MSYS folder, no Windows path
  });

  it("reads Windows Terminal's OSC 9;9", () => {
    expect(cwdFromMark('9;9;"C:\\dev\\acme"', true)).toBe("C:\\dev\\acme");
  });

  it("ignores other marks", () => {
    expect(cwdFromMark("133;A", false)).toBeNull();
    expect(cwdFromMark("9;9;", true)).toBeNull();
  });
});
