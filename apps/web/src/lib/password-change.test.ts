import { describe, expect, it } from "vitest";
import {
  NEW_PASSWORD_MAX,
  NEW_PASSWORD_MIN,
  SERVER_PASSWORD_MAX,
  SERVER_PASSWORD_MIN,
  describeChangePasswordFailure,
  formatWait,
  parseRetryAfter,
  validatePasswordChange,
} from "./password-change";

const ok = { currentPassword: "eski-parol-1", newPassword: "yangi-parol-12345", confirmPassword: "yangi-parol-12345" };

describe("limits", () => {
  it("form minimum is never weaker than the server's and at least 12", () => {
    expect(NEW_PASSWORD_MIN).toBeGreaterThanOrEqual(SERVER_PASSWORD_MIN);
    expect(NEW_PASSWORD_MIN).toBeGreaterThanOrEqual(12);
    expect(NEW_PASSWORD_MAX).toBeLessThanOrEqual(SERVER_PASSWORD_MAX);
  });
});

describe("validatePasswordChange", () => {
  it("accepts a valid input", () => {
    expect(validatePasswordChange(ok)).toEqual({});
  });

  it("requires every field", () => {
    const errors = validatePasswordChange({ currentPassword: "", newPassword: "", confirmPassword: "" });
    expect(Object.keys(errors).sort()).toEqual(["confirmPassword", "currentPassword", "newPassword"]);
  });

  it("rejects a new password shorter than the form minimum, even if the server would accept it", () => {
    const short = "a".repeat(NEW_PASSWORD_MIN - 1);
    expect(short.length).toBeGreaterThanOrEqual(SERVER_PASSWORD_MIN);
    const errors = validatePasswordChange({ ...ok, newPassword: short, confirmPassword: short });
    expect(errors.newPassword).toContain(String(NEW_PASSWORD_MIN));
  });

  it("accepts exactly the minimum and exactly the maximum", () => {
    const min = "b".repeat(NEW_PASSWORD_MIN);
    expect(validatePasswordChange({ ...ok, newPassword: min, confirmPassword: min })).toEqual({});
    const max = "c".repeat(NEW_PASSWORD_MAX);
    expect(validatePasswordChange({ ...ok, newPassword: max, confirmPassword: max })).toEqual({});
  });

  it("rejects a new password above the maximum", () => {
    const long = "d".repeat(NEW_PASSWORD_MAX + 1);
    expect(validatePasswordChange({ ...ok, newPassword: long, confirmPassword: long }).newPassword).toBeDefined();
  });

  it("rejects new equal to current", () => {
    const same = "bir-xil-parol-123";
    const errors = validatePasswordChange({ currentPassword: same, newPassword: same, confirmPassword: same });
    expect(errors.newPassword).toMatch(/farq/);
    expect(errors.confirmPassword).toBeUndefined();
  });

  it("rejects mismatching confirmation", () => {
    const errors = validatePasswordChange({ ...ok, confirmPassword: "boshqa-parol-12345" });
    expect(errors).toEqual({ confirmPassword: "Parollar mos kelmadi." });
  });

  it("does not trim: whitespace counts as characters", () => {
    const spaced = " ".repeat(NEW_PASSWORD_MIN);
    expect(validatePasswordChange({ ...ok, newPassword: spaced, confirmPassword: spaced })).toEqual({});
  });

  it("never echoes passwords inside messages", () => {
    const errors = validatePasswordChange({ currentPassword: "SECRET-A", newPassword: "SECRET-B", confirmPassword: "SECRET-C" });
    expect(JSON.stringify(errors)).not.toMatch(/SECRET/);
  });
});

describe("parseRetryAfter / formatWait", () => {
  it("parses seconds and HTTP dates, rejects junk", () => {
    expect(parseRetryAfter("120")).toBe(120);
    expect(parseRetryAfter(" 7 ")).toBe(7);
    expect(parseRetryAfter("0")).toBeNull();
    expect(parseRetryAfter("abc")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:01:30 GMT", now)).toBe(90);
    expect(parseRetryAfter("Wed, 31 Dec 2025 23:00:00 GMT", now)).toBeNull();
  });

  it("formats waits in Uzbek, rounding up", () => {
    expect(formatWait(1)).toBe("1 soniya");
    expect(formatWait(45)).toBe("45 soniya");
    expect(formatWait(60)).toBe("1 daqiqa");
    expect(formatWait(61)).toBe("2 daqiqa");
    expect(formatWait(600)).toBe("10 daqiqa");
    expect(formatWait(3601)).toBe("2 soat");
  });
});

describe("describeChangePasswordFailure", () => {
  it("wrong current password points at the current field", () => {
    expect(describeChangePasswordFailure({ status: 400, code: "INVALID_PASSWORD" })).toEqual({
      message: "Joriy parol noto'g'ri.",
      field: "currentPassword",
    });
  });

  it("too short / too long point at the new field", () => {
    expect(describeChangePasswordFailure({ status: 400, code: "PASSWORD_TOO_SHORT" }).field).toBe("newPassword");
    expect(describeChangePasswordFailure({ status: 400, code: "PASSWORD_TOO_LONG" }).field).toBe("newPassword");
  });

  it("429 tells how long to wait when Retry-After is known", () => {
    expect(describeChangePasswordFailure({ status: 429, retryAfter: "540" }).message).toContain("9 daqiqa");
  });

  it("429 without a readable Retry-After still gives a clear message", () => {
    const view = describeChangePasswordFailure({ status: 429, retryAfter: null });
    expect(view.message).toMatch(/Juda ko'p urinish/);
    expect(view.message).toMatch(/daqiqadan keyin/);
  });

  it("network errors and unknown statuses", () => {
    expect(describeChangePasswordFailure({}).message).toMatch(/Tarmoq xatosi/);
    expect(describeChangePasswordFailure({ status: 0 }).message).toMatch(/Tarmoq xatosi/);
    expect(describeChangePasswordFailure({ status: 500 }).message).toMatch(/Parolni almashtirib bo'lmadi/);
    expect(describeChangePasswordFailure({ status: 401 }).message).toMatch(/Qaytadan kiring/);
  });
});
