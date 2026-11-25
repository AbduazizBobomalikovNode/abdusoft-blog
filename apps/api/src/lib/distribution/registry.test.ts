import { afterEach, describe, expect, it, vi } from "vitest";
import { createProvider, LINKEDIN_TERMS_CLAUSE, listProviderMetadata, PROVIDER_IDS, PROVIDER_METADATA } from "./registry.js";
import { DistributionError, isDistributionError } from "./errors.js";
import { ALL_ALLOWED_HOSTS, json, makeDeps, mockFetch, POST_FIXTURE, SECRET } from "./test-utils.js";
import type { ConnectedAccount } from "./types.js";

const account = (provider: ConnectedAccount["provider"]): ConnectedAccount => ({
  provider, externalId: "id1", displayName: "O", username: "o", accessToken: SECRET, refreshToken: "REFRESH-" + SECRET, accessTokenExpiresAt: null, refreshTokenExpiresAt: null,
  scopes: [], issuedAt: new Date("2026-11-01T00:00:00Z"), connectedAt: new Date("2026-11-01T00:00:00Z"), meta: { owner: "o", repo: "o" },
});

describe("registry", () => {
  it("lists five providers with Uzbek names, scopes and setup steps", () => {
    expect(PROVIDER_IDS).toEqual(["linkedin", "x", "threads", "instagram", "github"]);
    for (const m of listProviderMetadata()) {
      expect(m.name.length).toBeGreaterThan(2);
      expect(m.ownerSetup.length).toBeGreaterThan(2);
      expect(m.scopes.length).toBeGreaterThan(0);
      expect(m.docs.every((d) => d.startsWith("https://"))).toBe(true);
      expect(createProvider(m.id).id).toBe(m.id);
    }
    expect(PROVIDER_METADATA.x.costsMoney).toBe("yes");
    expect(PROVIDER_METADATA.linkedin.tokenLifetime).toContain("60 kun");
  });
  it("quotes the LinkedIn automation clause with its URL and the explicit-trigger note", () => {
    const r = PROVIDER_METADATA.linkedin.restrictions.join(" ");
    expect(r).toContain(LINKEDIN_TERMS_CLAUSE.quote);
    expect(r).toContain("https://www.linkedin.com/legal/l/api-terms-of-use");
    expect(r).toContain("avtomatik emas");
  });
  it("no provider schedules natively; capabilities are consistent with methods", async () => {
    for (const id of PROVIDER_IDS) {
      const p = createProvider(id);
      expect(p.capabilities.nativeScheduling).toBe(false);
      expect(typeof p.remove).toBe("function");
      if (!p.capabilities.delete) {
        expect(p.capabilities.notes?.delete).toBeTruthy();
        await expect(p.remove({ deps: makeDeps(mockFetch(() => json({})).fetch), account: account(id) }, "x")).rejects.toMatchObject({ kind: "not_supported" });
      }
    }
  });
  it("importing the module has no side effects: construction needs no env or network", () => {
    const spy = vi.fn();
    expect(() => PROVIDER_IDS.forEach((id) => createProvider(id))).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("security invariants", () => {
  afterEach(() => vi.restoreAllMocks());

  it("every provider only ever calls allow-listed https hosts, even if the platform returns foreign URLs", async () => {
    const calls: string[] = [];
    for (const id of PROVIDER_IDS) {
      const m = mockFetch((c) => {
        calls.push(c.url);
        return json({ value: { uploadUrl: "https://evil.example/u", image: "urn:li:image:1" }, id: "1", status: "FINISHED", status_code: "FINISHED", data: { id: "1" }, sha: "s", encoding: "base64", content: "", permalink: "https://evil.example/p" });
      });
      const p = createProvider(id);
      await p.publish({ deps: makeDeps(m.fetch), account: account(id) }, { post: POST_FIXTURE, text: "x", image: { bytes: new Uint8Array(1), mime: "image/jpeg", width: 1000, height: 1000, sizeBytes: 1 }, imageUrl: "https://cdn.abdusoft.uz/a.jpg", latestPosts: [POST_FIXTURE] }).catch(() => undefined);
      for (const c of m.calls) expect(ALL_ALLOWED_HOSTS).toContain(c.host);
    }
    expect(calls.length).toBeGreaterThan(5);
    expect(calls.every((u) => u.startsWith("https://") && !u.includes("evil.example"))).toBe(true);
  });

  it("a test fetch fails loudly on a non-allow-listed host (guard works)", async () => {
    const m = mockFetch(() => json({}));
    await expect(m.fetch("https://evil.example/", {})).rejects.toThrow(/ruxsat etilmagan host/);
    await expect(m.fetch("http://api.github.com/", {})).rejects.toThrow(/ruxsat etilmagan host/);
  });

  it("never logs, and errors/messages never contain tokens or response bodies with them", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
    const collected: unknown[] = [];
    for (const id of PROVIDER_IDS) {
      const m = mockFetch(() => json({ message: `denied for ${SECRET} and refresh REFRESH-${SECRET}`, error: { message: `leak ${SECRET}`, code: 190 } }, { status: 400 }));
      const deps = makeDeps(m.fetch);
      const p = createProvider(id);
      const e = await p.publish({ deps, account: account(id) }, { post: POST_FIXTURE, text: "x", imageUrl: "https://cdn.abdusoft.uz/a.jpg", image: { bytes: new Uint8Array(1), mime: "image/jpeg", width: 1000, height: 1000, sizeBytes: 1 }, latestPosts: [POST_FIXTURE] }).catch((x: unknown) => x);
      collected.push(e);
      const ex = await p.auth.exchangeCode?.(deps, { creds: { clientId: "c", clientSecret: SECRET, redirectUri: "https://r" }, code: SECRET, codeVerifier: SECRET }).catch((x: unknown) => x);
      collected.push(ex);
    }
    for (const e of collected.filter((x) => x !== undefined)) {
      expect(isDistributionError(e)).toBe(true);
      const d = e as DistributionError;
      expect(`${d.message} ${d.platformMessage ?? ""} ${d.stack?.split("\n")[0] ?? ""} ${JSON.stringify(d)}`).not.toContain(SECRET);
    }
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it("DistributionError.retryable is false for outcome_unknown and permanent errors", () => {
    const k = (kind: DistributionError["kind"]) => new DistributionError({ kind, message: "m" }).retryable;
    expect([k("transient"), k("rate_limited")]).toEqual([true, true]);
    expect([k("outcome_unknown"), k("auth_expired"), k("permission_missing"), k("validation_rejected"), k("duplicate_content"), k("payment_required")]).toEqual([false, false, false, false, false, false]);
  });
});
