import { describe, expect, it } from "vitest";
import { createLinkedInProvider, buildLinkedInPostBody, escapeLittle, LINKEDIN_API_VERSION, LINKEDIN_POSTS_URL } from "./providers/linkedin.js";
import { bodyJson, bodyText, empty, formOf, json, makeDeps, mockFetch, POST_FIXTURE, SECRET } from "./test-utils.js";
import type { ConnectedAccount, ImageInput } from "./types.js";

const account: ConnectedAccount = {
  provider: "linkedin", externalId: "abc123", displayName: "Owner", accessToken: SECRET, refreshToken: null,
  accessTokenExpiresAt: new Date("2027-01-01T00:00:00Z"), refreshTokenExpiresAt: null, scopes: ["w_member_social"],
  issuedAt: new Date("2026-11-01T00:00:00Z"), connectedAt: new Date("2026-11-01T00:00:00Z"),
};
const image: ImageInput = { bytes: new Uint8Array([1, 2, 3]), mime: "image/jpeg", width: 1200, height: 630, sizeBytes: 3 };
const p = createLinkedInProvider();
const UPLOAD = "https://www.linkedin.com/dms-uploads/C4E/uploaded-image/0?ca=x";

describe("LinkedIn auth", () => {
  const creds = { clientId: "cid", clientSecret: "csecret", redirectUri: "https://api.example/cb" };
  it("builds the authorization URL", () => {
    const u = new URL(p.auth.buildAuthorizationUrl!({ creds, state: "st" }));
    expect(u.origin + u.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(Object.fromEntries(u.searchParams)).toEqual({ response_type: "code", client_id: "cid", redirect_uri: creds.redirectUri, state: "st", scope: "openid profile w_member_social" });
  });
  it("exchanges the code and reads userinfo", async () => {
    const m = mockFetch([
      () => json({ access_token: "AT-xyz-123456", expires_in: 5184000, scope: "openid,profile,w_member_social" }),
      () => json({ sub: "782bbtaQ", name: "John Doe" }),
    ]);
    const deps = makeDeps(m.fetch);
    const acc = await p.auth.exchangeCode!(deps, { creds, code: "thecode" });
    expect(m.calls[0]).toMatchObject({ method: "POST", url: "https://www.linkedin.com/oauth/v2/accessToken" });
    expect(m.calls[0]?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(formOf(m.calls[0]!)).toEqual({ grant_type: "authorization_code", code: "thecode", client_id: "cid", client_secret: "csecret", redirect_uri: creds.redirectUri });
    expect(m.calls[1]).toMatchObject({ method: "GET", url: "https://api.linkedin.com/v2/userinfo" });
    expect(m.calls[1]?.headers.authorization).toBe("Bearer AT-xyz-123456");
    expect(acc).toMatchObject({ provider: "linkedin", externalId: "782bbtaQ", displayName: "John Doe", accessToken: "AT-xyz-123456", refreshToken: null });
    expect(acc.accessTokenExpiresAt?.toISOString()).toBe("2027-01-24T10:00:00.000Z"); // +60 kun
    expect(acc.scopes).toEqual(["openid", "profile", "w_member_social"]);
  });
  it("maps an invalid code to auth_expired without leaking secrets", async () => {
    const m = mockFetch(() => json({ error: "invalid_request", error_description: "authorization code not found csecret" }, { status: 401 }));
    const e = await p.auth.exchangeCode!(makeDeps(m.fetch), { creds, code: "thecode" }).then(() => { throw new Error("expected rejection"); }, (x: unknown) => x as Error);
    expect(e).toMatchObject({ kind: "auth_expired" });
    expect(JSON.stringify(e) + (e as Error).message).not.toContain("csecret");
  });
});

describe("LinkedIn request builders", () => {
  it("escapes reserved little characters", () => {
    expect(escapeLittle("a_b *c* (d) #tag [x] {y} ~ | < > @ \\")).toBe("a\\_b \\*c\\* \\(d\\) \\#tag \\[x\\] \\{y\\} \\~ \\| \\< \\> \\@ \\\\");
  });
  it("builds the documented article body", () => {
    expect(buildLinkedInPostBody({ authorUrn: "urn:li:person:abc", commentary: "hi", article: { source: "https://a.uz/p", title: "T", description: "D", thumbnailUrn: "urn:li:image:X" } })).toEqual({
      author: "urn:li:person:abc", commentary: "hi", visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      content: { article: { source: "https://a.uz/p", title: "T", description: "D", thumbnail: "urn:li:image:X" } },
      lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false,
    });
  });
});

describe("LinkedIn publish", () => {
  it("article: initializeUpload -> PUT bytes -> POST post, with version headers", async () => {
    const m = mockFetch([
      () => json({ value: { uploadUrl: UPLOAD, image: "urn:li:image:C4E10", uploadUrlExpiresAt: 1 } }),
      () => empty(201),
      () => empty(201, { "x-restli-id": "urn:li:share:6844785523593134080" }),
    ]);
    const r = await p.publish({ deps: makeDeps(m.fetch), account }, { post: POST_FIXTURE, text: "Salom_dunyo #x", image, linkMode: "article" });
    expect(r).toEqual({ externalId: "urn:li:share:6844785523593134080", url: "https://www.linkedin.com/feed/update/urn:li:share:6844785523593134080/" });
    const [init, up, post] = m.calls;
    expect(init).toMatchObject({ method: "POST", url: "https://api.linkedin.com/rest/images?action=initializeUpload" });
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${SECRET}`, "linkedin-version": LINKEDIN_API_VERSION, "x-restli-protocol-version": "2.0.0", "content-type": "application/json" });
    expect(bodyJson(init!)).toEqual({ initializeUploadRequest: { owner: "urn:li:person:abc123" } });
    expect(up).toMatchObject({ method: "PUT", url: UPLOAD });
    expect(up?.headers).toMatchObject({ authorization: `Bearer ${SECRET}`, "content-type": "image/jpeg" });
    expect(up?.body).toEqual(image.bytes);
    expect(post).toMatchObject({ method: "POST", url: LINKEDIN_POSTS_URL });
    expect(post?.headers["linkedin-version"]).toBe("202611");
    expect(post?.headers["x-restli-protocol-version"]).toBe("2.0.0");
    const b = bodyJson(post!) as { commentary: string; content: { article: Record<string, string> }; author: string };
    expect(b.author).toBe("urn:li:person:abc123");
    expect(b.commentary).toBe("Salom\\_dunyo \\#x");
    expect(b.content.article).toEqual({ source: POST_FIXTURE.url, title: POST_FIXTURE.title, description: POST_FIXTURE.excerpt, thumbnail: "urn:li:image:C4E10" });
  });
  it("text variant: single POST, URL in commentary, no image calls", async () => {
    const m = mockFetch(() => empty(201, { "x-restli-id": "urn:li:share:1" }));
    await p.publish({ deps: makeDeps(m.fetch), account }, { post: POST_FIXTURE, text: `x ${POST_FIXTURE.url}`, linkMode: "text" });
    expect(m.calls).toHaveLength(1);
    expect(bodyJson(m.calls[0]!).content).toBeUndefined();
  });
  it("custom version is sent", async () => {
    const m = mockFetch(() => empty(201, { "x-restli-id": "urn:li:share:1" }));
    await createLinkedInProvider({ version: "202701" }).publish({ deps: makeDeps(m.fetch), account }, { post: POST_FIXTURE, text: "x", linkMode: "text" });
    expect(m.calls[0]?.headers["linkedin-version"]).toBe("202701");
  });
  it("refuses an upload URL on another host without calling it", async () => {
    const m = mockFetch([() => json({ value: { uploadUrl: "https://evil.example/up", image: "urn:li:image:1" } })]);
    await expect(p.publish({ deps: makeDeps(m.fetch), account }, { post: POST_FIXTURE, text: "x", image })).rejects.toMatchObject({ kind: "validation_rejected" });
    expect(m.calls).toHaveLength(1);
  });
  it("article without an image is rejected before any request", async () => {
    const m = mockFetch(() => json({}));
    await expect(p.publish({ deps: makeDeps(m.fetch), account }, { post: POST_FIXTURE, text: "x" })).rejects.toMatchObject({ kind: "validation_rejected" });
    expect(m.calls).toHaveLength(0);
  });
  it("timeout during the create call => outcome_unknown", async () => {
    const m = mockFetch([() => new Error("socket hang up")]);
    const e = await p.publish({ deps: makeDeps(m.fetch), account }, { post: POST_FIXTURE, text: "x", linkMode: "text" }).then(() => { throw new Error("expected rejection"); }, (x: unknown) => x as Error & { kind: string });
    expect(e.kind).toBe("outcome_unknown");
    expect(e.message).toContain("qayta urinmang");
  });
  it("a 500 on the create call => outcome_unknown, a 500 on image init => transient", async () => {
    const c1 = mockFetch(() => json({ message: "boom" }, { status: 500 }));
    await expect(p.publish({ deps: makeDeps(c1.fetch), account }, { post: POST_FIXTURE, text: "x", linkMode: "text" })).rejects.toMatchObject({ kind: "outcome_unknown" });
    const c2 = mockFetch(() => json({ message: "boom" }, { status: 500 }));
    await expect(p.publish({ deps: makeDeps(c2.fetch), account }, { post: POST_FIXTURE, text: "x", image })).rejects.toMatchObject({ kind: "transient" });
  });
});

describe("LinkedIn error mapping", () => {
  const run = async (status: number, body: unknown, headers: Record<string, string> = {}) => {
    const m = mockFetch(() => json(body, { status, headers }));
    return p.publish({ deps: makeDeps(m.fetch), account }, { post: POST_FIXTURE, text: "x", linkMode: "text" }).then(() => { throw new Error("expected rejection"); }, (x: unknown) => x as Error & { kind: string; retryAt?: Date; platformMessage?: string });
  };
  it("401 -> auth_expired", async () => expect(await run(401, { message: "EMPTY_ACCESS_TOKEN" })).toMatchObject({ kind: "auth_expired" }));
  it("403 -> permission_missing", async () => expect(await run(403, { message: "ACCESS_DENIED", status: 403 })).toMatchObject({ kind: "permission_missing" }));
  it("422 duplicate -> duplicate_content with the platform message", async () => {
    const e = await run(422, { message: "Content is a duplicate of urn:li:share:123", status: 422 });
    expect(e).toMatchObject({ kind: "duplicate_content" });
    expect(e.platformMessage).toContain("duplicate");
  });
  it("429 -> rate_limited, retryAt = next UTC midnight or Retry-After", async () => {
    expect((await run(429, { message: "TOO_MANY_REQUESTS" })).retryAt?.toISOString()).toBe("2026-11-26T00:00:00.000Z");
    expect((await run(429, {}, { "retry-after": "90" })).retryAt?.toISOString()).toBe("2026-11-25T10:01:30.000Z");
  });
  it("400/422 -> validation_rejected with message", async () => {
    expect(await run(400, { message: "FIELD_LENGTH_TOO_LONG" })).toMatchObject({ kind: "validation_rejected", platformMessage: "FIELD_LENGTH_TOO_LONG" });
    expect(await run(422, { message: "UNPROCESSABLE_ENTITY" })).toMatchObject({ kind: "validation_rejected" });
  });
  it("never puts the token in the error", async () => {
    const e = await run(400, { message: `leak ${SECRET}` });
    expect(`${e.message} ${e.platformMessage}`).not.toContain(SECRET);
  });
});

describe("LinkedIn remove", () => {
  it("DELETE with the encoded URN and X-RestLi-Method", async () => {
    const m = mockFetch(() => empty(204));
    await p.remove!({ deps: makeDeps(m.fetch), account }, "urn:li:share:123");
    expect(m.calls[0]).toMatchObject({ method: "DELETE", url: "https://api.linkedin.com/rest/posts/urn%3Ali%3Ashare%3A123" });
    expect(m.calls[0]?.headers).toMatchObject({ "x-restli-method": "DELETE", "linkedin-version": "202611" });
    expect(bodyText(m.calls[0]!)).toBe("");
  });
});

describe("LinkedIn rendering and preflight", () => {
  it("renders title, excerpt and hashtags with Uzbek apostrophes", () => {
    const t = p.renderDefaultText({ ...POST_FIXTURE, tags: [...POST_FIXTURE.tags] });
    expect(t).toContain("Node.jsʼda oʻzbekcha");
    expect(t).toContain("Qisqa tavsif: gʻoya va maʼno.");
    expect(t).toContain("#NodeJs #Ozbek #Backend");
  });
  it("text mode appends the URL and never truncates it", () => {
    const t = p.renderDefaultText({ ...POST_FIXTURE, tags: [], title: "T".repeat(4000) }, {});
    expect(p.measureText(t)).toBeLessThanOrEqual(3000);
    const t2 = createLinkedInProvider().preflight({ post: POST_FIXTURE, linkMode: "text" });
    expect(t2.find((c) => c.id === "text.length")?.status).toBe("ok");
  });
  it("preflight: ok / errors in the Telegram check shape", () => {
    const ok = p.preflight({ post: POST_FIXTURE, image: { mime: "image/jpeg", width: 1200, height: 630, sizeBytes: 100_000 } });
    expect(ok.every((c) => c.status !== "error")).toBe(true);
    for (const c of ok) expect(Object.keys(c).sort()).toEqual(["group", "id", "imageUrl", "limit", "message", "status", "title", "value"]);
    const bad = p.preflight({ post: POST_FIXTURE, text: "x".repeat(3001), image: { mime: "image/webp", width: 10000, height: 10000, sizeBytes: 1 } });
    expect(bad.filter((c) => c.status === "error").map((c) => c.id).sort()).toEqual(["media.format", "media.pixels", "text.length"]);
    expect(p.preflight({ post: POST_FIXTURE }).find((c) => c.id === "media.thumbnail")?.status).toBe("error");
    expect(p.preflight({ post: POST_FIXTURE, linkMode: "text" }).some((c) => c.id === "media.thumbnail")).toBe(false);
  });
  it("token status uses the 60-day rule with a reminder", () => {
    expect(p.tokenStatus({ ...account, accessTokenExpiresAt: new Date("2027-01-24T10:00:00Z") }, new Date("2027-01-20T10:00:00Z")).state).toBe("expiring");
  });
});
