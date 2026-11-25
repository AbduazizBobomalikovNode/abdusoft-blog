import { describe, expect, it } from "vitest";
import { buildThreadsContainerParams, createThreadsProvider, threadsLength } from "./providers/threads.js";
import { empty, formOf, json, makeDeps, mockFetch, POST_FIXTURE, SECRET } from "./test-utils.js";
import type { ConnectedAccount } from "./types.js";

const p = createThreadsProvider();
const creds = { clientId: "app", clientSecret: "appsecret", redirectUri: "https://api.example/cb" };
const account: ConnectedAccount = {
  provider: "threads", externalId: "T1", displayName: "Owner", username: "owner", accessToken: SECRET, refreshToken: null,
  accessTokenExpiresAt: new Date("2027-01-01T00:00:00Z"), refreshTokenExpiresAt: null, scopes: [],
  issuedAt: new Date("2026-11-01T00:00:00Z"), connectedAt: new Date("2026-11-01T00:00:00Z"),
};

describe("Threads auth", () => {
  it("builds the authorize URL on threads.com", () => {
    const u = new URL(p.auth.buildAuthorizationUrl!({ creds, state: "s" }));
    expect(u.origin + u.pathname).toBe("https://threads.com/oauth/authorize");
    expect(u.searchParams.get("scope")).toBe("threads_basic,threads_content_publish,threads_delete");
    expect(u.searchParams.get("response_type")).toBe("code");
  });
  it("code -> short token -> long-lived token -> /me", async () => {
    const m = mockFetch([
      () => json({ access_token: "SHORT-123456789", user_id: 77 }),
      () => json({ access_token: "LONG-123456789", token_type: "bearer", expires_in: 5184000 }),
      () => json({ id: "77", username: "owner", name: "Owner" }),
    ]);
    const acc = await p.auth.exchangeCode!(makeDeps(m.fetch), { creds, code: "CODE" });
    expect(m.calls[0]).toMatchObject({ method: "POST", url: "https://graph.threads.com/oauth/access_token" });
    expect(formOf(m.calls[0]!)).toEqual({ client_id: "app", client_secret: "appsecret", code: "CODE", grant_type: "authorization_code", redirect_uri: creds.redirectUri });
    const long = new URL(m.calls[1]!.url);
    expect(long.origin + long.pathname).toBe("https://graph.threads.com/access_token");
    expect(Object.fromEntries(long.searchParams)).toEqual({ grant_type: "th_exchange_token", client_secret: "appsecret", access_token: "SHORT-123456789" });
    expect(m.calls[2]?.url).toContain("https://graph.threads.com/v1.0/me?");
    expect(acc).toMatchObject({ externalId: "77", username: "owner", accessToken: "LONG-123456789" });
    expect(acc.accessTokenExpiresAt?.toISOString()).toBe("2027-01-24T10:00:00.000Z");
  });
  it("refresh uses th_refresh_token and resets the clock", async () => {
    const m = mockFetch(() => json({ access_token: "LONG-NEW-123456", expires_in: 5184000 }));
    const next = await p.auth.refresh!(makeDeps(m.fetch), creds, account);
    const u = new URL(m.calls[0]!.url);
    expect(u.pathname).toBe("/refresh_access_token");
    expect(Object.fromEntries(u.searchParams)).toEqual({ grant_type: "th_refresh_token", access_token: SECRET });
    expect(next).toMatchObject({ accessToken: "LONG-NEW-123456", externalId: "T1", username: "owner" });
    expect(next.issuedAt.toISOString()).toBe("2026-11-25T10:00:00.000Z");
  });
});

