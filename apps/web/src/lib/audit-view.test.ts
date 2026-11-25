import { describe, expect, it } from "vitest";
import { auditFieldsText, auditHref, auditTarget, joinMeta, summaryWithoutAction, validEntityId } from "./audit-view";

describe("auditTarget", () => {
  const posts = new Map([["p1", "Bor post"]]);

  it("links to a post that still exists", () => {
    expect(auditTarget({ entityType: "post", entityId: "p1" }, posts)).toMatchObject({
      kind: "Post",
      title: "Bor post",
      href: "/admin/postlar/p1",
      gone: false,
    });
  });

  it("marks a purged/trashed post as gone and does not link it", () => {
    expect(auditTarget({ entityType: "post", entityId: "yoq" }, posts)).toMatchObject({ href: null, gone: true, title: null });
  });

  it("does not link other entities and survives null ids and unknown types", () => {
    expect(auditTarget({ entityType: "tag", entityId: "t1" }, posts)).toMatchObject({ kind: "Teg", href: null, gone: false });
    expect(auditTarget({ entityType: "settings", entityId: null }, posts).href).toBeNull();
    expect(auditTarget({ entityType: "yangi", entityId: null }, posts).kind).toBe("yangi");
  });
});

describe("auditFieldsText", () => {
  it("joins the edited fields and ignores junk meta", () => {
    expect(auditFieldsText({ fields: ["title", "contentJson"], count: 3 })).toBe("title, contentJson");
    expect(auditFieldsText({})).toBeNull();
    expect(auditFieldsText({ fields: [] })).toBeNull();
    expect(auditFieldsText({ fields: "title" })).toBeNull();
    expect(auditFieldsText({ fields: [1, null] })).toBeNull();
  });
});

describe("auditHref", () => {
  it("builds a link that keeps the active filters and applies overrides", () => {
    expect(auditHref({})).toBe("/admin/jurnal");
    expect(auditHref({ via: "mcp", entityType: "post" })).toBe("/admin/jurnal?via=mcp&entityType=post");
    expect(auditHref({ via: "mcp", entityType: "post" }, { via: undefined })).toBe("/admin/jurnal?entityType=post");
    expect(auditHref({ via: "mcp" }, { via: "telegram", from: "2026-11-01" })).toBe("/admin/jurnal?via=telegram&from=2026-11-01");
  });

  it("is a plain function usable from server components (lives outside the client module)", () => {
    expect(typeof auditHref).toBe("function");
  });
});

describe("journal tidy helpers", () => {
  it("accepts only UUIDs as entityId", () => {
    expect(validEntityId("0b13238a-1111-4222-8333-444455556666")).toBe("0b13238a-1111-4222-8333-444455556666");
    expect(validEntityId("../../x")).toBeUndefined();
    expect(validEntityId("")).toBeUndefined();
    expect(validEntityId(undefined)).toBeUndefined();
  });

  it("does not repeat the action label in the summary", () => {
    expect(summaryWithoutAction('Post tahrirlandi: "Sarlavha"', "Post tahrirlandi")).toBe('"Sarlavha"');
    expect(summaryWithoutAction("Post tahrirlandi", "Post tahrirlandi")).toBeNull();
    expect(summaryWithoutAction("Boshqa matn", "Post tahrirlandi")).toBe("Boshqa matn");
    expect(summaryWithoutAction("   ", "x")).toBeNull();
  });

  it("joins meta parts without dangling separators", () => {
    expect(joinMeta(["Admin", "25 noy", null])).toEqual(["Admin", "25 noy"]);
    expect(joinMeta([false, "", "Faqat"])).toEqual(["Faqat"]);
  });
});
