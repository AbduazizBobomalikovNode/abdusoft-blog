import { describe, expect, it } from "vitest";
import { createGithubProvider, renderReadmeItem, type GithubPublishInput } from "./providers/github.js";
import { createInstagramProvider } from "./providers/instagram.js";
import { createLinkedInProvider, escapeCommentary, LINKEDIN_UPLOAD_PATH_PREFIX } from "./providers/linkedin.js";
import { createThreadsProvider } from "./providers/threads.js";
import { createXProvider } from "./providers/x.js";
import { assertPublicHttpsUrl, parsePublicHttpsUrl } from "./checks.js";
import { bodyJson, empty, formOf, json, makeDeps, mockFetch, POST_FIXTURE, SECRET } from "./test-utils.js";
import type { ConnectedAccount, ImageInput, PublishInput } from "./types.js";

const acct = (provider: ConnectedAccount["provider"], externalId = "id1"): ConnectedAccount => ({
  provider, externalId, displayName: "O", username: "o", accessToken: SECRET, refreshToken: "RT-1234567890ab", accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null, scopes: [], issuedAt: new Date("2026-11-01T00:00:00Z"), connectedAt: new Date("2026-11-01T00:00:00Z"), meta: { owner: "o", repo: "o" },
});
const image: ImageInput = { bytes: new Uint8Array([1, 2, 3]), mime: "image/jpeg", width: 1200, height: 630, sizeBytes: 3 };
const IMG = "https://cdn.abdusoft.uz/a.jpg";
const bad = (url: string) => ({ ...POST_FIXTURE, tags: [...POST_FIXTURE.tags], url });

describe("URL validation inside publish (item 2)", () => {
  it.each([
    "http://abdusoft.uz/p", "https://localhost/p", "https://127.0.0.1/p", "https://169.254.169.254/latest", "https://10.1.2.3/p", "https://192.168.0.1/p",
    "https://172.16.0.1/p", "https://100.64.0.1/p", "https://0.0.0.0/p", "https://[::1]/p", "https://user:pw@abdusoft.uz/p", "https://abdusoft.uz:8443/p",
    "https://intranet/p", "https://svc.internal/p", "https://abdusoft.uz/p\nHost: evil", "https://abdusoft.uz/ p", "ftp://abdusoft.uz/p", "not a url", "",
  ])("rejects %j", (u) => {
    expect(parsePublicHttpsUrl(u)).toBeNull();
    expect(() => assertPublicHttpsUrl(u, "URL")).toThrow(/ommaviy https/);
  });
  it("accepts public https and returns the normalised href", () => {
    expect(assertPublicHttpsUrl("https://Abdusoft.uz/blog/a b".replace(" ", "%20"), "URL")).toBe("https://abdusoft.uz/blog/a%20b");
  });

  it("Threads and Instagram refuse a metadata-service imageUrl before any request", async () => {
    for (const make of [createThreadsProvider, createInstagramProvider] as const) {
      const m = mockFetch(() => json({ id: "1", status: "FINISHED", status_code: "FINISHED" }));
      await expect(make().publish({ deps: makeDeps(m.fetch), account: acct("threads") }, { post: POST_FIXTURE, text: "t", imageUrl: "http://169.254.169.254/x.jpg" })).rejects.toMatchObject({ kind: "validation_rejected" });
      expect(m.calls).toHaveLength(0);
    }
  });
  it("every provider refuses a bad post.url before any request", async () => {
    const input = (url: string): PublishInput => ({ post: bad(url), text: "t", imageUrl: IMG, image, latestPosts: [bad(url)] });
    for (const [id, make] of [["linkedin", createLinkedInProvider], ["x", createXProvider], ["threads", createThreadsProvider], ["instagram", createInstagramProvider], ["github", createGithubProvider]] as const) {
      const m = mockFetch(() => json({}));
      await expect(make().publish({ deps: makeDeps(m.fetch), account: acct(id) }, input("https://127.0.0.1/p") as GithubPublishInput)).rejects.toMatchObject({ kind: "validation_rejected" });
      expect(m.calls).toHaveLength(0);
    }
  });
  it("GitHub README links come from the parsed href; a newline cannot break out of the list item", async () => {
    expect(() => renderReadmeItem(bad("https://abdusoft.uz/p\n- [evil](https://evil.example)"))).toThrow(/ommaviy https/);
    expect(renderReadmeItem(bad("https://abdusoft.uz/a b?x=(1)".replace(" ", "%20")))).toBe("- [Node.js'da oʻzbekcha matn bilan ishlash](https://abdusoft.uz/a%20b?x=%281%29) — 20.11.2026");
    const m = mockFetch(() => json({}));
    await expect(createGithubProvider().publish({ deps: makeDeps(m.fetch), account: acct("github") }, { post: POST_FIXTURE, text: "", latestPosts: [bad("https://abdusoft.uz/p\nx")] })).rejects.toMatchObject({ kind: "validation_rejected" });
    expect(m.calls).toHaveLength(0);
  });
});

