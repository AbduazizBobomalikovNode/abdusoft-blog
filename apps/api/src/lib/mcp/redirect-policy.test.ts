import { describe, expect, it } from "vitest";
import { isAllowedRedirectUri, parseExtraRedirectUris } from "./redirect-policy.js";

describe("isAllowedRedirectUri", () => {
  it("allows Claude's callback and loopback callbacks with any port", () => {
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:3118/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:65000/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost/callback")).toBe(true);
  });

  it("rejects look-alikes and everything else", () => {
    for (const uri of [
      "https://claude.com/api/mcp/auth_callback",
      "https://claude.ai.evil.example/api/mcp/auth_callback",
      "https://claude.ai/api/mcp/auth_callback#x",
      "https://claude.ai/api/mcp/auth_callback?code=1",
      "https://user@claude.ai/api/mcp/auth_callback",
      "http://localhost:80/callback/extra",
      "http://[::1]:5000/callback",
      "http://0.0.0.0:5000/callback",
      "ftp://localhost/callback",
      "",
    ]) {
      expect(isAllowedRedirectUri(uri), uri).toBe(false);
    }
  });

  it("honours an explicit allow-list for extra https callbacks only", () => {
    const extra = new Set(parseExtraRedirectUris("https://claude.com/api/mcp/auth_callback, http://insecure.example/cb, nonsense, https://app.example/cb#frag"));
    expect([...extra]).toEqual(["https://claude.com/api/mcp/auth_callback"]);
    expect(isAllowedRedirectUri("https://claude.com/api/mcp/auth_callback", extra)).toBe(true);
    expect(isAllowedRedirectUri("https://claude.com/api/mcp/other", extra)).toBe(false);
  });
});
