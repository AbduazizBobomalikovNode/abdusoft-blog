import { describe, expect, it } from "vitest";
import { buildXTokenRequest, buildXTweetBody, createXProvider, X_TEXT_MAX } from "./providers/x.js";
import { codeChallengeS256 } from "./pkce.js";
import { bodyJson, formOf, json, makeDeps, mockFetch, POST_FIXTURE, SECRET } from "./test-utils.js";
import type { ConnectedAccount } from "./types.js";

const p = createXProvider();
const confidential = { clientId: "cid", clientSecret: "csec", redirectUri: "https://api.example/cb" };
const publicClient = { clientId: "cid", redirectUri: "https://api.example/cb" };
const account: ConnectedAccount = {
  provider: "x", externalId: "42", displayName: "Owner", username: "owner", accessToken: SECRET, refreshToken: "REFRESH-OLD-123456",
  accessTokenExpiresAt: new Date("2026-11-25T12:00:00Z"), refreshTokenExpiresAt: null, scopes: ["tweet.write"],
  issuedAt: new Date("2026-11-25T10:00:00Z"), connectedAt: new Date("2026-11-20T10:00:00Z"),
};
const image = { bytes: new Uint8Array([9, 8, 7]), mime: "image/png", width: 800, height: 400, sizeBytes: 3 };

describe("X auth", () => {
  it("builds a PKCE S256 URL", () => {
    const challenge = codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    const u = new URL(p.auth.buildAuthorizationUrl!({ creds: publicClient, state: "s", codeChallenge: challenge }));
    expect(u.origin + u.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: "code", client_id: "cid", redirect_uri: publicClient.redirectUri, scope: "tweet.read tweet.write users.read media.write offline.access",
      state: "s", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256",
    });
    expect(() => p.auth.buildAuthorizationUrl!({ creds: publicClient, state: "s" })).toThrow();
  });
  it("confidential clients use Basic auth, public clients send client_id", () => {
    const c = buildXTokenRequest(confidential, { grant_type: "refresh_token", refresh_token: "r" });
    expect(c.headers.Authorization).toBe(`Basic ${Buffer.from("cid:csec").toString("base64")}`);
    expect(c.body).not.toContain("client_id");
    const pub = buildXTokenRequest(publicClient, { grant_type: "refresh_token", refresh_token: "r" });
    expect(pub.headers.Authorization).toBeUndefined();
    expect(new URLSearchParams(pub.body).get("client_id")).toBe("cid");
  });
  it("exchanges the code with the verifier and loads /users/me", async () => {
    const m = mockFetch([
      () => json({ access_token: "AT-1234567890", refresh_token: "RT-1234567890", expires_in: 7200, scope: "tweet.read tweet.write" }),
      () => json({ data: { id: "42", name: "Owner", username: "owner" } }),
    ]);
    const acc = await p.auth.exchangeCode!(makeDeps(m.fetch), { creds: confidential, code: "CODE", codeVerifier: "VERIFIER" });
    expect(m.calls[0]).toMatchObject({ method: "POST", url: "https://api.x.com/2/oauth2/token" });
    expect(formOf(m.calls[0]!)).toEqual({ grant_type: "authorization_code", code: "CODE", redirect_uri: confidential.redirectUri, code_verifier: "VERIFIER" });
    expect(m.calls[1]).toMatchObject({ method: "GET", url: "https://api.x.com/2/users/me" });
    expect(acc).toMatchObject({ externalId: "42", username: "owner", refreshToken: "RT-1234567890" });
    expect(acc.accessTokenExpiresAt?.toISOString()).toBe("2026-11-25T12:00:00.000Z");
    await expect(p.auth.exchangeCode!(makeDeps(m.fetch), { creds: confidential, code: "CODE" })).rejects.toMatchObject({ kind: "validation_rejected" });
  });
  it("refresh rotates the refresh token and the caller gets the new one", async () => {
    const m = mockFetch(() => json({ access_token: "AT-NEW-1234567", refresh_token: "RT-NEW-1234567", expires_in: 7200 }));
    const { account: next, refreshTokenRotated } = await p.auth.refresh!(makeDeps(m.fetch), confidential, account);
    expect(refreshTokenRotated).toBe(true);
    expect(formOf(m.calls[0]!)).toEqual({ grant_type: "refresh_token", refresh_token: "REFRESH-OLD-123456" });
    expect(next.refreshToken).toBe("RT-NEW-1234567");
    expect(next.accessToken).toBe("AT-NEW-1234567");
    expect(next.externalId).toBe("42");
    expect(next.accessTokenExpiresAt?.toISOString()).toBe("2026-11-25T12:00:00.000Z");
    // eski refresh token saqlanmaydi, original o'zgarmaydi
    expect(account.refreshToken).toBe("REFRESH-OLD-123456");
  });
  it("keeps the old refresh token when none is returned; invalid_grant -> auth_expired", async () => {
    const m = mockFetch(() => json({ access_token: "AT-NEW-1234567", expires_in: 7200 }));
    const kept = await p.auth.refresh!(makeDeps(m.fetch), confidential, account);
    expect(kept.account.refreshToken).toBe("REFRESH-OLD-123456");
    expect(kept.refreshTokenRotated).toBe(false);
    const bad = mockFetch(() => json({ error: "invalid_request", error_description: "Value passed for the token was invalid." }, { status: 400 }));
    await expect(p.auth.refresh!(makeDeps(bad.fetch), confidential, account)).rejects.toMatchObject({ kind: "auth_expired" });
  });
});

