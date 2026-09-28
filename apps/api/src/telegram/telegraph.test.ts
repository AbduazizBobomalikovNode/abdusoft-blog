import { describe, expect, it } from "vitest";
import { tiptapToTelegraphNodes, type TelegraphNode } from "./telegraph";

const options = {
  title: "Sarlavha",
  authorName: "Blog",
  authorUrl: "https://example.com",
  postUrl: "https://example.com/post",
};

function doc(...content: unknown[]) {
  return { type: "doc", content };
}

function findTag(nodes: TelegraphNode[], tag: string): TelegraphNode | undefined {
  for (const node of nodes) {
    if (typeof node === "string") continue;
    if (node.tag === tag) return node;
    const found = findTag(node.children ?? [], tag);
    if (found) return found;
  }
  return undefined;
}

describe("tiptapToTelegraphNodes", () => {
  it("maps heading levels 1-2 to h3 and 3+ to h4 (Telegraph only supports h3/h4)", () => {
    const nodes = tiptapToTelegraphNodes(
      doc(
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Katta" }] },
        { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Kichik" }] },
      ),
      options,
    );
    expect(findTag(nodes, "h3")).toBeTruthy();
    expect(findTag(nodes, "h4")).toBeTruthy();
  });

  it("converts a code block into <pre><code>", () => {
    const nodes = tiptapToTelegraphNodes(
      doc({ type: "codeBlock", content: [{ type: "text", text: "const x = 1;" }] }),
      options,
    );
    const pre = findTag(nodes, "pre");
    expect(pre).toBeTruthy();
    const code = findTag((pre as { children: TelegraphNode[] }).children, "code");
    expect(code).toBeTruthy();
    expect((code as { children: TelegraphNode[] }).children).toEqual(["const x = 1;"]);
  });

  it("wraps an image with alt text in a <figure><figcaption>, and bare image without alt in <figure> only", () => {
    const withAlt = tiptapToTelegraphNodes(
      doc({ type: "image", attrs: { src: "https://x/1.png", alt: "Tavsif" } }),
      options,
    );
    const figure = findTag(withAlt, "figure");
    expect(figure).toBeTruthy();
    expect(findTag((figure as { children: TelegraphNode[] }).children, "img")).toBeTruthy();
    expect(findTag((figure as { children: TelegraphNode[] }).children, "figcaption")).toBeTruthy();

    const withoutAlt = tiptapToTelegraphNodes(doc({ type: "image", attrs: { src: "https://x/1.png" } }), options);
    const figure2 = findTag(withoutAlt, "figure");
    expect(figure2).toBeTruthy();
    expect(findTag((figure2 as { children: TelegraphNode[] }).children, "figcaption")).toBeFalsy();
  });

  it("always appends a footer link back to the post", () => {
    const nodes = tiptapToTelegraphNodes(doc({ type: "paragraph", content: [{ type: "text", text: "Salom" }] }), options);
    const lastNode = nodes[nodes.length - 1];
    expect(typeof lastNode).not.toBe("string");
    const link = findTag([lastNode as TelegraphNode], "a");
    expect(link).toBeTruthy();
    expect((link as { attrs?: Record<string, string> }).attrs?.href).toBe(options.postUrl);
  });

  it("truncates content exceeding the 64 KB Telegraph limit and adds a 'Davomi saytda' continuation link", () => {
    // Build enough paragraphs to exceed the 60_000-byte safety threshold used internally.
    const bigContent = Array.from({ length: 2000 }, (_, i) => ({
      type: "paragraph",
      content: [{ type: "text", text: `Bu juda uzun matn qatori raqami ${i} - takrorlanuvchi kontent to'ldirish uchun.` }],
    }));
    const nodes = tiptapToTelegraphNodes(doc(...bigContent), options);

    const byteLength = new TextEncoder().encode(JSON.stringify(nodes)).length;
    expect(byteLength).toBeLessThanOrEqual(60_000);

    const last = nodes[nodes.length - 1];
    const continueLink = findTag([last as TelegraphNode], "a");
    expect(continueLink).toBeTruthy();
    expect((continueLink as { attrs?: Record<string, string> }).attrs?.href).toBe(options.postUrl);

    // Should have dropped some paragraphs compared to the untruncated version.
    expect(nodes.length).toBeLessThan(bigContent.length + 1);
  });

  it("keeps content untouched (besides the footer) when well under the size limit", () => {
    const nodes = tiptapToTelegraphNodes(doc({ type: "paragraph", content: [{ type: "text", text: "Qisqa matn" }] }), options);
    // paragraph + footer link
    expect(nodes.length).toBe(2);
  });

  it("falls back tables to pipe-joined paragraphs (Telegraph has no table support)", () => {
    const table = {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] },
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }] },
          ],
        },
      ],
    };
    const nodes = tiptapToTelegraphNodes(doc(table), options);
    const p = findTag(nodes, "p");
    expect(p).toBeTruthy();
  });
});