describe("Threads publish", () => {
  it("text with link_attachment: container -> status -> publish -> permalink", async () => {
    const m = mockFetch([
      () => json({ id: "C1" }),
      () => json({ id: "C1", status: "FINISHED" }),
      () => json({ id: "M1" }),
      () => json({ id: "M1", permalink: "https://www.threads.com/@owner/post/ABC" }),
    ]);
    const r = await p.publish({ deps: makeDeps(m.fetch), account }, { post: POST_FIXTURE, text: "Salom" });
    expect(r).toEqual({ externalId: "M1", url: "https://www.threads.com/@owner/post/ABC" });
    expect(m.calls[0]).toMatchObject({ method: "POST", url: "https://graph.threads.com/v1.0/T1/threads" });
    expect(formOf(m.calls[0]!)).toEqual({ media_type: "TEXT", text: "Salom", link_attachment: POST_FIXTURE.url, access_token: SECRET });
    expect(m.calls[1]?.method).toBe("GET");
    expect(m.calls[1]?.url).toContain("/v1.0/C1?");
    expect(m.calls[2]).toMatchObject({ method: "POST", url: "https://graph.threads.com/v1.0/T1/threads_publish" });
    expect(formOf(m.calls[2]!)).toEqual({ creation_id: "C1", access_token: SECRET });
  });
  it("image post: media_type IMAGE with image_url and no link_attachment", () => {
    expect(buildThreadsContainerParams({ text: "t", linkUrl: "https://a.uz", imageUrl: "https://cdn.uz/i.jpg", accessToken: "x" })).toEqual({ media_type: "IMAGE", image_url: "https://cdn.uz/i.jpg", text: "t", access_token: "x" });
  });
  it("polls with a bounded schedule while IN_PROGRESS", async () => {
    const m = mockFetch([() => json({ id: "C1" }), () => json({ status: "IN_PROGRESS" }), () => json({ status: "IN_PROGRESS" }), () => json({ status: "FINISHED" }), () => json({ id: "M1" }), () => json({})]);
    const deps = makeDeps(m.fetch);
    await p.publish({ deps, account }, { post: POST_FIXTURE, text: "t" });
    expect(deps.slept).toEqual([5000, 60000]);
    const never = mockFetch([() => json({ id: "C1" }), () => json({ status: "IN_PROGRESS" })]);
    const d2 = makeDeps(never.fetch);
    await expect(p.publish({ deps: d2, account }, { post: POST_FIXTURE, text: "t" })).rejects.toMatchObject({ kind: "transient" });
    expect(d2.slept).toEqual([5000, 60000, 60000, 60000, 60000]);
    expect(never.calls.some((c) => c.url.endsWith("threads_publish"))).toBe(false);
  });
  it("ERROR container status -> validation_rejected", async () => {
    const m = mockFetch([() => json({ id: "C1" }), () => json({ status: "ERROR", error_message: "bad" })]);
    await expect(p.publish({ deps: makeDeps(m.fetch), account }, { post: POST_FIXTURE, text: "t" })).rejects.toMatchObject({ kind: "validation_rejected", platformMessage: "bad" });
  });
  it("timeout on threads_publish => outcome_unknown", async () => {
    const m = mockFetch([() => json({ id: "C1" }), () => json({ status: "FINISHED" }), () => new Error("timeout")]);
    await expect(p.publish({ deps: makeDeps(m.fetch), account }, { post: POST_FIXTURE, text: "t" })).rejects.toMatchObject({ kind: "outcome_unknown" });
  });
  it("a missing permalink does not fail an already-published post", async () => {
    const m = mockFetch([() => json({ id: "C1" }), () => json({ status: "FINISHED" }), () => json({ id: "M1" }), () => json({ error: { message: "x", code: 100 } }, { status: 400 })]);
    expect(await p.publish({ deps: makeDeps(m.fetch), account }, { post: POST_FIXTURE, text: "t" })).toEqual({ externalId: "M1", url: null });
  });
  it("DELETE with access_token query", async () => {
    const m = mockFetch(() => json({ success: true, deleted_id: "M1" }));
    await p.remove!({ deps: makeDeps(m.fetch), account }, "M1");
    expect(m.calls[0]).toMatchObject({ method: "DELETE", url: `https://graph.threads.com/v1.0/M1?access_token=${SECRET}` });
  });
});

describe("Threads error mapping", () => {
  const run = (status: number, body: unknown) =>
    p.publish({ deps: makeDeps(mockFetch(() => json(body, { status })).fetch), account }, { post: POST_FIXTURE, text: "t" }).then(() => { throw new Error("expected rejection"); }, (e: unknown) => e as Error & { kind: string });
  const g = (code: number, message = "m", sub?: number) => ({ error: { message, type: "OAuthException", code, error_subcode: sub, fbtrace_id: "x" } });
  it("190 -> auth_expired", async () => expect(await run(400, g(190, "Error validating access token", 463))).toMatchObject({ kind: "auth_expired" }));
  it("4/17 -> rate_limited", async () => {
    expect(await run(400, g(4))).toMatchObject({ kind: "rate_limited" });
    expect(await run(400, g(17))).toMatchObject({ kind: "rate_limited" });
  });
  it("10 and 200-299 -> permission_missing", async () => {
    expect(await run(400, g(10))).toMatchObject({ kind: "permission_missing" });
    expect(await run(403, g(200))).toMatchObject({ kind: "permission_missing" });
  });
  it("1/2 -> transient; other 400 -> validation_rejected with message", async () => {
    expect(await run(500, g(2))).toMatchObject({ kind: "transient" });
    expect(await run(400, g(100, "Invalid parameter"))).toMatchObject({ kind: "validation_rejected", platformMessage: "Invalid parameter" });
  });
  it("duplicate message -> duplicate_content", async () => expect(await run(400, g(100, "Duplicate post"))).toMatchObject({ kind: "duplicate_content" }));
});

describe("Threads text and preflight", () => {
  it("counts emoji as UTF-8 bytes at the 500 boundary", () => {
    expect(threadsLength("a".repeat(500))).toBe(500);
    expect(threadsLength("a".repeat(497) + "😀")).toBe(501);
    const pf = (text: string) => p.preflight({ post: POST_FIXTURE, text }).find((c) => c.id === "text.length")?.status;
    expect(pf("a".repeat(500))).toBe("warn");
    expect(pf("a".repeat(496) + "😀")).toBe("warn");
    expect(pf("a".repeat(497) + "😀")).toBe("error");
    expect(pf("a".repeat(100))).toBe("ok");
  });
  it("default text has no URL (link goes into link_attachment) and fits", () => {
    const t = p.renderDefaultText({ ...POST_FIXTURE, tags: [], title: "x".repeat(900) });
    expect(threadsLength(t)).toBeLessThanOrEqual(500);
    expect(t).not.toContain("http");
  });
  it("image preflight: public https url, jpeg/png, ratio, width", () => {
    const bad = p.preflight({ post: POST_FIXTURE, text: "x", imageUrl: "http://localhost/i.jpg", image: { mime: "image/webp", width: 100, height: 2000, sizeBytes: 9 * 1024 * 1024 } });
    expect(bad.filter((c) => c.status === "error").map((c) => c.id).sort()).toEqual(["media.aspect", "media.format", "media.size", "media.url", "media.width"]);
    const ok = p.preflight({ post: POST_FIXTURE, text: "x", imageUrl: "https://cdn.abdusoft.uz/i.jpg", image: { mime: "image/jpeg", width: 1000, height: 800, sizeBytes: 1000 } });
    expect(ok.filter((c) => c.status === "error")).toEqual([]);
    expect(empty(204).status).toBe(204);
  });
});
