import { describe, expect, it, vi, beforeEach } from "vitest";
import { promptCapture, foregroundJobs } from "./promptCapture";

beforeEach(() => {
  vi.useFakeTimers();
  foregroundJobs.stopAll();
  promptCapture.cancel();
});

describe("type-ahead while a plugin's job runs", () => {
  it("holds a line until the plugin asks, then answers with it", () => {
    const done = foregroundJobs.add("games", () => {});
    expect(promptCapture.holdIfBusy("yes 5")).toBe(true);
    done();
    const onLine = vi.fn();
    promptCapture.set({ owner: "games", label: "dice", onLine });
    vi.runAllTimers();
    expect(onLine).toHaveBeenCalledWith("yes 5");
    expect(promptCapture.get()).toBeNull();
  });

  it("runs the line as typed when no question comes", () => {
    const run = vi.fn();
    promptCapture.onUnclaimed(run);
    const done = foregroundJobs.add("monitoring", () => {});
    promptCapture.holdIfBusy("git status");
    done();
    vi.advanceTimersByTime(399);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledWith("git status");
  });

  it("gives a held line only to the question of the plugin that was running", () => {
    const run = vi.fn();
    promptCapture.onUnclaimed(run);
    const done = foregroundJobs.add("games", () => {});
    promptCapture.holdIfBusy("no");
    const other = vi.fn();
    promptCapture.set({ owner: "quiz", label: "quiz", onLine: other });
    vi.runAllTimers();
    expect(other).not.toHaveBeenCalled();
    promptCapture.cancel();
    done();
    vi.runAllTimers();
  });

  it("holds nothing when no job runs", () => {
    expect(promptCapture.holdIfBusy("ls")).toBe(false);
  });

  it("throws held lines away on Ctrl+C", () => {
    const run = vi.fn();
    promptCapture.onUnclaimed(run);
    foregroundJobs.add("games", () => {});
    promptCapture.holdIfBusy("yes 5");
    foregroundJobs.stopAll();
    vi.runAllTimers();
    const onLine = vi.fn();
    promptCapture.set({ owner: "games", label: "dice", onLine });
    vi.runAllTimers();
    expect(run).not.toHaveBeenCalled();
    expect(onLine).not.toHaveBeenCalled();
  });
});
