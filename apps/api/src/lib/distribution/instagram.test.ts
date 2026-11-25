import { describe, expect, it } from "vitest";
import { createInstagramProvider, INSTAGRAM_CAPTION_MAX } from "./providers/instagram.js";
import { formOf, json, makeDeps, mockFetch, POST_FIXTURE, SECRET } from "./test-utils.js";
import type { ConnectedAccount } from "./types.js";

const p = createInstagramProvider();
const creds = { clientId: "igapp", clientSecret: "igsecret", redirectUri: "https://api.example/cb" };
const account: ConnectedAccount = {
  provider: "instagram", externalId: "IG1", displayName: "owner", accessToken: SECRET, refreshToken: null,
  accessTokenExpiresAt: new Date("2027-01-01T00:00:00Z"), refreshTokenExpiresAt: null, scopes: [],
  issuedAt: new Date("2026-11-01T00:00:00Z"), connectedAt: new Date("2026-11-01T00:00:00Z"),
};
const IMG = "https://cdn.abdusoft.uz/cover.jpg";

describe("Instagram auth", () => {
  it("authorize URL", () => {
    const u = new URL(p.auth.buildAuthorizationUrl!({ creds, state: "s" }));
    expect(u.origin + u.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(u.searchParams.get("scope")).toBe("instagram_business_basic,instagram_business_content_publish");
  });
  it("exchange handles the data[] wrapper, long-lived token and /me", async () => {
    const m = mockFetch([
      () => json({ data: [{ access_token: "SHORT-1234567", user_id: "99", permissions: "instagram_business_basic" }] }),
      () => json({ access_token: "LONG-1234567", token_type: "bearer", expires_in: 5183944 }),
      () => json({ user_id: "99", username: "owner" }),
    ]);
    const acc = await p.auth.exchangeCode!(makeDeps(m.fetch), { creds, code: "C" });
    expect(m.calls[0]).toMatchObject({ method: "POST", url: "https://api.instagram.com/oauth/access_token" });
    expect(formOf(m.calls[0]!)).toMatchObject({ grant_type: "authorization_code", code: "C", client_secret: "igsecret" });
    const u = new URL(m.calls[1]!.url);
    expect(u.origin + u.pathname).toBe("https://graph.instagram.com/access_token");
    expect(u.searchParams.get("grant_type")).toBe("ig_exchange_token");
    expect(acc).toMatchObject({ externalId: "99", username: "owner", accessToken: "LONG-1234567" });
  });
  it("refresh uses ig_refresh_token", async () => {
    const m = mockFetch(() => json({ access_token: "NEW-TOKEN-12345", expires_in: 5184000 }));
    const { account: next } = await p.auth.refresh!(makeDeps(m.fetch), creds, account);
    expect(new URL(m.calls[0]!.url).searchParams.get("grant_type")).toBe("ig_refresh_token");
    expect(next.accessToken).toBe("NEW-TOKEN-12345");
    expect(next.externalId).toBe("IG1");
  });
});

describe("Instagram publish", () => {
  it("container -> poll status_code -> media_publish", async () => {
    const m = mockFetch([
      () => json({ id: "CT1" }),
      () => json({ status_code: "IN_PROGRESS" }),
      () => json({ status_code: "FINISHED" }),
      () => json({ id: "MEDIA9" }),
      () => json({ permalink: "https://www.instagram.com/p/XYZ/" }),
    ]);
    const deps = makeDeps(m.fetch);
    const r = await p.publish({ deps, account }, { post: POST_FIXTURE, text: "caption", imageUrl: IMG });
    expect(r).toEqual({ externalId: "MEDIA9", url: "https://www.instagram.com/p/XYZ/" });
    expect(m.calls[0]).toMatchObject({ method: "POST", url: "https://graph.instagram.com/v27.0/IG1/media" });
    expect(formOf(m.calls[0]!)).toEqual({ image_url: IMG, caption: "caption", access_token: SECRET });
    expect(m.calls[1]?.url).toContain("/v27.0/CT1?fields=status_code");
    expect(m.calls[3]).toMatchObject({ method: "POST", url: "https://graph.instagram.com/v27.0/IG1/media_publish" });
    expect(formOf(m.calls[3]!)).toEqual({ creation_id: "CT1", access_token: SECRET });
    expect(deps.slept).toEqual([5000]);
  });
  it("bounded wait: gives up after the schedule without publishing", async () => {
    const m = mockFetch([() => json({ id: "CT1" }), () => json({ status_code: "IN_PROGRESS" })]);
    const deps = makeDeps(m.fetch);
    await expect(p.publish({ deps, account }, { post: POST_FIXTURE, text: "c", imageUrl: IMG })).rejects.toMatchObject({ kind: "transient" });
    expect(deps.slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(5 * 60_000);
    expect(m.calls.some((c) => c.url.includes("media_publish"))).toBe(false);
  });
  it("ERROR / EXPIRED -> validation_rejected", async () => {
    for (const code of ["ERROR", "EXPIRED"]) {
      const m = mockFetch([() => json({ id: "CT1" }), () => json({ status_code: code })]);
      await expect(p.publish({ deps: makeDeps(m.fetch), account }, { post: POST_FIXTURE, text: "c", imageUrl: IMG })).rejects.toMatchObject({ kind: "validation_rejected" });
    }
  });
  it("requires a public image URL and times out safely on media_publish", async () => {
    await expect(p.publish({ deps: makeDeps(mockFetch(() => json({})).fetch), account }, { post: POST_FIXTURE, text: "c" })).rejects.toMatchObject({ kind: "validation_rejected" });
    const m = mockFetch([() => json({ id: "CT1" }), () => json({ status_code: "FINISHED" }), () => new Error("reset")]);
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
