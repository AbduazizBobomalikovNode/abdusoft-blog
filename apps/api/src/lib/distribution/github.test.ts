import { describe, expect, it } from "vitest";
import { createGithubProvider, GITHUB_DEFAULT_END_MARKER as END, GITHUB_DEFAULT_START_MARKER as START, renderReadmeItem, renderReadmeList, spliceMarkedBlock } from "./providers/github.js";
import { bodyJson, json, makeDeps, mockFetch, POST_FIXTURE, SECRET } from "./test-utils.js";
import type { ConnectedAccount, DistributionPost } from "./types.js";

const account: ConnectedAccount = {
  provider: "github", externalId: "owner", displayName: "Owner", username: "owner", accessToken: SECRET, refreshToken: null,
  accessTokenExpiresAt: null, refreshTokenExpiresAt: null, scopes: [], issuedAt: new Date("2026-11-01T00:00:00Z"), connectedAt: new Date("2026-11-01T00:00:00Z"),
  meta: { owner: "owner", repo: "owner" },
};
const posts: DistributionPost[] = [
  { title: "Birinchi [maqola]", excerpt: null, url: "https://abdusoft.uz/blog/a(1)", tags: [], publishedAt: new Date("2026-11-20T00:00:00Z") },
  { title: "Ikkinchi", excerpt: null, url: "https://abdusoft.uz/blog/b", tags: [], publishedAt: new Date("2026-11-10T00:00:00Z") },
  { title: "Uchinchi", excerpt: null, url: "https://abdusoft.uz/blog/c", tags: [], publishedAt: null },
];
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
const file = (content: string | Buffer, sha = "sha1") => ({ type: "file", encoding: "base64", sha, size: content.length, content: b64(content).replace(/(.{60})/g, "$1\n") });

describe("README rendering", () => {
  it("renders title, link and date; escapes markdown and parens", () => {
    expect(renderReadmeItem(posts[0]!)).toBe("- [Birinchi \\[maqola\\]](https://abdusoft.uz/blog/a%281%29) — 20.11.2026");
    expect(renderReadmeItem(posts[2]!)).toBe("- [Uchinchi](https://abdusoft.uz/blog/c)");
    expect(renderReadmeList(posts, 2).split("\n")).toHaveLength(2);
  });
});

