import { describe, expect, it } from "vitest";
import { buildPublishChecklist, countEmptyHeadings, countImagesWithoutAlt, hasBlockingIssue, isReadableSlug, type ChecklistInput } from "./checklist";
import { buildTemplate } from "@blog/shared";

const para = (t: string) => ({ type: "paragraph", content: [{ type: "text", text: t }] });
const base: ChecklistInput = {
  title: "Yaxshi post",
  slug: "yaxshi-post",
  doc: { type: "doc", content: [para("matn")] },
  coverUrl: "https://x.test/c.png",
  excerpt: "",
  tagCount: 1,
};
const byId = (items: ReturnType<typeof buildPublishChecklist>, id: string) => items.find((i) => i.id === id);

describe("publish checklist", () => {
  it("all green for a complete post", () => {
    const items = buildPublishChecklist(base);
    expect(items.every((i) => i.ok)).toBe(true);
    expect(hasBlockingIssue(items)).toBe(false);
  });

  it("blocks on empty/default title and empty body", () => {
    expect(hasBlockingIssue(buildPublishChecklist({ ...base, title: "  " }))).toBe(true);
    expect(hasBlockingIssue(buildPublishChecklist({ ...base, title: "Nomsiz post" }))).toBe(true);
    const emptyBody = buildPublishChecklist({ ...base, doc: { type: "doc", content: [{ type: "paragraph" }] } });
    expect(byId(emptyBody, "body")?.ok).toBe(false);
    expect(hasBlockingIssue(emptyBody)).toBe(true);
  });

  it("image-only body is not blocking", () => {
    const items = buildPublishChecklist({ ...base, doc: { type: "doc", content: [{ type: "image", attrs: { src: "a", alt: "x" } }] } });
    expect(byId(items, "body")?.ok).toBe(true);
  });

  it("warns (non-blocking) for missing cover, tags, alt text, empty headings", () => {
    const doc = {
      type: "doc",
      content: [para("matn"), { type: "image", attrs: { src: "a", alt: "" } }, { type: "heading", attrs: { level: 2 } }],
    };
    const items = buildPublishChecklist({ ...base, coverUrl: null, tagCount: 0, doc });
    for (const id of ["cover", "tags", "imageAlt", "emptyHeading"]) {
      expect(byId(items, id)?.ok).toBe(false);
      expect(byId(items, id)?.severity).toBe("warn");
      expect(byId(items, id)?.fix).toBe(id);
    }
    expect(hasBlockingIssue(items)).toBe(false);
    expect(countImagesWithoutAlt(doc)).toBe(1);
    expect(countEmptyHeadings(doc)).toBe(1);
  });

  it("warns about leftover template hints", () => {
    const items = buildPublishChecklist({ ...base, doc: { type: "doc", content: buildTemplate("news") } });
    expect(byId(items, "hints")?.ok).toBe(false);
  });

  it("slug readability", () => {
    expect(isReadableSlug("react-19-yangiliklari")).toBe(true);
    expect(isReadableSlug("Yangi Post")).toBe(false);
    expect(isReadableSlug("nomsiz-post-2")).toBe(false);
    expect(isReadableSlug("12345")).toBe(false);
    expect(isReadableSlug("a--b")).toBe(false);
  });
});
