import { describe, expect, it } from "vitest";
import { codeChallengeS256 } from "./pkce.js";
import { createOAuthState, OAUTH_STATE_TTL_MS, verifyOAuthState } from "./oauth-state.js";

const now = new Date("2026-11-25T10:00:00Z");

describe("OAuth state / PKCE helper", () => {
  it("creates a record with expiry and a matching S256 challenge", () => {
    const c = createOAuthState({ provider: "x", now, withPkce: true });
    expect(c.record.expiresAt.getTime()).toBe(now.getTime() + OAUTH_STATE_TTL_MS);
    expect(c.record.state).toBe(c.state);
    expect(c.record.codeVerifier).toHaveLength(43);
    expect(c.codeChallenge).toBe(codeChallengeS256(c.record.codeVerifier as string));
    expect(createOAuthState({ provider: "linkedin", now }).codeChallenge).toBeUndefined();
  });
  it("verifies the state and returns the verifier", () => {
    const c = createOAuthState({ provider: "x", now, withPkce: true });
    expect(verifyOAuthState(c.record, c.state, "x", new Date(now.getTime() + 1000))).toEqual({ ok: true, codeVerifier: c.record.codeVerifier });
  });
  it("rejects mismatch, missing, wrong provider and expiry", () => {
    const c = createOAuthState({ provider: "x", now, ttlMs: 60_000 });
    const t = new Date(now.getTime() + 1000);
    expect(verifyOAuthState(c.record, "other", "x", t)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyOAuthState(c.record, null, "x", t)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyOAuthState(c.record, c.state, "threads", t)).toEqual({ ok: false, reason: "provider" });
    expect(verifyOAuthState(c.record, c.state, "x", new Date(now.getTime() + 60_000))).toEqual({ ok: false, reason: "expired" });
  });
  it("produces different state values per call", () => {
    expect(createOAuthState({ provider: "x", now }).state).not.toBe(createOAuthState({ provider: "x", now }).state);
  });
});