describe("X refresh failures (item 4)", () => {
  const run = (responder: Parameters<typeof mockFetch>[0]) => p.auth.refresh!(makeDeps(mockFetch(responder).fetch), confidential, account).then(() => null, (e: unknown) => e as { kind: string; message: string });
  it("a dropped connection, timeout or 5xx during refresh is refresh_ambiguous (the token may have been rotated)", async () => {
    for (const r of [() => new Error("ECONNRESET"), () => json({ title: "x" }, { status: 500 }), () => json({ title: "x" }, { status: 503 })]) {
      const e = await run(r);
      expect(e).toMatchObject({ kind: "refresh_ambiguous" });
      expect(e?.message).toMatch(/qayta ulang/);
    }
  });
  it("invalid_grant stays auth_expired; the old account object is untouched", async () => {
    expect(await run(() => json({ error: "invalid_request" }, { status: 400 }))).toMatchObject({ kind: "auth_expired" });
    expect(account.refreshToken).toBe("REFRESH-OLD-123456");
  });
});

describe("X publish", () => {
  it("text + link: single POST /2/tweets", async () => {
    const m = mockFetch(() => json({ data: { id: "1900", text: "t" } }, { status: 201 }));
    const r = await p.publish({ deps: makeDeps(m.fetch), account }, { post: POST_FIXTURE, text: "hello https://a.uz" });
    expect(r).toEqual({ externalId: "1900", url: "https://x.com/owner/status/1900" });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]).toMatchObject({ method: "POST", url: "https://api.x.com/2/tweets" });
    expect(m.calls[0]?.headers).toMatchObject({ authorization: `Bearer ${SECRET}`, "content-type": "application/json" });
    expect(bodyJson(m.calls[0]!)).toEqual({ text: "hello https://a.uz" });
  });
  it("image: media upload -> tweet with media_ids", async () => {
    const m = mockFetch([() => json({ data: { id: "MEDIA1", media_key: "3_1" } }), () => json({ data: { id: "7" } }, { status: 201 })]);
    await p.publish({ deps: makeDeps(m.fetch), account }, { post: POST_FIXTURE, text: "t", image });
    expect(m.calls[0]).toMatchObject({ method: "POST", url: "https://api.x.com/2/media/upload" });
    expect(bodyJson(m.calls[0]!)).toEqual({ media: Buffer.from([9, 8, 7]).toString("base64"), media_category: "tweet_image" });
    expect(bodyJson(m.calls[1]!)).toEqual(buildXTweetBody("t", "MEDIA1"));
    expect(bodyJson(m.calls[1]!)).toEqual({ text: "t", media: { media_ids: ["MEDIA1"] } });
  });
  it("polls processing_info only when present, with a bounded wait", async () => {
    const m = mockFetch([
      () => json({ data: { id: "M", processing_info: { state: "pending", check_after_secs: 1 } } }),
      () => json({ data: { id: "M", processing_info: { state: "succeeded" } } }),
      () => json({ data: { id: "9" } }, { status: 201 }),
    ]);
    const deps = makeDeps(m.fetch);
    await p.publish({ deps, account }, { post: POST_FIXTURE, text: "t", image });
    expect(m.calls[1]?.url).toBe("https://api.x.com/2/media/upload?command=STATUS&media_id=M");
    expect(deps.slept).toEqual([1000]);
    const stuck = mockFetch(() => json({ data: { id: "M", processing_info: { state: "in_progress", check_after_secs: 1 } } }));
    await expect(p.publish({ deps: makeDeps(stuck.fetch), account }, { post: POST_FIXTURE, text: "t", image })).rejects.toMatchObject({ kind: "transient" });
    expect(stuck.calls.length).toBeLessThanOrEqual(7);
  });
  it("timeout on the tweet create => outcome_unknown", async () => {
    const m = mockFetch(() => new Error("ECONNRESET"));
    await expect(p.publish({ deps: makeDeps(m.fetch), account }, { post: POST_FIXTURE, text: "t" })).rejects.toMatchObject({ kind: "outcome_unknown" });
  });
});