describe("spliceMarkedBlock", () => {
  const list = "- [A](https://a.uz)";
  it("replaces only between the markers, leaving every other byte intact", () => {
    const head = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# Salom\r\n\r\nintro  \r\n")]);
    const tail = Buffer.from("\r\n## Boshqa\r\n\ttab  é\r\nso'ngi qator");
    const orig = Buffer.concat([head, Buffer.from(`${START}\r\neski\r\n${END}`), tail]);
    const out = spliceMarkedBlock(orig, list, { startMarker: START, endMarker: END });
    expect(out.changed).toBe(true);
    expect(out.content.subarray(0, head.length + START.length).equals(Buffer.concat([head, Buffer.from(START)]))).toBe(true);
    expect(out.content.subarray(out.content.length - tail.length - END.length).equals(Buffer.concat([Buffer.from(END), tail]))).toBe(true);
    expect(out.content.toString("utf8")).toContain(`${START}\r\n${list}\r\n${END}`);
  });
  it("is a no-op when the list is already current", () => {
    const orig = Buffer.from(`x\n${START}\n${list}\n${END}\ny\n`);
    expect(spliceMarkedBlock(orig, list, { startMarker: START, endMarker: END }).changed).toBe(false);
  });
  it("errors when markers are missing unless creation is requested", () => {
    const orig = Buffer.from("# Title\n\ntext\n");
    expect(() => spliceMarkedBlock(orig, list, { startMarker: START, endMarker: END })).toThrow(/markerlari yo'q/);
    expect(() => spliceMarkedBlock(Buffer.from(`${START}\nonly`), list, { startMarker: START, endMarker: END })).toThrow();
    expect(() => spliceMarkedBlock(Buffer.from(`${START}${END}${START}${END}`), list, { startMarker: START, endMarker: END })).toThrow(/bir necha/);
  });
  it("creates markers at start, end, or after a given line", () => {
    const orig = Buffer.from("# Title\n\n## Latest\nrest\n");
    const run = (createAt: Parameters<typeof spliceMarkedBlock>[2]["createAt"]) => spliceMarkedBlock(orig, list, { startMarker: START, endMarker: END, createAt }).content.toString();
    expect(run("start")).toBe(`${START}\n${list}\n${END}\n${orig}`);
    expect(run("end")).toBe(`${orig}\n${START}\n${list}\n${END}\n`);
    const after = run({ afterLine: "## Latest" });
    expect(after.startsWith("# Title\n\n## Latest\n")).toBe(true);
    expect(after).toContain(`${START}\n${list}\n${END}\n`);
    expect(after.endsWith("rest\n")).toBe(true);
    expect(() => run({ afterLine: "## Missing" })).toThrow(/topilmadi/);
  });
});

describe("GitHub connect", () => {
  it("validates a pasted token via /user with the documented headers", async () => {
    const m = mockFetch(() => json({ login: "owner", id: 1, name: null }, { headers: { "github-authentication-token-expiration": "2026-12-25 10:00:00 UTC" } }));
    const acc = await createGithubProvider().auth.connectWithToken!(makeDeps(m.fetch), SECRET);
    expect(m.calls[0]).toMatchObject({ method: "GET", url: "https://api.github.com/user" });
    expect(m.calls[0]?.headers).toMatchObject({ authorization: `Bearer ${SECRET}`, accept: "application/vnd.github+json", "x-github-api-version": "2026-03-10", "user-agent": "blog-distribution" });
    expect(acc).toMatchObject({ externalId: "owner", displayName: "owner", meta: { owner: "owner", repo: "owner" } });
    expect(acc.accessTokenExpiresAt).toBeInstanceOf(Date);
  });
  it("401 -> auth_expired", async () => {
    const m = mockFetch(() => json({ message: "Bad credentials" }, { status: 401 }));
    await expect(createGithubProvider().auth.connectWithToken!(makeDeps(m.fetch), SECRET)).rejects.toMatchObject({ kind: "auth_expired" });
  });
});

describe("GitHub publish", () => {
  const orig = `# Salom\n\n${START}\neski\n${END}\n\nqolgan qism\n`;
  it("reads the file then PUTs with sha, base64 content and unchanged rest", async () => {
    const m = mockFetch([() => json(file(orig, "SHA-A")), () => json({ content: { sha: "SHA-B" }, commit: { sha: "COMMIT1", html_url: "https://github.com/owner/owner/commit/COMMIT1" } })]);
    const r = await createGithubProvider({ limit: 2 }).publish({ deps: makeDeps(m.fetch), account }, { post: posts[0]!, text: "", latestPosts: posts });
    expect(r).toEqual({ externalId: "COMMIT1", url: "https://github.com/owner/owner/commit/COMMIT1" });
    expect(m.calls[0]).toMatchObject({ method: "GET", url: "https://api.github.com/repos/owner/owner/contents/README.md" });
    expect(m.calls[1]).toMatchObject({ method: "PUT", url: "https://api.github.com/repos/owner/owner/contents/README.md" });
    const body = bodyJson(m.calls[1]!) as { sha: string; content: string; message: string };
    expect(body.sha).toBe("SHA-A");
    const written = Buffer.from(body.content, "base64").toString();
    expect(written).toBe(`# Salom\n\n${START}\n${renderReadmeList(posts, 2)}\n${END}\n\nqolgan qism\n`);
  });
  it("does not PUT when nothing changes", async () => {
    const list = renderReadmeList(posts, 5);
    const m = mockFetch(() => json(file(`${START}\n${list}\n${END}\n`, "SHA-A")));
    const r = await createGithubProvider().publish({ deps: makeDeps(m.fetch), account }, { post: posts[0]!, text: "", latestPosts: posts });
    expect(m.calls).toHaveLength(1);
    expect(r.externalId).toBe("SHA-A");
  });
  it("re-reads once on a sha conflict (409) and succeeds", async () => {
    const m = mockFetch([() => json(file(orig, "SHA-A")), () => json({ message: "conflict" }, { status: 409 }), () => json(file(orig + "yangi\n", "SHA-B")), () => json({ commit: { sha: "C2" } })]);
    const r = await createGithubProvider().publish({ deps: makeDeps(m.fetch), account }, { post: posts[0]!, text: "", latestPosts: posts });
    expect(r.externalId).toBe("C2");
    expect((bodyJson(m.calls[3]!) as { sha: string }).sha).toBe("SHA-B");
    expect(Buffer.from((bodyJson(m.calls[3]!) as { content: string }).content, "base64").toString()).toContain("yangi\n");
  });
  it("gives up after the second conflict with a transient error", async () => {
    const m = mockFetch([() => json(file(orig, "A")), () => json({}, { status: 409 }), () => json(file(orig, "B")), () => json({}, { status: 422 })]);
    await expect(createGithubProvider().publish({ deps: makeDeps(m.fetch), account }, { post: posts[0]!, text: "", latestPosts: posts })).rejects.toMatchObject({ kind: "transient" });
    expect(m.calls).toHaveLength(4);
  });
  it("creates markers only when asked", async () => {
    const plain = "# Hi\n";
    const no = mockFetch(() => json(file(plain)));
    await expect(createGithubProvider().publish({ deps: makeDeps(no.fetch), account }, { post: posts[0]!, text: "", latestPosts: posts })).rejects.toMatchObject({ kind: "validation_rejected" });
    expect(no.calls).toHaveLength(1);
    const yes = mockFetch([() => json(file(plain)), () => json({ commit: { sha: "C" } })]);
    await createGithubProvider({ createMarkersAt: "end" }).publish({ deps: makeDeps(yes.fetch), account }, { post: posts[0]!, text: "", latestPosts: posts });
    expect(Buffer.from((bodyJson(yes.calls[1]!) as { content: string }).content, "base64").toString()).toContain(START);
  });
  it("custom repo/path/branch/markers", async () => {
    const m = mockFetch([() => json(file("<!--S-->\n<!--E-->\n")), () => json({ commit: { sha: "C" } })]);
    await createGithubProvider({ repo: "profile", path: "docs/README.md", branch: "main", startMarker: "<!--S-->", endMarker: "<!--E-->" }).publish({ deps: makeDeps(m.fetch), account }, { post: posts[0]!, text: "", latestPosts: posts });
    expect(m.calls[0]?.url).toBe("https://api.github.com/repos/owner/profile/contents/docs/README.md?ref=main");
    expect((bodyJson(m.calls[1]!) as { branch: string }).branch).toBe("main");
  });
  it("rejects big (>1MB) files and maps errors", async () => {
    const big = mockFetch(() => json({ sha: "S", encoding: "none", content: "", size: 2_000_000 }));
    await expect(createGithubProvider().publish({ deps: makeDeps(big.fetch), account }, { post: posts[0]!, text: "", latestPosts: posts })).rejects.toMatchObject({ kind: "validation_rejected" });
    const run = (status: number, headers: Record<string, string> = {}, message = "m") =>
      createGithubProvider().publish({ deps: makeDeps(mockFetch(() => json({ message }, { status, headers })).fetch), account }, { post: posts[0]!, text: "", latestPosts: posts }).then(() => { throw new Error("expected rejection"); }, (e: unknown) => e as { kind: string; retryAt?: Date });
    expect(await run(401, {}, "Bad credentials")).toMatchObject({ kind: "auth_expired" });
    expect(await run(403)).toMatchObject({ kind: "permission_missing" });
    expect(await run(404)).toMatchObject({ kind: "permission_missing" });
    const rl = await run(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1795000000" });
    expect(rl).toMatchObject({ kind: "rate_limited" });
    expect(rl.retryAt?.getTime()).toBe(1795000000_000);
    expect((await run(429, { "retry-after": "60" })).retryAt?.toISOString()).toBe("2026-11-25T10:01:00.000Z");
  });
  it("preflight reports missing markers", () => {
    const p = createGithubProvider();
    expect(p.preflight({ post: POST_FIXTURE, currentReadme: "# x" }).find((c) => c.id === "config.markers")?.status).toBe("error");
    expect(p.preflight({ post: POST_FIXTURE, currentReadme: `${START}${END}` }).find((c) => c.id === "config.markers")?.status).toBe("ok");
  });
});
