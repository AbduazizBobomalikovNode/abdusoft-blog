import { describe, expect, it } from "vitest";
import { NEW_PASSWORD_MAX, NEW_PASSWORD_MIN } from "./password-change";
import {
  FORGOT_NEUTRAL_MESSAGE,
  describeForgotFailure,
  describeLinkState,
  describeResetFailure,
  parseResetLocation,
  validateForgotEmail,
  validatePasswordReset,
} from "./password-reset";

describe("validateForgotEmail", () => {
  it("accepts a normal address (trimmed) and rejects empty/garbage", () => {
    expect(validateForgotEmail("  owner@example.com ")).toBeNull();
    expect(validateForgotEmail("")).toContain("kiriting");
    expect(validateForgotEmail("not-an-email")).toContain("noto'g'ri");
    expect(validateForgotEmail(`${"a".repeat(250)}@x.io`)).toContain("noto'g'ri");
  });
});

describe("neutral answer", () => {
  it("says nothing about whether the account exists", () => {
    expect(FORGOT_NEUTRAL_MESSAGE).toContain("Agar");
    expect(FORGOT_NEUTRAL_MESSAGE).not.toMatch(/topilmadi|mavjud emas|yuborildi\.$/);
  });
});

describe("describeForgotFailure", () => {
  it("shows the wait time for 429 (seconds and HTTP-date forms) and falls back without it", () => {
    expect(describeForgotFailure({ status: 429, retryAfter: "90" })).toContain("2 daqiqa");
    expect(describeForgotFailure({ status: 429, retryAfter: "30" })).toContain("30 soniya");
    expect(describeForgotFailure({ status: 429 })).toContain("Bir necha daqiqadan");
  });
  it("distinguishes network errors from other failures", () => {
    expect(describeForgotFailure({})).toContain("Tarmoq xatosi");
    expect(describeForgotFailure({ status: 500 })).toContain("yuborib bo'lmadi");
  });
});

describe("parseResetLocation", () => {
  it("reads the token", () => {
    expect(parseResetLocation("?token=abc123")).toEqual({ kind: "ready", token: "abc123" });
  });
  it("maps the library's error redirect to an invalid link", () => {
    expect(parseResetLocation("?error=INVALID_TOKEN")).toEqual({ kind: "invalid" });
  });
  it("maps the limiter redirect and keeps the wait time", () => {
    expect(parseResetLocation("?error=RATE_LIMITED&wait=420")).toEqual({ kind: "rate_limited", waitSeconds: 420 });
    expect(parseResetLocation("?error=RATE_LIMITED&wait=abc")).toEqual({ kind: "rate_limited", waitSeconds: null });
  });
  it("treats an empty or absurd token as missing; an error wins over a token", () => {
    expect(parseResetLocation("")).toEqual({ kind: "missing" });
    expect(parseResetLocation("?token=")).toEqual({ kind: "missing" });
    expect(parseResetLocation(`?token=${"x".repeat(600)}`)).toEqual({ kind: "missing" });
    expect(parseResetLocation("?token=abc&error=INVALID_TOKEN")).toEqual({ kind: "invalid" });
  });
});

describe("validatePasswordReset", () => {
  const good = "p".repeat(NEW_PASSWORD_MIN);
  it("accepts the account page's rules (min 12 .. server max)", () => {
    expect(validatePasswordReset({ newPassword: good, confirmPassword: good })).toEqual({});
    const max = "p".repeat(NEW_PASSWORD_MAX);
    expect(validatePasswordReset({ newPassword: max, confirmPassword: max })).toEqual({});
  });
  it("rejects short, long, empty and mismatching input", () => {
    const short = "p".repeat(NEW_PASSWORD_MIN - 1);
    expect(validatePasswordReset({ newPassword: short, confirmPassword: short }).newPassword).toContain(String(NEW_PASSWORD_MIN));
    const long = "p".repeat(NEW_PASSWORD_MAX + 1);
    expect(validatePasswordReset({ newPassword: long, confirmPassword: long }).newPassword).toContain(String(NEW_PASSWORD_MAX));
    expect(Object.keys(validatePasswordReset({ newPassword: "", confirmPassword: "" })).sort()).toEqual(["confirmPassword", "newPassword"]);
    expect(validatePasswordReset({ newPassword: good, confirmPassword: `${good}x` }).confirmPassword).toContain("mos kelmadi");
  });
});

describe("describeResetFailure", () => {
  it("maps an expired/used link to the link-invalid view", () => {
    const view = describeResetFailure({ status: 400, code: "INVALID_TOKEN" });
    expect(view.linkInvalid).toBe(true);
    expect(view.message).toContain("muddati tugagan");
    expect(view.message).toContain("allaqachon ishlatilgan");
  });
  it("shows the wait time for 429", () => {
    expect(describeResetFailure({ status: 429, retryAfter: "600" }).message).toContain("10 daqiqa");
  });
  it("maps server length codes to the password field and never echoes server text", () => {
    expect(describeResetFailure({ status: 400, code: "PASSWORD_TOO_SHORT" }).field).toBe("newPassword");
    expect(describeResetFailure({ status: 400, code: "PASSWORD_TOO_LONG" }).field).toBe("newPassword");
    expect(describeResetFailure({ status: 500, code: "SOMETHING" }).message).not.toMatch(/SOMETHING/);
    expect(describeResetFailure({}).message).toContain("Tarmoq xatosi");
  });
});

describe("describeLinkState", () => {
  it("has a title and message for every non-form state", () => {
    expect(describeLinkState({ kind: "invalid" }).title).toBe("Havola yaroqsiz");
    expect(describeLinkState({ kind: "rate_limited", waitSeconds: 600 }).message).toContain("10 daqiqa");
    expect(describeLinkState({ kind: "rate_limited", waitSeconds: null }).message).toContain("Bir necha daqiqa");
    expect(describeLinkState({ kind: "missing" }).message).toContain("qayta oching");
  });
});