describe("X error mapping", () => {
  const run = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    p.publish({ deps: makeDeps(mockFetch(() => json(body, { status, headers })).fetch), account }, { post: POST_FIXTURE, text: "t" }).then(() => { throw new Error("expected rejection"); }, (e: unknown) => e as Error & { kind: string; retryAt?: Date });
  it("401 auth_expired", async () => expect(await run(401, { title: "Unauthorized", detail: "Unauthorized", type: "about:blank", status: 401 })).toMatchObject({ kind: "auth_expired" }));
  it("403 permission_missing; duplicate -> duplicate_content", async () => {
    expect(await run(403, { title: "Forbidden", type: "https://api.x.com/2/problems/not-authorized-for-resource", detail: "Not allowed" })).toMatchObject({ kind: "permission_missing" });
    expect(await run(403, { title: "Forbidden", detail: "You are not allowed to create a Tweet with duplicate content." })).toMatchObject({ kind: "duplicate_content" });
  });
  it("402 and usage-capped -> payment_required", async () => {
    expect(await run(402, { title: "CreditsDepleted", detail: "no credits" })).toMatchObject({ kind: "payment_required" });
    expect(await run(429, { title: "UsageCapExceeded", type: "https://api.x.com/2/problems/usage-capped", detail: "Usage cap exceeded" })).toMatchObject({ kind: "payment_required" });
  });
  it("429 -> rate_limited with x-rate-limit-reset", async () => {
    const e = await run(429, { title: "Too Many Requests", type: "https://api.x.com/2/problems/rate-limit-exceeded" }, { "x-rate-limit-reset": "1795000000" });
    expect(e).toMatchObject({ kind: "rate_limited" });
    expect(e.retryAt?.getTime()).toBe(1795000000 * 1000);
  });
  it("400 -> validation_rejected", async () => expect(await run(400, { title: "Invalid Request", detail: "The `text` field is too long" })).toMatchObject({ kind: "validation_rejected" }));
});

describe("X remove, rendering, preflight", () => {
  it("DELETE /2/tweets/:id", async () => {
    const m = mockFetch(() => json({ data: { deleted: true } }));
    await p.remove!({ deps: makeDeps(m.fetch), account }, "123");
    expect(m.calls[0]).toMatchObject({ method: "DELETE", url: "https://api.x.com/2/tweets/123" });
    const no = mockFetch(() => json({ data: { deleted: false } }));
    await expect(p.remove!({ deps: makeDeps(no.fetch), account }, "123")).rejects.toMatchObject({ kind: "validation_rejected" });
  });
  it("default text fits 280 weighted units and keeps the URL", () => {
    const t = p.renderDefaultText({ ...POST_FIXTURE, tags: [...POST_FIXTURE.tags], title: "Sarlavha ".repeat(60) });
    expect(p.measureText(t)).toBeLessThanOrEqual(X_TEXT_MAX);
    expect(t).toContain(POST_FIXTURE.url);
  });
  it("preflight: limit boundaries, URL cost warning, image checks", () => {
    const at = p.preflight({ post: POST_FIXTURE, text: "a".repeat(280) }).find((c) => c.id === "text.length");
    expect(at?.status).toBe("warn");
    expect(p.preflight({ post: POST_FIXTURE, text: "a".repeat(200) }).find((c) => c.id === "text.length")?.status).toBe("ok");
    expect(p.preflight({ post: POST_FIXTURE, text: "a".repeat(281) }).find((c) => c.id === "text.length")?.status).toBe("error");
    expect(p.preflight({ post: POST_FIXTURE, text: "x https://a.uz" }).find((c) => c.id === "config.cost")?.status).toBe("warn");
    expect(p.preflight({ post: POST_FIXTURE, text: "plain" }).some((c) => c.id === "config.cost")).toBe(false);
    const bad = p.preflight({ post: POST_FIXTURE, text: "x", image: { mime: "image/heic", width: 1, height: 1, sizeBytes: 6 * 1024 * 1024 } });
    expect(bad.filter((c) => c.status === "error").map((c) => c.id)).toEqual(["media.format", "media.size"]);
  });
  it("tokenStatus: access expired but refreshable stays ok", () => {
    expect(p.tokenStatus(account, new Date("2026-11-25T13:00:00Z"))).toMatchObject({ state: "ok", canRefresh: true, refreshDue: true });
  });
});
