import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AdminPostDetail, PostRevision, PostRevisionListItem } from "@blog/shared";

vi.mock("./revision-preview", () => ({ RevisionContent: () => createElement("div", { "data-testid": "revision-content" }) }));

import { RevisionDetail, RevisionRow, slugIsLive } from "./history-dialog";

const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

const listItem = (over: Partial<PostRevisionListItem> = {}): PostRevisionListItem => ({
  id: "r1",
  createdAt: "2026-10-01T10:00:00.000Z",
  createdBy: { id: "u1", name: "Aziz" },
  via: "web",
  reason: "publish",
  title: "Sarlavha",
  slug: "sarlavha",
  status: "draft",
  ...over,
});

const revision = (over: Partial<PostRevision> = {}): PostRevision => ({
  ...listItem(),
  excerpt: "Tavsif",
  contentJson: doc("eski"),
  coverUrl: null,
  tagSlugs: ["a"],
  settings: {},
  ...over,
});

const current = {
  title: "Sarlavha",
  slug: "sarlavha",
  excerpt: "Tavsif",
  coverUrl: null,
  tags: [{ id: "1", slug: "a", name: "A" }],
  contentJson: doc("yangi"),
  settings: {},
} as unknown as AdminPostDetail;

describe("RevisionRow", () => {
  const render = (item: PostRevisionListItem) => renderToStaticMarkup(createElement(RevisionRow, { item, selected: false, onSelect: vi.fn() }));

  it("shows time, who, source and the reason in Uzbek", () => {
    const html = render(listItem());
    expect(html).toContain("Aziz");
    expect(html).toContain("Veb panel");
    expect(html).toContain("Chop etishdan oldin");
    expect(html).not.toContain("border-l-violet");
  });

  it("gives non-human sources a distinct look", () => {
    const html = render(listItem({ via: "mcp", createdBy: null, reason: "update" }));
    expect(html).toContain("Yordamchi ulagich");
    expect(html).toContain("border-l-violet");
    expect(html).toContain('data-via-kind="automated"');
  });

  it("copes with a null actor and an unknown source and reason", () => {
    const html = render(listItem({ via: "kelajak", createdBy: null, reason: "yangi-sabab" }));
    expect(html).toContain("kelajak");
    expect(html).toContain("yangi-sabab");
    expect(html).toContain("Foydalanuvchi yo&#x27;q");
  });
});

describe("RevisionDetail", () => {
  const render = (rev: PostRevision, cur: AdminPostDetail | null = current, status: AdminPostDetail["status"] = "draft") =>
    renderToStaticMarkup(createElement(RevisionDetail, { revision: rev, current: cur, postStatus: status }));

  it("lists which fields differ from the current version", () => {
    const html = render(revision());
    expect(html).toContain("Joriy versiyadan farqi");
    expect(html).toContain("Matn");
    expect(html).not.toContain("Sarlavha</span>"); // sarlavha farq qilmaydi
  });

  it("says when there is no difference and when the current version is unavailable", () => {
    expect(render(revision({ contentJson: doc("yangi") }))).toContain("Joriy versiyadan farq yo&#x27;q");
    expect(render(revision(), null)).toContain("solishtirib bo&#x27;lmadi");
  });

  it("mentions a different slug only for a live post", () => {
    expect(render(revision({ slug: "eski-slug" }), current, "published")).toContain("/eski-slug");
    expect(render(revision({ slug: "eski-slug" }), current, "draft")).not.toContain("Bu versiyada havola boshqacha");
    expect(slugIsLive("published")).toBe(true);
    expect(slugIsLive("scheduled")).toBe(true);
    expect(slugIsLive("draft")).toBe(false);
  });

  it("renders text content as escaped text, never as HTML", () => {
    const html = render(revision({ title: "<img src=x onerror=alert(1)>", excerpt: "<script>alert(1)</script>" }));
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("renders for a revision with a null actor, an unknown source and no tags/excerpt/cover", () => {
    const html = render(revision({ createdBy: null, via: "boshqa", excerpt: null, tagSlugs: [], reason: "trash" }));
    expect(html).toContain("boshqa");
    expect(html).toContain("Savatga ko&#x27;chirishdan oldin");
  });
});
