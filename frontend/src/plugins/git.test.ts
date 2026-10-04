import { describe, expect, it } from "vitest";
import { normalizeRemoteUrl, parseGitRemote, samePath } from "./git";

describe("samePath", () => {
  it("matches git's top-level path to the project folder", () => {
    expect(samePath("C:/Users/me/dev/acme", "C:\\Users\\me\\dev\\acme")).toBe(true);
    expect(samePath("c:/users/me/dev/acme/", "C:\\Users\\Me\\dev\\acme")).toBe(true);
    expect(samePath("/home/me/acme", "/home/me/acme/")).toBe(true);
  });

  it("tells a nested folder from the repository around it", () => {
    expect(samePath("C:/Users/me/dev", "C:\\Users\\me\\dev\\acme")).toBe(false);
    expect(samePath("/home/me/Acme", "/home/me/acme")).toBe(false); // case matters off Windows
  });
});

describe("remotes", () => {
  it("turns owner/repo into a URL and back", () => {
    const url = normalizeRemoteUrl("github", "acme/web");
    expect(url).toBe("https://github.com/acme/web.git");
    expect(parseGitRemote(url)).toEqual({ provider: "github", repo: "acme/web" });
    expect(parseGitRemote("git@gitlab.com:team/site.git")).toEqual({ provider: "gitlab", repo: "team/site" });
  });
});