describe("GitHub requires latestPosts (item 7)", () => {
  it("rejects a missing or empty list at runtime, before any request", async () => {
    for (const latestPosts of [undefined, []]) {
      const m = mockFetch(() => json({}));
      await expect(createGithubProvider().publish({ deps: makeDeps(m.fetch), account: acct("github") }, { post: POST_FIXTURE, text: "", latestPosts } as unknown as GithubPublishInput)).rejects.toMatchObject({ kind: "validation_rejected", message: expect.stringContaining("latestPosts") });
      expect(m.calls).toHaveLength(0);
    }
  });
  it("is required at the type level", () => {
    // @ts-expect-error latestPosts is required by GithubProvider.publish
    const bad: GithubPublishInput = { post: POST_FIXTURE, text: "" };
    expect(bad).toBeTruthy();
  });
});

describe("LinkedIn hashtags and upload target (items 6, 8)", () => {
  it("emits #tags plain and escapes reserved characters elsewhere", () => {
    expect(escapeCommentary("Salom_dunyo (x) #NodeJs #Ozbek, 100# *b* ~ @u")).toBe("Salom\\_dunyo \\(x\\) #NodeJs #Ozbek, 100\\# \\*b\\* \\~ \\@u");
    expect(escapeCommentary("a#b")).toBe("a\\#b"); // so'z ichidagi # hashtag emas
    expect(escapeCommentary("https://a.uz/x_y~z")).toBe("https://a.uz/x\\_y\\~z");
    expect(escapeCommentary("#Uzb\\ek")).toBe("#Uzb\\\\ek");
  });
  it("the default text's hashtags reach the API unescaped", async () => {
    const p = createLinkedInProvider();
    const m = mockFetch([() => json({ value: { uploadUrl: "https://www.linkedin.com/dms-uploads/C/x?a=1", image: "urn:li:image:I" } }), () => empty(201), () => empty(201, { "x-restli-id": "urn:li:share:1" })]);
    await p.publish({ deps: makeDeps(m.fetch), account: acct("linkedin") }, { post: POST_FIXTURE, text: p.renderDefaultText({ ...POST_FIXTURE, tags: [...POST_FIXTURE.tags] }), image });
    const commentary = (bodyJson(m.calls[2]!) as { commentary: string }).commentary;
    expect(commentary).toContain("#NodeJs #Ozbek #Backend");
    expect(commentary).not.toContain("\\#");
  });
  it("sends Authorization only to https://www.linkedin.com/dms-uploads/...", async () => {
    expect(LINKEDIN_UPLOAD_PATH_PREFIX).toBe("/dms-uploads/");
    for (const uploadUrl of ["https://api.linkedin.com/dms-uploads/C/x", "https://www.linkedin.com/other/C/x", "https://www.linkedin.com/dms-uploads-evil/x", "http://www.linkedin.com/dms-uploads/x"]) {
      const m = mockFetch([() => json({ value: { uploadUrl, image: "urn:li:image:I" } })]);
      await expect(createLinkedInProvider().publish({ deps: makeDeps(m.fetch), account: acct("linkedin") }, { post: POST_FIXTURE, text: "t", image })).rejects.toMatchObject({ kind: "validation_rejected", step: "init" });
      expect(m.calls).toHaveLength(1); // PUT yuborilmadi
    }
  });
});

