import { describe, expect, it } from "vitest";
import { buildPublishChecklist, hasBlockingIssue } from "./publish-checklist.js";

const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Matn" }] }, { type: "image", attrs: { src: "/a.png", alt: "" } }] };

describe("publish checklist (shared by the editor panel and the server)", () => {
  it("blocks on the default title and empty body, warns on missing alt text", () => {
    const empty = buildPublishChecklist({ title: "Nomsiz post", slug: "nomsiz-post-abc123", doc: { type: "doc", content: [{ type: "paragraph" }] }, coverUrl: null, excerpt: "", tagCount: 0 });
    expect(hasBlockingIssue(empty)).toBe(true);
    const ok = buildPublishChecklist({ title: "Salom dunyo", slug: "salom-dunyo", doc, coverUrl: "/c.png", excerpt: "x", tagCount: 1 });
    expect(hasBlockingIssue(ok)).toBe(false);
    expect(ok.find((i) => i.id === "imageAlt")).toMatchObject({ ok: false, severity: "warn", detail: "1 ta rasmda alt matn yo'q" });
  });
});
