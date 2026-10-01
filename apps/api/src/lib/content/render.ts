import { generateHTML } from "@tiptap/html";
import type { JSONContent } from "@tiptap/core";
import { Image } from "@tiptap/extension-image";
import { StarterKit } from "@tiptap/starter-kit";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeParse from "rehype-parse";
import rehypeShiki from "@shikijs/rehype";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { toText } from "hast-util-to-text";
import type { Element, Root } from "hast";
import type { TocItem } from "@blog/shared";

const WORDS_PER_MINUTE = 200;
const EXCERPT_LENGTH = 160;

export const tiptapExtensions = [
  StarterKit.configure({ link: { openOnClick: false } }),
  Image,
  Table,
  TableRow,
  TableHeader,
  TableCell,
];

interface RenderResult {
  html: string;
  toc: TocItem[];
  readingTime: number;
  excerpt: string;
  text: string;
}

/**
 * Kod bloki matnining birinchi qatori `// filename.ext` (yoki `# filename.ext`)
 * ko'rinishida bo'lsa, uni matndan olib tashlab, `<pre><code>...</code></pre>`
 * ni `data-filename` atributli `<div>` bilan o'raydi. Web tomonida shu atribut
 * asosida kod bloki tepasida fayl nomi ko'rsatiladi.
 *
 * Bu qadam @shikijs/rehype ishlashidan OLDIN, xom HTML matni ustida amalga
 * oshiriladi — chunki shiki `<pre>` elementini to'liq almashtiradi va uning
 * ustidagi atributlarni saqlab qolmaydi. Atrofdagi `<div>` esa daxlsiz qoladi.
 */
function liftCodeFilenames(html: string): string {
  return html.replace(
    /<pre><code([^>]*)>(?:\/\/|#)[ \t]*([^\n<]+?\.[A-Za-z0-9]+)[ \t]*\n([\s\S]*?)<\/code><\/pre>/g,
    (_match, codeAttrs: string, filename: string, rest: string) => {
      const safeFilename = filename.trim().replace(/["<>]/g, "");
      return `<div class="code-block" data-filename="${safeFilename}"><pre><code${codeAttrs}>${rest}</code></pre></div>`;
    },
  );
}

const CALLOUT_MARKERS: Record<string, string> = {
  "ℹ️": "info",
  "⚠️": "warning",
  "💡": "tip",
};

/**
 * `> ℹ️ ...` / `> ⚠️ ...` / `> 💡 ...` bilan boshlangan sitatalarni callout
 * variantiga aylantiradi: emoji matndan olib tashlanadi va `blockquote`ga
 * `callout callout-{variant}` klassi qo'shiladi (ikonka CSS orqali qaytariladi).
 */
function calloutPlugin() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      if (node.tagName !== "blockquote") return;

      const firstChild = node.children.find((child) => child.type === "element");
      if (!firstChild || firstChild.type !== "element" || firstChild.tagName !== "p") return;

      const textNode = firstChild.children[0];
      if (!textNode || textNode.type !== "text") return;

      const trimmed = textNode.value.trimStart();
      for (const [marker, variant] of Object.entries(CALLOUT_MARKERS)) {
        if (!trimmed.startsWith(marker)) continue;

        textNode.value = trimmed.slice(marker.length).trimStart();
        const existing = node.properties.className;
        const classes = Array.isArray(existing)
          ? existing
          : typeof existing === "string"
            ? [existing]
            : [];
        node.properties.className = [...classes, "callout", `callout-${variant}`];
        break;
      }
    });
  };
}

function collectToc() {
  const toc: TocItem[] = [];
  return {
    plugin: () => (tree: Root) => {
      visit(tree, "element", (node: Element) => {
        if (node.tagName === "h2" || node.tagName === "h3") {
          const id = typeof node.properties.id === "string" ? node.properties.id : "";
          if (!id) return;
          toc.push({
            id,
            text: toText(node).trim(),
            level: node.tagName === "h2" ? 2 : 3,
          });
        }
      });
    },
    toc,
  };
}

export async function renderPost(json: JSONContent): Promise<RenderResult> {
  const rawHtml = liftCodeFilenames(generateHTML(json, tiptapExtensions));

  const { plugin: tocPlugin, toc } = collectToc();

  const file = await unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeSlug)
    .use(rehypeAutolinkHeadings, { behavior: "wrap" })
    .use(tocPlugin)
    .use(calloutPlugin)
    .use(rehypeShiki, {
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    })
    .use(rehypeStringify)
    .process(rawHtml);

  const html = String(file);
  const plainText = toText(
    unified().use(rehypeParse, { fragment: true }).parse(rawHtml) as Root,
  ).replace(/\s+/g, " ").trim();

  const wordCount = plainText.length === 0 ? 0 : plainText.split(" ").length;
  const readingTime = Math.max(1, Math.ceil(wordCount / WORDS_PER_MINUTE));
  const excerpt =
    plainText.length > EXCERPT_LENGTH
      ? `${plainText.slice(0, EXCERPT_LENGTH).trimEnd()}…`
      : plainText;

  return { html, toc, readingTime, excerpt, text: plainText };
}
