import { describe, expect, it } from "vitest";
import { createInstagramProvider, INSTAGRAM_CAPTION_MAX } from "./providers/instagram.js";
import { formOf, json, makeDeps, mockFetch, POST_FIXTURE, SECRET } from "./test-utils.js";
import type { ConnectedAccount } from "./types.js";

const p = createInstagramProvider();
const creds = { clientId: "metaapp", clientSecret: "metasecret", redirectUri: "https://api.example/cb", configId: "CFG123" };
const account: ConnectedAccount = {
  provider: "instagram", externalId: "IG1", displayName: "owner", accessToken: SECRET, refreshToken: null,
  accessTokenExpiresAt: new Date("2027-01-01T00:00:00Z"), refreshTokenExpiresAt: null, scopes: [],
  issuedAt: new Date("2026-11-01T00:00:00Z"), connectedAt: new Date("2026-11-01T00:00:00Z"),
};
const IMG = "https://cdn.abdusoft.uz/cover.jpg";

const okToken = () => json({ access_token: "SUAT-1234567890", token_type: "bearer" });
const okAccounts = (data: unknown[] = [{ id: "17841400000000001", username: "owner" }]) => json({ data });
const okMe = () => json({ id: "SU1", client_business_id: "BIZ777" });

describe("Instagram auth (Unified Login)", () => {
  it("dialog URL: facebook.com/dialog/oauth with client_id, config_id, redirect_uri, response_type=code, state — and NO scope", () => {
    const u = new URL(p.auth.buildAuthorizationUrl!({ creds, state: "st-1" }));
    expect(u.origin + u.pathname).toBe("https://www.facebook.com/dialog/oauth");
    expect(Object.fromEntries(u.searchParams)).toEqual({ client_id: "metaapp", config_id: "CFG123", redirect_uri: "https://api.example/cb", response_type: "code", state: "st-1" });
    expect(u.searchParams.has("scope")).toBe(false);
  });
  it("dialog URL without a Config ID is refused with its own reason", () => {
    const noCfg = { clientId: creds.clientId, clientSecret: creds.clientSecret, redirectUri: creds.redirectUri };
    expect(() => p.auth.buildAuthorizationUrl!({ creds: noCfg, state: "s" })).toThrowError(expect.objectContaining({ reason: "config_invalid" }));
  });
  it("exchange: GET graph.facebook.com/<ver>/oauth/access_token with client_id, client_secret, code and redirect_uri; then accounts and client_business_id", async () => {
    const m = mockFetch([okToken, () => okAccounts(), okMe]);
    const acc = await p.auth.exchangeCode!(makeDeps(m.fetch), { creds, code: "CODE-XYZ" });
    const t = new URL(m.calls[0]!.url);
    expect(m.calls[0]!.method).toBe("GET");
    expect(t.origin + t.pathname).toBe("https://graph.facebook.com/v27.0/oauth/access_token");
    expect(Object.fromEntries(t.searchParams)).toEqual({ client_id: "metaapp", client_secret: "metasecret", code: "CODE-XYZ", redirect_uri: "https://api.example/cb" });
    const l = new URL(m.calls[1]!.url);
    expect(l.pathname).toBe("/v27.0/me/assigned_instagram_accounts");
    expect(l.searchParams.get("fields")).toBe("id,username");
    expect(l.searchParams.get("access_token")).toBe("SUAT-1234567890");
    const me = new URL(m.calls[2]!.url);
    expect(me.pathname).toBe("/v27.0/me");
    expect(me.searchParams.get("fields")).toBe("client_business_id");
    expect(acc).toMatchObject({ provider: "instagram", externalId: "17841400000000001", username: "owner", displayName: "owner", accessToken: "SUAT-1234567890", refreshToken: null, accessTokenExpiresAt: null });
    expect(acc.meta).toEqual({ clientBusinessId: "BIZ777" });
    expect(acc.scopes).toEqual(["instagram_basic", "instagram_manage_messages", "instagram_content_publish"]);
  });
  it("exchange without redirect_uri when the option is off", async () => {
    const m = mockFetch([okToken, () => okAccounts(), okMe]);
    await createInstagramProvider({ exchangeRedirectUri: false }).auth.exchangeCode!(makeDeps(m.fetch), { creds, code: "C1234" });
    expect(new URL(m.calls[0]!.url).searchParams.has("redirect_uri")).toBe(false);
  });
  it("the Graph version is one setting; an invalid value falls back to v27.0", async () => {
    const m = mockFetch([okToken, () => okAccounts(), okMe]);
    await createInstagramProvider({ graphVersion: "v28.0" }).auth.exchangeCode!(makeDeps(m.fetch), { creds, code: "C1234" });
    expect(m.calls.map((c) => new URL(c.url).pathname.split("/")[1])).toEqual(["v28.0", "v28.0", "v28.0"]);
    const m2 = mockFetch([okToken, () => okAccounts(), okMe]);
    await createInstagramProvider({ graphVersion: "../evil" }).auth.exchangeCode!(makeDeps(m2.fetch), { creds, code: "C1234" });
    expect(new URL(m2.calls[0]!.url).pathname).toBe("/v27.0/oauth/access_token");
  });
  it("token lifetime: expires_in present -> expiry is stored; absent -> never expires (null)", async () => {
    const now = new Date("2026-11-26T10:00:00Z");
    const m = mockFetch([() => json({ access_token: "SUAT-1234567890", expires_in: 5184000 }), () => okAccounts(), okMe]);
    const acc = await p.auth.exchangeCode!(makeDeps(m.fetch, now), { creds, code: "C1234" });
    expect(acc.accessTokenExpiresAt).toEqual(new Date(now.getTime() + 5184000 * 1000));
    const st = p.tokenStatus(acc, new Date(now.getTime() + 3 * 86_400_000));
    expect(st).toMatchObject({ state: "ok", canRefresh: false, refreshDue: false });
    expect(p.tokenPolicy.refresh).toBe("none");
    expect(p.auth.refresh).toBeUndefined();
  });
  it("a token without expiry is always ok: no expiry, no reminder, no refresh", () => {
    const never = { ...account, accessTokenExpiresAt: null };
    expect(p.tokenStatus(never, new Date("2040-01-01T00:00:00Z"))).toEqual({ state: "ok", expiresAt: null, canRefresh: false, refreshDue: false, remindAt: null, daysLeft: null });
  });
  it("account discovery: several accounts -> refused (nothing stored, no further request); empty list -> distinct error", async () => {
    const m = mockFetch([okToken, () => okAccounts([{ id: "111", username: "first" }, { id: "222", username: "second" }]), okMe]);
    const err = await p.auth.exchangeCode!(makeDeps(m.fetch), { creds, code: "C1234" }).then(() => null, (e: unknown) => e as { kind: string; reason?: string; message: string });
    expect(err).toMatchObject({ kind: "validation_rejected", reason: "multiple_instagram_accounts" });
    expect(err!.message).toContain("@first");
    expect(m.calls).toHaveLength(2);
    const empty = mockFetch([okToken, () => okAccounts([])]);
    await expect(p.auth.exchangeCode!(makeDeps(empty.fetch), { creds, code: "C1234" })).rejects.toMatchObject({ kind: "validation_rejected", reason: "no_instagram_account" });
    expect(empty.calls).toHaveLength(2);
  });
  it("client_business_id failure does not stop the connection", async () => {
    const m = mockFetch([okToken, () => okAccounts(), () => json({ error: { message: "nope", code: 100 } }, { status: 400 })]);
    const acc = await p.auth.exchangeCode!(makeDeps(m.fetch), { creds, code: "C1234" });
    expect(acc.meta).toEqual({});
  });
  it("error classes: token exchange, wrong config_id, account lookup are told apart", async () => {
    const ex = mockFetch(() => json({ error: { message: "Invalid verification code format.", code: 100, type: "OAuthException" } }, { status: 400 }));
    const e1 = await p.auth.exchangeCode!(makeDeps(ex.fetch), { creds, code: "C1234" }).then(() => null, (e: unknown) => e as { kind: string; reason?: string });
    expect(e1).toMatchObject({ kind: "validation_rejected" });
    expect(e1?.reason).toBeUndefined();
    const cfg = mockFetch(() => json({ error: { message: "Invalid config_id: 999", code: 100 } }, { status: 400 }));
    await expect(p.auth.exchangeCode!(makeDeps(cfg.fetch), { creds, code: "C1234" })).rejects.toMatchObject({ reason: "config_invalid" });
    const look = mockFetch([okToken, () => json({ error: { message: "(#10) permission denied", code: 10 } }, { status: 403 })]);
    await expect(p.auth.exchangeCode!(makeDeps(look.fetch), { creds, code: "C1234" })).rejects.toMatchObject({ kind: "permission_missing", reason: "account_lookup_failed" });
  });
  it("token, secret and code never appear in error messages", async () => {
    const m = mockFetch(() => json({ error: { message: "bad code CODE-SECRET-777 secret metasecret" } }, { status: 400 }));
    const e = (await p.auth.exchangeCode!(makeDeps(m.fetch), { creds, code: "CODE-SECRET-777" }).then(() => null, (x: unknown) => x)) as Error & { platformMessage?: string };
    expect(JSON.stringify([e.message, e.platformMessage])).not.toMatch(/CODE-SECRET-777|metasecret/);
  });
  it("only graph.facebook.com is allowed", async () => {
    const { INSTAGRAM_HOSTS } = await import("./providers/instagram.js");
    expect([...INSTAGRAM_HOSTS]).toEqual(["graph.facebook.com"]);
  });
});

