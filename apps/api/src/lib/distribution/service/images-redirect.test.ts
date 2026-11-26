import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DISTRIBUTION_ENABLED = "true";
  process.env.WEB_ORIGIN = "https://blog.example.test";
});

const { prepareSocialImage, setSocialImageLoader, ogImageSourceUrl } = await import("./images.js");
const sup = await import("./test-support.js");

afterEach(() => setSocialImageLoader(null));

describe("the generated Open Graph image is fetched with the own-origin rule enforced after redirects", () => {
  it("passes a redirect policy that accepts only the blog's own web origin (the cover image gets none)", async () => {
    const seen: Array<{ url: string; policy: ((u: URL) => boolean) | undefined }> = [];
    setSocialImageLoader(async (url, opts) => {
      seen.push({ url, policy: opts?.allowRedirect });
      return sup.fakePreparedImage(url);
    });
    const og = await prepareSocialImage({ id: "p", slug: "salom", coverUrl: null }, "og");
    expect(og).toMatchObject({ ok: true, source: "og" });
    expect(seen[0]!.url).toBe(ogImageSourceUrl("salom"));
    const policy = seen[0]!.policy!;
    expect(policy(new URL("https://blog.example.test/x/opengraph-image-1"))).toBe(true);
    expect(policy(new URL("https://evil.example/x.png"))).toBe(false);
    expect(policy(new URL("https://blog.example.test.evil.example/x.png"))).toBe(false);
    expect(policy(new URL("http://blog.example.test/x.png"))).toBe(false); // sxema ham origin'ga kiradi

    seen.length = 0;
    await prepareSocialImage({ id: "p", slug: "salom", coverUrl: "https://cdn.example/c.jpg" }, "cover");
    expect(seen[0]!.policy).toBeUndefined();
  });
});
