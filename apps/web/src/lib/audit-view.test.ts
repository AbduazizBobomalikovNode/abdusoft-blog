import { describe, expect, it } from "vitest";
import { auditFieldsText, auditTarget } from "./audit-view";

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
