import { describe, expect, it } from "vitest";
import { findSymbols } from "./symbols";

const names = (text: string, ext: string) => findSymbols(text, ext).map(s => `${s.kind}:${s.name}@${s.line}`);

describe("findSymbols", () => {
  it("finds TypeScript functions, classes, types and methods", () => {
    const ts = [
      "export interface Item { price: number }",
      "export type Id = string;",
      "export enum Mode { A }",
      "export const TAX = 0.2;",
      "export const total = (items: Item[]) => items.length;",
      "export async function load(id: Id) {",
      "  if (id) {",
      "  }",
      "}",
      "export class Cart {",
      "  add(item: Item) {",
      "  }",
      "  private async save(): Promise<void> {",
      "  }",
      "}",
    ].join("\n");
    expect(names(ts, "ts")).toEqual([
      "type:Item@1", "type:Id@2", "type:Mode@3", "const:TAX@4", "function:total@5",
      "function:load@6", "class:Cart@10", "method:add@11", "method:save@13",
    ]);
  });

  it("skips comments", () => {
    const ts = "// function nope() {\n/*\nfunction alsoNope() {\n*/\nfunction yes() {}";
    expect(names(ts, "ts")).toEqual(["function:yes@5"]);
  });

  it("tells Python methods from functions", () => {
    const py = "class Shop:\n    def buy(self):\n        pass\n\ndef main():\n    pass";
    expect(names(py, "py")).toEqual(["class:Shop@1", "method:buy@2", "function:main@5"]);
  });

  it("finds Go functions, methods and types", () => {
    const go = "type Server struct {\n}\nfunc (s *Server) Start() error {\n}\nfunc main() {\n}";
    expect(names(go, "go")).toEqual(["class:Server@1", "method:Start@3", "function:main@5"]);
  });

  it("lists Markdown headings outside code blocks, with their depth", () => {
    const md = "# Title\n```\n# not a heading\n```\n## Part ##";
    expect(findSymbols(md, "md")).toEqual([
      { name: "Title", kind: "heading", line: 1, col: 2, depth: 0 },
      { name: "Part", kind: "heading", line: 5, col: 3, depth: 1 },
    ]);
  });

  it("returns nothing for a language it doesn't know", () => {
    expect(findSymbols("function x() {}", "txt")).toEqual([]);
  });
});
