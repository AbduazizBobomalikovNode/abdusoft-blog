import { describe, expect, it } from "vitest";
import { DAY_MS, getTokenStatus, HOUR_MS } from "./token-status.js";
import { LINKEDIN_TOKEN_POLICY } from "./providers/linkedin.js";
import { X_TOKEN_POLICY } from "./providers/x.js";
import { GRAPH_TOKEN_POLICY } from "./providers/graph.js";
import { GITHUB_TOKEN_POLICY } from "./providers/github.js";

const t0 = new Date("2026-11-01T00:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);
const acc = (over: Partial<Parameters<typeof getTokenStatus>[0]> = {}) => ({
  accessTokenExpiresAt: at(60 * DAY_MS),
  refreshToken: null,
  refreshTokenExpiresAt: null,
  issuedAt: t0,
  ...over,
});

describe("LinkedIn (60 days, no refresh)", () => {
  it("transitions ok -> expiring -> expired with a fake clock", () => {
    expect(getTokenStatus(acc(), LINKEDIN_TOKEN_POLICY, at(10 * DAY_MS)).state).toBe("ok");
    expect(getTokenStatus(acc(), LINKEDIN_TOKEN_POLICY, at(52 * DAY_MS)).state).toBe("ok"); // 8 kun qoldi
    expect(getTokenStatus(acc(), LINKEDIN_TOKEN_POLICY, at(53 * DAY_MS)).state).toBe("expiring"); // 7 kun qoldi
    expect(getTokenStatus(acc(), LINKEDIN_TOKEN_POLICY, at(60 * DAY_MS)).state).toBe("expired");
    expect(getTokenStatus(acc(), LINKEDIN_TOKEN_POLICY, at(61 * DAY_MS)).state).toBe("expired");
  });
  it("cannot refresh, reminds 10 days before expiry", () => {
    const s = getTokenStatus(acc(), LINKEDIN_TOKEN_POLICY, at(1 * DAY_MS));
    expect(s.canRefresh).toBe(false);
    expect(s.refreshDue).toBe(false);
    expect(s.remindAt?.toISOString()).toBe(at(50 * DAY_MS).toISOString());
    expect(s.daysLeft).toBe(59);
  });
});

describe("X (2h access + rotating refresh token)", () => {
  const x = (over = {}) => acc({ accessTokenExpiresAt: at(2 * HOUR_MS), refreshToken: "r", ...over });
  it("stays ok when the access token is expired but a refresh token exists", () => {
    const s = getTokenStatus(x(), X_TOKEN_POLICY, at(3 * HOUR_MS));
    expect(s.state).toBe("ok");
    expect(s.canRefresh).toBe(true);
    expect(s.refreshDue).toBe(true);
  });
  it("refresh becomes due 10 minutes before access expiry", () => {
    expect(getTokenStatus(x(), X_TOKEN_POLICY, at(1 * HOUR_MS)).refreshDue).toBe(false);
    expect(getTokenStatus(x(), X_TOKEN_POLICY, at(2 * HOUR_MS - 5 * 60_000)).refreshDue).toBe(true);
  });
  it("is expired without a refresh token once access expires", () => {
    expect(getTokenStatus(x({ refreshToken: null }), X_TOKEN_POLICY, at(3 * HOUR_MS)).state).toBe("expired");
  });
  it("uses the refresh token expiry when known", () => {
    const a = x({ refreshTokenExpiresAt: at(10 * DAY_MS) });
    expect(getTokenStatus(a, X_TOKEN_POLICY, at(1 * DAY_MS)).state).toBe("ok");
    expect(getTokenStatus(a, X_TOKEN_POLICY, at(4 * DAY_MS)).state).toBe("expiring");
    expect(getTokenStatus(a, X_TOKEN_POLICY, at(11 * DAY_MS)).state).toBe("expired");
  });
});

describe("Threads / Instagram (60 days, self refresh after 24h)", () => {
  it("cannot refresh in the first 24h", () => {
    const s = getTokenStatus(acc(), GRAPH_TOKEN_POLICY, at(12 * HOUR_MS));
    expect(s.canRefresh).toBe(false);
  });
  it("can refresh after 24h and is due in the second half of its life", () => {
    expect(getTokenStatus(acc(), GRAPH_TOKEN_POLICY, at(2 * DAY_MS))).toMatchObject({ canRefresh: true, refreshDue: false });
    expect(getTokenStatus(acc(), GRAPH_TOKEN_POLICY, at(31 * DAY_MS))).toMatchObject({ canRefresh: true, refreshDue: true, state: "ok" });
  });
  it("an expired token can no longer be refreshed", () => {
    expect(getTokenStatus(acc(), GRAPH_TOKEN_POLICY, at(61 * DAY_MS))).toMatchObject({ canRefresh: false, state: "expired" });
  });
});

describe("GitHub pasted token", () => {
  it("is ok forever without a known expiry", () => {
    const s = getTokenStatus(acc({ accessTokenExpiresAt: null }), GITHUB_TOKEN_POLICY, at(1000 * DAY_MS));
    expect(s).toMatchObject({ state: "ok", expiresAt: null, remindAt: null, daysLeft: null });
  });
  it("warns near a known expiry", () => {
    expect(getTokenStatus(acc({ accessTokenExpiresAt: at(30 * DAY_MS) }), GITHUB_TOKEN_POLICY, at(24 * DAY_MS)).state).toBe("expiring");
  });
});