describe("step and partial on multi-step failures, and resume (item 5)", () => {
  it("LinkedIn: image uploaded, post failed => step publish + partial.imageUrn; resume skips the upload", async () => {
    const p = createLinkedInProvider();
    const m = mockFetch([() => json({ value: { uploadUrl: "https://www.linkedin.com/dms-uploads/C/x", image: "urn:li:image:I9" } }), () => empty(201), () => json({ message: "boom" }, { status: 500 })]);
    const e = await p.publish({ deps: makeDeps(m.fetch), account: acct("linkedin") }, { post: POST_FIXTURE, text: "t", image }).then(() => null, (x: unknown) => x as { kind: string; step: string; partial: { imageUrn: string } });
    expect(e).toMatchObject({ kind: "outcome_unknown", step: "publish", partial: { imageUrn: "urn:li:image:I9" } });
    const r = mockFetch([() => empty(201, { "x-restli-id": "urn:li:share:2" })]);
    await p.publish({ deps: makeDeps(r.fetch), account: acct("linkedin") }, { post: POST_FIXTURE, text: "t", resume: { imageUrn: "urn:li:image:I9" } });
    expect(r.calls).toHaveLength(1);
    expect(((bodyJson(r.calls[0]!) as { content: { article: { thumbnail: string } } }).content.article.thumbnail)).toBe("urn:li:image:I9");
  });
  it("LinkedIn: an upload failure has step upload and no partial", async () => {
    const m = mockFetch([() => json({ value: { uploadUrl: "https://www.linkedin.com/dms-uploads/C/x", image: "urn:li:image:I" } }), () => json({ message: "bad" }, { status: 400 })]);
    const e = await createLinkedInProvider().publish({ deps: makeDeps(m.fetch), account: acct("linkedin") }, { post: POST_FIXTURE, text: "t", image }).then(() => null, (x: unknown) => x as { step: string; partial?: unknown });
    expect(e).toMatchObject({ step: "upload" });
    expect(e?.partial).toBeUndefined();
  });
  it("X: media uploaded, tweet failed => step publish + partial.mediaId; resume skips the upload", async () => {
    const p = createXProvider();
    const m = mockFetch([() => json({ data: { id: "MEDIA7" } }), () => json({ title: "boom" }, { status: 503 })]);
    const e = await p.publish({ deps: makeDeps(m.fetch), account: acct("x") }, { post: POST_FIXTURE, text: "t", image }).then(() => null, (x: unknown) => x as { kind: string; step: string; partial: { mediaId: string } });
    expect(e).toMatchObject({ kind: "outcome_unknown", step: "publish", partial: { mediaId: "MEDIA7" } });
    const r = mockFetch([() => json({ data: { id: "TW1" } }, { status: 201 })]);
    await p.publish({ deps: makeDeps(r.fetch), account: acct("x") }, { post: POST_FIXTURE, text: "t", image, resume: { mediaId: "MEDIA7" } });
    expect(r.calls).toHaveLength(1);
    expect(bodyJson(r.calls[0]!)).toEqual({ text: "t", media: { media_ids: ["MEDIA7"] } });
  });
  it("X: a media upload failure is step media", async () => {
    const m = mockFetch(() => json({ title: "bad" }, { status: 400 }));
    await expect(createXProvider().publish({ deps: makeDeps(m.fetch), account: acct("x") }, { post: POST_FIXTURE, text: "t", image })).rejects.toMatchObject({ step: "media" });
  });
  it("Threads: poll timeout and publish failure carry partial.containerId; resume publishes the same container", async () => {
    const p = createThreadsProvider();
    const stuck = mockFetch([() => json({ id: "CT1" }), () => json({ status: "IN_PROGRESS" })]);
    const e1 = await p.publish({ deps: makeDeps(stuck.fetch), account: acct("threads") }, { post: POST_FIXTURE, text: "t" }).then(() => null, (x: unknown) => x as { step: string; kind: string; partial: { containerId: string } });
    expect(e1).toMatchObject({ kind: "transient", step: "poll", partial: { containerId: "CT1" } });
    const r = mockFetch([() => json({ status: "FINISHED" }), () => json({ id: "M1" }), () => json({})]);
    await p.publish({ deps: makeDeps(r.fetch), account: acct("threads") }, { post: POST_FIXTURE, text: "t", resume: { containerId: "CT1" } });
    expect(r.calls.some((c) => c.url.endsWith("/threads"))).toBe(false); // yangi konteyner yaratilmadi
    expect(formOf(r.calls[1]!)).toMatchObject({ creation_id: "CT1" });
  });
  it("Instagram: container created, publish failed => step publish + partial; resume works without an image URL", async () => {
    const p = createInstagramProvider();
    const m = mockFetch([() => json({ id: "CT2" }), () => json({ status_code: "FINISHED" }), () => json({ error: { code: 2 } }, { status: 500 })]);
    const e = await p.publish({ deps: makeDeps(m.fetch), account: acct("instagram") }, { post: POST_FIXTURE, text: "c", imageUrl: IMG }).then(() => null, (x: unknown) => x as { step: string; partial: { containerId: string } });
    expect(e).toMatchObject({ step: "publish", partial: { containerId: "CT2" } });
    const r = mockFetch([() => json({ status_code: "FINISHED" }), () => json({ id: "MEDIA1" }), () => json({})]);
    const out = await p.publish({ deps: makeDeps(r.fetch), account: acct("instagram") }, { post: POST_FIXTURE, text: "c", resume: { containerId: "CT2" } });
    expect(out.externalId).toBe("MEDIA1");
    expect(r.calls.some((c) => c.url.endsWith("/media"))).toBe(false);
    expect(formOf(r.calls[1]!)).toMatchObject({ creation_id: "CT2" });
  });
  it("a container reported PUBLISHED on resume is outcome_unknown, never re-published", async () => {
    const r = mockFetch([() => json({ status_code: "PUBLISHED" })]);
    await expect(createInstagramProvider().publish({ deps: makeDeps(r.fetch), account: acct("instagram") }, { post: POST_FIXTURE, text: "c", resume: { containerId: "CT2" } })).rejects.toMatchObject({ kind: "outcome_unknown", step: "poll" });
    expect(r.calls).toHaveLength(1);
  });
});