describe("Instagram id validation (ids go into URL paths)", () => {
  it("a non-digit account id from discovery is refused before anything is stored or requested", async () => {
    for (const id of ["../me", "12/34", "abc", "1".repeat(40), "12 3"]) {
      const m = mockFetch([okToken, () => okAccounts([{ id, username: "x" }]), okMe]);
      await expect(p.auth.exchangeCode!(makeDeps(m.fetch), { creds, code: "C1234" })).rejects.toMatchObject({ kind: "validation_rejected", reason: "account_lookup_failed" });
      expect(m.calls).toHaveLength(2);
    }
  });
  it("a malformed container id is validation_rejected and no further request is made", async () => {
    for (const id of ["../x", "12/3", "a1", "9".repeat(40)]) {
      const m = mockFetch([() => json({ id })]);
      await expect(p.publish({ deps: makeDeps(m.fetch), account }, { post: POST_FIXTURE, text: "c", imageUrl: IMG })).rejects.toMatchObject({ kind: "validation_rejected", step: "container" });
      expect(m.calls).toHaveLength(1);
    }
  });
  it("a malformed resume container id is refused without any request", async () => {
    const m = mockFetch(() => json({}));
    await expect(p.publish({ deps: makeDeps(m.fetch), account }, { post: POST_FIXTURE, text: "c", resume: { containerId: "../evil" } })).rejects.toMatchObject({ kind: "validation_rejected" });
    expect(m.calls).toHaveLength(0);
  });
  it("a malformed post id after media_publish is outcome_unknown (the post may exist): never retried, never used in a path", async () => {
    const m = mockFetch([() => json({ id: "123" }), () => json({ status_code: "FINISHED" }), () => json({ id: "../x" })]);
    await expect(p.publish({ deps: makeDeps(m.fetch), account }, { post: POST_FIXTURE, text: "c", imageUrl: IMG })).rejects.toMatchObject({ kind: "outcome_unknown", step: "publish" });
    expect(m.calls).toHaveLength(3);
  });
});

