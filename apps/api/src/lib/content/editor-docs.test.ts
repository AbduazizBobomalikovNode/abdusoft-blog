import { describe, expect, it } from "vitest";
import { getSchema, type JSONContent } from "@tiptap/core";
import { TEMPLATES, buildTemplate, docStats, markdownToDoc, type TemplateId } from "@blog/shared";
import { buildChannelPost } from "../../telegram/channel-post.js";
import { renderRestrictedDoc, validateRestrictedDoc } from "../../telegram/channel-html.js";
import { tiptapToTelegraphNodes, type TelegraphNode } from "../../telegram/telegraph.js";
import { renderPost, tiptapExtensions } from "./render.js";

/**
 * Admin muharriridagi shablonlar va Markdown import ishlab chiqargan hujjatlar
 * saytdagi 4 ta konverterdan (sayt renderi, Telegraph, kanal posti, kanal HTML) xatosiz o'tishi kerak —
 * ya'ni sxemada yo'q tugun/belgi hosil bo'lmasligi shart.
 */

const schema = getSchema(tiptapExtensions);

function unknownNodes(doc: JSONContent): string[] {
  const bad: string[] = [];
  const walk = (node: JSONContent) => {
    if (node.type && !schema.nodes[node.type]) bad.push(`node:${node.type}`);
    for (const mark of node.marks ?? []) if (!schema.marks[mark.type]) bad.push(`mark:${mark.type}`);
    (node.content ?? []).forEach(walk);
  };
  walk(doc);
  return bad;
}

function telegraphTags(nodes: TelegraphNode[]): Set<string> {
  const tags = new Set<string>();
  const walk = (n: TelegraphNode | string) => {
    if (typeof n === "string") return;
    tags.add(n.tag);
    (n.children ?? []).forEach(walk);
  };
  nodes.forEach(walk);
  return tags;
}

const MARKDOWN_SAMPLE = `# Import qilingan post

Kirish **qalin**, *kursiv*, ~~chizilgan~~, \`kod\` va [havola](https://example.com).

## Birinchi bo'lim

- bir
  - ichki
- ikki

1. a
2. b

> Oddiy iqtibos

> [!TIP]
> Foydali maslahat

> [!WARNING]
> Ehtiyot bo'ling

### Kod

\`\`\`ts
const a: number = 1;
\`\`\`

| Ustun A | Ustun B |
|---------|---------|
| 1       | 2       |

---

![Rasm izohi](https://example.com/rasm.png)
`;

const cases: { name: string; doc: JSONContent }[] = [
  ...TEMPLATES.map((t) => ({ name: `template ${t.id}`, doc: { type: "doc", content: buildTemplate(t.id as TemplateId) } as JSONContent })),
  { name: "markdown import", doc: markdownToDoc(MARKDOWN_SAMPLE).doc as JSONContent },
];

describe.each(cases)("editor-produced document: $name", ({ doc }) => {
  it("uses only nodes and marks known to the shared schema", () => {
    expect(unknownNodes(doc)).toEqual([]);
  });

  it("renders through renderPost (site renderer) with text and reading time", async () => {
    const result = await renderPost(doc);
    expect(result.html.length).toBeGreaterThan(20);
    expect(result.text.length).toBeGreaterThan(5);
    expect(result.readingTime).toBeGreaterThanOrEqual(1);
    expect(result.html).not.toMatch(/<(?:script|style)/i);
  });

  it("editor word count / reading time equal the server's (renderPost) numbers", async () => {
    const server = await renderPost(doc);
    const serverWords = server.text.length === 0 ? 0 : server.text.split(" ").length;
    const stats = docStats(doc);
    expect(stats.words).toBe(serverWords);
    expect(stats.readingMinutes).toBe(server.readingTime);
  });

  it("converts to Telegraph nodes without throwing and without unexpected tags", () => {
    const nodes = tiptapToTelegraphNodes(doc, {
      title: "T",
      authorName: "A",
      authorUrl: "https://blog.test",
      postUrl: "https://blog.test/t",
    });
    const allowed = new Set(["p", "h3", "h4", "ul", "ol", "li", "blockquote", "pre", "code", "hr", "br", "figure", "img", "figcaption", "a", "b", "strong", "i", "em", "s", "u"]);
    for (const tag of telegraphTags(nodes)) expect(allowed.has(tag), `unexpected telegraph tag <${tag}>`).toBe(true);
    expect(nodes.length).toBeGreaterThan(1);
  });

  it("builds a channel post (text mode) without throwing", () => {
    const result = buildChannelPost({
      post: { title: "Sarlavha", slug: "sarlavha", contentJson: doc, tags: ["test"] },
      siteUrl: "https://blog.test",
      telegraphUrl: "https://telegra.ph/x",
      mode: "text",
      variant: "l",
    });
    expect(result.html).toContain("<b>Sarlavha</b>");
    expect(result.visibleLength).toBeGreaterThan(0);
  });

  it("restricted channel-html: unsupported blocks are reported (not crashed), the supported subset renders", () => {
    // sarlavha/kod/jadval/rasm cheklangan kanal versiyasida ruxsat etilmaydi — aniq sabab bilan rad etiladi
    const reason = validateRestrictedDoc(doc);
    expect(reason === null || typeof reason === "string").toBe(true);
    const subset = {
      type: "doc",
      content: (doc.content ?? []).filter((n) => ["paragraph", "bulletList", "orderedList", "blockquote"].includes(n.type ?? "")),
    };
    expect(validateRestrictedDoc(subset)).toBeNull();
    expect(() => renderRestrictedDoc(subset)).not.toThrow();
  });
});

describe("markdown import specifics", () => {
  it("maps GitHub alerts to emoji callouts that the site renderer turns into callout blockquotes", async () => {
    const { doc } = markdownToDoc("> [!TIP]\n> Foydali\n\n> [!WARNING]\n> Ehtiyot");
    const html = (await renderPost(doc as JSONContent)).html;
    expect(html).toContain("callout-tip");
    expect(html).toContain("callout-warning");
  });

  it("produces code blocks that Shiki highlights and a table the site renders", async () => {
    const { doc } = markdownToDoc("```ts\nconst a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    const html = (await renderPost(doc as JSONContent)).html;
    expect(html).toContain("shiki");
    expect(html).toMatch(/<table[ >]/);
    expect(html).toMatch(/<th[ >]/);
  });
});
