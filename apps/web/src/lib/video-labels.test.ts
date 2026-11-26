import { describe, expect, it } from "vitest";
import { formatBytes, isActiveJob, jobErrorText } from "./video-labels";

describe("video labels", () => {
  it("explains known error codes in Uzbek and falls back to the safe server message", () => {
    expect(jobErrorText({ errorCode: "browser_missing", errorMessage: "x" })).toMatch(/setup-motion-browser\.sh/);
    expect(jobErrorText({ errorCode: "timeout", errorMessage: null })).toMatch(/Vaqt/);
    expect(jobErrorText({ errorCode: "render_failed", errorMessage: "boom" })).toBe("boom");
    expect(jobErrorText({ errorCode: null, errorMessage: null })).toBe("Noma'lum xato.");
  });
  it("formats sizes and detects active jobs", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(isActiveJob({ status: "queued" })).toBe(true);
    expect(isActiveJob({ status: "ready" })).toBe(false);
  });
});
