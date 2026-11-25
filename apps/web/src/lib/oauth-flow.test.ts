import { describe, expect, it } from "vitest";
import type { McpConsentInfo } from "@blog/shared";
import {
  consentRedirectUrl,
  consentViewState,
  describeConnectionScopes,
  displayClientName,
  isReadOnlyRequest,
  registeredAgo,
  hasSignedOAuthQuery,
  oauthContinuationUrl,
  rawOAuthQuery,
} from "./oauth-flow";

const SIGNED = "?response_type=code&client_id=abc&scope=blog%3Aread+posts%3Apublish&exp=1&sig=xyz";

const info = (over: Partial<McpConsentInfo> = {}): McpConsentInfo => ({
  allowed: true,
  reason: null,
  user: { name: "Owner", email: "o@example.test", role: "admin" },
  client: { id: "abc", name: "Claude", redirectHost: "claude.ai", redirectKind: "claude", registeredAt: "2030-01-01T00:00:00.000Z" },
  scopes: ["blog:read", "posts:publish", "posts:delete", "offline_access", "weird:scope"],
  ...over,
});

describe("login carry-through", () => {
  it("recognises a signed OAuth query and ignores everything else", () => {
    expect(hasSignedOAuthQuery(SIGNED)).toBe(true);
    expect(hasSignedOAuthQuery(SIGNED.slice(1))).toBe(true);
    expect(hasSignedOAuthQuery("")).toBe(false);
    expect(hasSignedOAuthQuery("?next=/admin")).toBe(false);
    expect(hasSignedOAuthQuery("?client_id=abc")).toBe(false);
    expect(rawOAuthQuery(SIGNED)).toBe(SIGNED.slice(1));
  });

  it("continues to the authorization URL only inside an OAuth flow", () => {
    const data = { redirect: true, url: "http://localhost:4000/api/auth/oauth2/authorize?x=1" };
    expect(oauthContinuationUrl(SIGNED, data)).toBe(data.url);
    // Oddiy kirish: avvalgi xatti-harakat (hech qanday yo'naltirish yo'q)
    expect(oauthContinuationUrl("", data)).toBeNull();
    expect(oauthContinuationUrl("?next=1", data)).toBeNull();
    expect(oauthContinuationUrl(SIGNED, { redirect: false, token: "t", user: {} })).toBeNull();
    expect(oauthContinuationUrl(SIGNED, null)).toBeNull();
    expect(oauthContinuationUrl(SIGNED, { url: "" })).toBeNull();
    expect(oauthContinuationUrl(SIGNED, { url: 5 })).toBeNull();
  });
});

describe("consent page state", () => {
  it("rejects a link without a signed query before calling the API", () => {
    expect(consentViewState("", null)).toEqual({ kind: "invalid-link" });
    expect(consentViewState("?foo=bar", { status: 200, body: info() })).toEqual({ kind: "invalid-link" });
  });

  it("maps API failures to clear states", () => {
    expect(consentViewState(SIGNED, null)).toEqual({ kind: "unavailable" });
    expect(consentViewState(SIGNED, { status: 401, body: {} })).toEqual({ kind: "signed-out" });
    expect(consentViewState(SIGNED, { status: 400, body: {} })).toEqual({ kind: "expired" });
    expect(consentViewState(SIGNED, { status: 500, body: {} })).toEqual({ kind: "unavailable" });
    expect(consentViewState(SIGNED, { status: 200, body: { nonsense: true } })).toEqual({ kind: "unavailable" });
  });

  it("refuses staff and ordinary users", () => {
    const refused = consentViewState(SIGNED, { status: 200, body: info({ allowed: false, reason: "not_admin", user: { name: "S", email: "s@example.test", role: "staff" } }) });
    expect(refused.kind).toBe("refused");
    expect(consentViewState(SIGNED, { status: 200, body: info({ allowed: false, reason: "unknown_client" }) }).kind).toBe("unknown-client");
  });

  it("groups the requested permissions (reading / publishing / dangerous) and flags dangerous ones", () => {
    const state = consentViewState(SIGNED, { status: 200, body: info() });
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.groups.map((g) => g.group)).toEqual(["read", "publish", "danger"]);
    expect(state.groups[0]!.scopes[0]).toMatchObject({ id: "blog:read", label: "Blogni o'qish" });
    expect(state.hasDanger).toBe(true);
    expect(state.offline).toBe(true);
    expect(state.unknown).toEqual(["weird:scope"]);
  });

  it("does not flag danger for a read-only request", () => {
    const state = consentViewState(SIGNED, { status: 200, body: info({ scopes: ["blog:read"] }) });
    expect(state.kind === "ready" && !state.hasDanger && !state.offline && state.unknown.length === 0).toBe(true);
  });

  it("extracts the redirect URL from a consent response", () => {
    expect(consentRedirectUrl({ url: "https://claude.ai/api/mcp/auth_callback?code=1" })).toBe("https://claude.ai/api/mcp/auth_callback?code=1");
    expect(consentRedirectUrl({})).toBeNull();
    expect(consentRedirectUrl(null)).toBeNull();
  });
});

describe("connection scope summary", () => {
  it("lists Uzbek labels and detects dangerous permissions", () => {
    expect(describeConnectionScopes(["blog:read", "posts:delete", "offline_access"])).toEqual({
      labels: ["Blogni o'qish", "O'chirish"],
      hasDanger: true,
      offline: true,
    });
    expect(describeConnectionScopes([])).toEqual({ labels: [], hasDanger: false, offline: false });
  });
});

describe("impersonation hints", () => {
  it("shortens and normalises untrusted client names", () => {
    expect(displayClientName("  Claude \n  Desktop ")).toBe("Claude Desktop");
    expect(displayClientName("x".repeat(100))).toHaveLength(60);
    expect(displayClientName("x".repeat(100)).endsWith("…")).toBe(true);
    expect(displayClientName(null)).toBe("Nomsiz ilova");
  });

  it("tells how long ago the client was registered", () => {
    const now = Date.parse("2030-01-02T12:00:00.000Z");
    expect(registeredAgo("2030-01-02T11:59:50.000Z", now)).toBe("hozirgina");
    expect(registeredAgo("2030-01-02T11:30:00.000Z", now)).toBe("30 daqiqa oldin");
    expect(registeredAgo("2030-01-02T07:00:00.000Z", now)).toBe("5 soat oldin");
    expect(registeredAgo("2029-12-30T12:00:00.000Z", now)).toBe("3 kun oldin");
    expect(registeredAgo(null, now)).toBeNull();
  });

  it("recognises a read-only request", () => {
    const state = consentViewState(SIGNED, { status: 200, body: info({ scopes: ["blog:read", "offline_access"] }) });
    expect(state.kind === "ready" && isReadOnlyRequest(state.groups)).toBe(true);
    expect(isReadOnlyRequest([{ group: "read" }, { group: "danger" }])).toBe(false);
  });
});
