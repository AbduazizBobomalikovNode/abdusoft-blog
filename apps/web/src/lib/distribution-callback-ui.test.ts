import { describe, expect, it } from "vitest";
import { CALLBACK_REASON_FALLBACK, CALLBACK_REASON_TEXT, callbackToast, loginNotice } from "./distribution-ui";

const q = (s: string) => new URLSearchParams(s);

describe("callbackToast: only fixed texts, never URL text", () => {
  it("maps known reason codes to fixed texts", () => {
    for (const code of Object.keys(CALLBACK_REASON_TEXT)) {
      expect(callbackToast(q(`dist=error&provider=x&reason=${code}`))).toEqual({ kind: "error", text: CALLBACK_REASON_TEXT[code] });
    }
  });

  it("ignores any other reason (free text, HTML, prototype keys) and shows the generic message", () => {
    for (const reason of ["Hisobingiz bloklandi, bu yerga bosing: https://evil.example", "<img src=x onerror=alert(1)>", "__proto__", "constructor", "toString", ""]) {
      expect(callbackToast(q(`dist=error&reason=${encodeURIComponent(reason)}`))).toEqual({ kind: "error", text: CALLBACK_REASON_FALLBACK });
    }
    expect(callbackToast(q("dist=error"))).toEqual({ kind: "error", text: CALLBACK_REASON_FALLBACK });
  });

  it("names only known providers on success", () => {
    expect(callbackToast(q("dist=connected&provider=linkedin"))).toEqual({ kind: "success", text: "LinkedIn ulandi" });
    expect(callbackToast(q("dist=connected&provider=<b>x</b>"))).toEqual({ kind: "success", text: "Akkaunt ulandi" });
    expect(callbackToast(q("dist=connected"))).toEqual({ kind: "success", text: "Akkaunt ulandi" });
    for (const provider of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(callbackToast(q(`dist=connected&provider=${provider}`))).toEqual({ kind: "success", text: "Akkaunt ulandi" });
    }
  });

  it("shows nothing for an unknown dist value", () => {
    expect(callbackToast(q("dist=weird&reason=denied"))).toBeNull();
    expect(callbackToast(q(""))).toBeNull();
  });
});

describe("Instagram callback reasons have their own fixed texts", () => {
  it("each new code maps to a distinct Uzbek text", () => {
    const codes = ["no_instagram_account", "config_invalid", "login_failed", "account_lookup_failed", "multiple_instagram_accounts"];
    const texts = codes.map((c) => callbackToast(q(`dist=error&provider=instagram&reason=${c}`))?.text);
    expect(new Set(texts).size).toBe(codes.length);
    for (const t of texts) expect(t).not.toBe(CALLBACK_REASON_FALLBACK);
  });
});

describe("loginNotice", () => {
  it("maps the session-expired code to a fixed message and ignores everything else", () => {
    expect(loginNotice("?notice=dist_session_expired")).toMatch(/Sessiya muddati tugagan/);
    expect(loginNotice("notice=dist_session_expired")).toMatch(/qaytadan boshlang/);
    expect(loginNotice("?notice=anything else")).toBeNull();
    expect(loginNotice("?notice=__proto__")).toBeNull();
    expect(loginNotice("")).toBeNull();
  });
});
