import { beforeAll, describe, expect, it } from "vitest";
import type { JSONContent } from "@tiptap/core";
import { TEMPLATES, buildTemplate, markdownToDoc, type TemplateId } from "@blog/shared";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { renderPost } from "./render.js";
import { samplePostOne, samplePostTwo } from "./sample.js";

/**
 * "Do the new, lower panel limits still accept everything the repository itself produces?" - answered with the SAME logic as the
 * maintenance script `scripts/check-stored-docs.ts` (`checkStoredDocs`): the fixtures are stored as posts, revisions and the
 * About page in a real (PGlite) database and the script's function must report ZERO rejected rows.
 */

const MARKDOWN = "# T\n\n## A\n\ntext **b** `c` [d](https://example.com)\n\n- x\n  - y\n\n1. a\n\n> q\n\n```ts\nconst a = 1;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n---\n\n![alt](https://example.com/i.png)\n";

const longArticle = (): JSONContent => {
  const content: JSONContent[] = [];
  for (let s = 0; s < 60; s++) {
    content.push({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: `Bo'lim ${s}` }] });
    for (let p = 0; p < 12; p++) {
      content.push({
        type: "paragraph",
        content: [
          { type: "text", text: "Oddiy matn bilan boshlanadi, " },
          { type: "text", text: "qalin", marks: [{ type: "bold" }] },
          { type: "text", text: " va " },
          { type: "text", text: "havola", marks: [{ type: "link", attrs: { href: "https://example.com/x", target: "_blank", rel: "noopener noreferrer nofollow", class: null } }] },
          { type: "text", text: ". " + "Uzun jumla davom etadi. ".repeat(20) },
        ],
      });
    }
    content.push({ type: "codeBlock", attrs: { language: "typescript" }, content: [{ type: "text", text: "const value: number = 1; // sample\n".repeat(10) }] });
    if (s % 6 === 0) content.push({ type: "image", attrs: { src: `http://localhost:4000/uploads/${s}.webp`, alt: "Rasm", title: null } });
  }
  content.push({ type: "table", content: Array.from({ length: 30 }, () => ({ type: "tableRow", content: Array.from({ length: 8 }, () => ({ type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [{ type: "paragraph", content: [{ type: "text", text: "kat" }] }] })) })) });
  return { type: "doc", content };
};

const fixtures = (): [string, JSONContent][] => [
  ["samplePostOne", samplePostOne],
  ["samplePostTwo", samplePostTwo],
  ["markdown import", markdownToDoc(MARKDOWN).doc as JSONContent],
  ...TEMPLATES.map((t): [string, JSONContent] => [`template ${t.id}`, { type: "doc", content: buildTemplate(t.id as TemplateId) } as JSONContent]),
  ["empty", { type: "doc", content: [{ type: "paragraph" }] }],
  ["a long article (about 6,000 words, 60 sections, 60 code blocks, a 30x8 table)", longArticle()],
];

describe("check-stored-docs logic accepts the repository's fixtures, templates and samples under the new limits", () => {
  beforeAll(async () => {
    await migrateTestDb();
  });

  it("reports zero rejected rows for posts, revisions and the About page", async () => {
    const { db } = await import("../../db/index.js");
    const { postRevisions, posts, siteSettings } = await import("../../db/schema.js");
    const { checkStoredDocs } = await import("./stored-docs-check.js");

    const list = fixtures();
    for (const [i, [name, doc]] of list.entries()) {
      const rendered = await renderPost(doc);
      const [row] = await db
        .insert(posts)
        .values({ slug: `fx-${i}`, title: name, contentJson: doc, contentHtml: rendered.html, contentText: rendered.text, toc: rendered.toc })
        .returning();
      await db.insert(postRevisions).values({ postId: row!.id, title: name, slug: `fx-${i}`, contentJson: doc, status: "draft", via: "web", reason: "update" });
    }
    await db.insert(siteSettings).values({ key: "about", value: { json: samplePostOne, html: "" } });

    const report = await checkStoredDocs(db);
    expect(report.counts.posts).toBe(list.length);
    expect(report.counts.revisions).toBe(list.length);
    expect(report.counts.about).toBe(1);
    expect(report.failures).toEqual([]);
  });
});