describe("Instagram publish", () => {
  it("container -> poll status_code -> media_publish", async () => {
    const m = mockFetch([
      () => json({ id: "1001" }),
      () => json({ status_code: "IN_PROGRESS" }),
      () => json({ status_code: "FINISHED" }),
      () => json({ id: "9009" }),
      () => json({ permalink: "https://www.instagram.com/p/XYZ/" }),
    ]);
    const deps = makeDeps(m.fetch);
    const r = await p.publish({ deps, account }, { post: POST_FIXTURE, text: "caption", imageUrl: IMG });
    expect(r).toEqual({ externalId: "9009", url: "https://www.instagram.com/p/XYZ/" });
    expect(m.calls[0]).toMatchObject({ method: "POST", url: "https://graph.facebook.com/v27.0/IG1/media" });
    expect(formOf(m.calls[0]!)).toEqual({ image_url: IMG, caption: "caption", access_token: SECRET });
    expect(m.calls[1]?.url).toContain("/v27.0/1001?fields=status_code");
    expect(m.calls[3]).toMatchObject({ method: "POST", url: "https://graph.facebook.com/v27.0/IG1/media_publish" });
    expect(formOf(m.calls[3]!)).toEqual({ creation_id: "1001", access_token: SECRET });
    expect(deps.slept).toEqual([5000]);
  });
  it("bounded wait: gives up after the schedule without publishing", async () => {
    const m = mockFetch([() => json({ id: "1001" }), () => json({ status_code: "IN_PROGRESS" })]);
    const deps = makeDeps(m.fetch);
    await expect(p.publish({ deps, account }, { post: POST_FIXTURE, text: "c", imageUrl: IMG })).rejects.toMatchObject({ kind: "transient" });
    expect(deps.slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(5 * 60_000);
    expect(m.calls.some((c) => c.url.includes("media_publish"))).toBe(false);
  });
  it("ERROR / EXPIRED -> validation_rejected", async () => {
    for (const code of ["ERROR", "EXPIRED"]) {
      const m = mockFetch([() => json({ id: "1001" }), () => json({ status_code: code })]);
      await expect(p.publish({ deps: makeDeps(m.fetch), account }, { post: POST_FIXTURE, text: "c", imageUrl: IMG })).rejects.toMatchObject({ kind: "validation_rejected" });
    }
  });
  it("requires a public image URL and times out safely on media_publish", async () => {
    await expect(p.publish({ deps: makeDeps(mockFetch(() => json({})).fetch), account }, { post: POST_FIXTURE, text: "c" })).rejects.toMatchObject({ kind: "validation_rejected" });
    const m = mockFetch([() => json({ id: "1001" }), () => json({ status_code: "FINISHED" }), () => new Error("reset")]);
    await expect(p.publish({ deps: makeDeps(m.fetch), account }, { post: POST_FIXTURE, text: "c", imageUrl: IMG })).rejects.toMatchObject({ kind: "outcome_unknown" });
  });
  it("remove throws a typed not_supported error (API cannot delete) and says why", async () => {
    expect(p.capabilities.delete).toBe(false);
    expect(p.capabilities.notes?.delete).toBeTruthy();
    await expect(p.remove({ deps: makeDeps(mockFetch(() => json({})).fetch), account }, "1")).rejects.toMatchObject({ kind: "not_supported" });
  });
  it("maps Graph errors", async () => {
    const run = (status: number, code: number) =>
      p.publish({ deps: makeDeps(mockFetch(() => json({ error: { message: "m", code } }, { status })).fetch), account }, { post: POST_FIXTURE, text: "c", imageUrl: IMG }).then(() => { throw new Error("expected rejection"); }, (e: unknown) => e as { kind: string });
    expect(await run(400, 190)).toMatchObject({ kind: "auth_expired" });
    expect(await run(400, 4)).toMatchObject({ kind: "rate_limited" });
    expect(await run(400, 10)).toMatchObject({ kind: "permission_missing" });
  });
});

describe("Instagram preflight", () => {
  const img = (over = {}) => ({ mime: "image/jpeg", width: 1080, height: 1080, sizeBytes: 500_000, ...over });
  const errs = (input: Parameters<typeof p.preflight>[0]) => p.preflight(input).filter((c) => c.status === "error").map((c) => c.id).sort();
  it("passes with a public https JPEG", () => {
    expect(errs({ post: POST_FIXTURE, text: "c", imageUrl: IMG, image: img() })).toEqual([]);
  });
  it("requires a public https URL", () => {
    expect(errs({ post: POST_FIXTURE, text: "c", image: img() })).toContain("media.url");
    for (const bad of ["http://cdn.uz/a.jpg", "https://localhost/a.jpg", "https://192.168.1.5/a.jpg", "https://10.0.0.1/a.jpg", "not a url"]) {
      expect(errs({ post: POST_FIXTURE, text: "c", imageUrl: bad, image: img() })).toContain("media.url");
    }
  });
  it("requires JPEG and reports the conversion needed", () => {
    const c = p.preflight({ post: POST_FIXTURE, text: "c", imageUrl: IMG, image: img({ mime: "image/png" }) }).find((x) => x.id === "media.format");
    expect(c?.status).toBe("error");
    expect(c?.message).toContain("JPEG");
  });
  it("checks aspect ratio 4:5..1.91:1, size and width", () => {
    expect(errs({ post: POST_FIXTURE, text: "c", imageUrl: IMG, image: img({ width: 1000, height: 1500 }) })).toContain("media.aspect"); // 0.67
    expect(errs({ post: POST_FIXTURE, text: "c", imageUrl: IMG, image: img({ width: 1910, height: 1000 }) })).not.toContain("media.aspect"); // 1.91
    expect(errs({ post: POST_FIXTURE, text: "c", imageUrl: IMG, image: img({ width: 2100, height: 1000 }) })).toContain("media.aspect");
    expect(errs({ post: POST_FIXTURE, text: "c", imageUrl: IMG, image: img({ width: 800, height: 1000 }) })).not.toContain("media.aspect"); // 0.8
    expect(errs({ post: POST_FIXTURE, text: "c", imageUrl: IMG, image: img({ sizeBytes: 9 * 1024 * 1024 }) })).toContain("media.size");
    expect(p.preflight({ post: POST_FIXTURE, text: "c", imageUrl: IMG, image: img({ width: 2000, height: 2000 }) }).find((c) => c.id === "media.width")?.status).toBe("warn");
  });
  it("explains that links are not clickable, and checks caption and hashtag limits", () => {
    const withUrl = p.preflight({ post: POST_FIXTURE, text: "see https://a.uz", imageUrl: IMG, image: img() }).find((c) => c.id === "text.links");
    expect(withUrl?.status).toBe("warn");
    expect(withUrl?.message).toMatch(/bosilmaydi/);
    expect(p.preflight({ post: POST_FIXTURE, text: "no url", imageUrl: IMG, image: img() }).find((c) => c.id === "text.links")?.message).toMatch(/bosilmaydi/);
    expect(errs({ post: POST_FIXTURE, text: "a".repeat(INSTAGRAM_CAPTION_MAX + 1), imageUrl: IMG, image: img() })).toContain("text.length");
    expect(errs({ post: POST_FIXTURE, text: Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" "), imageUrl: IMG, image: img() })).toContain("text.hashtags");
  });
  it("default caption excludes the URL unless asked; at most 30 hashtags", () => {
    expect(p.renderDefaultText({ ...POST_FIXTURE, tags: [...POST_FIXTURE.tags] })).not.toContain("https://");
    expect(p.renderDefaultText({ ...POST_FIXTURE, tags: [...POST_FIXTURE.tags] }, { includeUrl: true })).toContain(POST_FIXTURE.url);
    const many = Array.from({ length: 50 }, (_, i) => `tag${i}a`);
    expect((p.renderDefaultText({ ...POST_FIXTURE, tags: many }, { maxHashtags: 99 }).match(/#/g) ?? []).length).toBeLessThanOrEqual(30);
  });
});
