import { describe, expect, it } from "vitest";
import { keepOutOfHistory } from "./history";

describe("keepOutOfHistory", () => {
  it("keeps ordinary commands", () => {
    for (const line of ["git status", "'edit src/cart.ts", "npm test -- --watch", "echo $TOKEN_COUNT", "'config set theme ember"]) {
      expect(keepOutOfHistory(line), line).toBe(false);
    }
  });

  it("leaves out a line that starts with a space", () => {
    expect(keepOutOfHistory(" secret-thing")).toBe(true);
  });

  it("leaves out an OXIS command that sets a secret", () => {
    expect(keepOutOfHistory("'ai key sk-abc123")).toBe(true);
    expect(keepOutOfHistory("'deploy token ghp_x")).toBe(true);
  });

  it("leaves out shell assignments to secret-looking variables", () => {
    expect(keepOutOfHistory('$env:OPENAI_API_KEY = "sk-1234567890"')).toBe(true);
    expect(keepOutOfHistory("export GH_TOKEN=ghp_1234567890abcdef")).toBe(true);
    expect(keepOutOfHistory("DB_PASSWORD=hunter2hunter2 npm start")).toBe(true);
  });
});
