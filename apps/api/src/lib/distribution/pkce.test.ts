import { describe, expect, it } from "vitest";
import { codeChallengeS256, generateCodeVerifier, generateState } from "./pkce.js";

describe("PKCE (RFC 7636)", () => {
  it("matches the RFC 7636 Appendix B test vector", () => {
    expect(codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  it("produces a 43 char base64url verifier from 32 bytes", () => {
    const v = generateCodeVerifier(() => new Uint8Array(32).fill(251));
    expect(v).toHaveLength(43);
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it("random verifier/state differ per call", () => {
    expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
    expect(generateState()).not.toBe(generateState());
  });
});
