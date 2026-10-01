import { describe, expect, it } from "vitest";
import { config } from "../config";
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

  it("prepends the cover as the FIRST node (absolute URL) and skips it when the first node is the same image", () => {
    const withCover = tiptapToTelegraphNodes(doc({ type: "paragraph", content: [{ type: "text", text: "Matn" }] }), {
      ...options,
      coverUrl: "/uploads/cover.jpg",
    });
    const first = withCover[0] as { tag: string; children: { tag: string; attrs: { src: string } }[] };
    expect(first.tag).toBe("figure");
    expect(first.children[0]!.tag).toBe("img");
    expect(first.children[0]!.attrs.src).toBe(`${config.API_ORIGIN}/uploads/cover.jpg`);

    const duplicate = tiptapToTelegraphNodes(
      doc({ type: "image", attrs: { src: `${config.API_ORIGIN}/uploads/cover.jpg` } }),
      { ...options, coverUrl: "/uploads/cover.jpg" },
    );
    // figure (kover o'zi) + footer — ikkinchi nusxa yo'q.
    expect(duplicate.length).toBe(2);

    const noCover = tiptapToTelegraphNodes(doc({ type: "paragraph", content: [{ type: "text", text: "Matn" }] }), options);
    expect((noCover[0] as { tag: string }).tag).toBe("p");
  });

  it("makes relative content image sources absolute", () => {
    const nodes = tiptapToTelegraphNodes(doc({ type: "image", attrs: { src: "/uploads/a.png" } }), options);
    const img = findTag(nodes, "img") as unknown as { attrs: { src: string } };
    expect(img.attrs.src).toBe(`${config.API_ORIGIN}/uploads/a.png`);
  });

  it("counts the cover node in the 64 KB size limit", () => {
    const bigContent = Array.from({ length: 2000 }, (_, i) => ({
      type: "paragraph",
      content: [{ type: "text", text: `Uzun matn qatori ${i} - takrorlanuvchi kontent to'ldirish uchun.` }],
    }));
    const nodes = tiptapToTelegraphNodes(doc(...bigContent), { ...options, coverUrl: "https://x/cover.jpg" });
    expect(new TextEncoder().encode(JSON.stringify(nodes)).length).toBeLessThanOrEqual(60_000);
    expect((nodes[0] as { tag: string }).tag).toBe("figure");
  });

  describe("tables", () => {
    const cell = (type: string, text: string) => ({
      type,
      content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }],
    });
    const row = (...cells: unknown[]) => ({ type: "tableRow", content: cells });

    it("renders each data row as <p><strong>cell0</strong><br>Header: value...</p>", () => {
      const table = {
        type: "table",
        content: [
          row(cell("tableHeader", "Model"), cell("tableHeader", "Narx"), cell("tableHeader", "Tezlik")),
          row(cell("tableCell", "A"), cell("tableCell", "10"), cell("tableCell", "Tez")),
          row(cell("tableCell", "B"), cell("tableCell", "20"), cell("tableCell", "Sekin")),
        ],
      };
      const nodes = tiptapToTelegraphNodes(doc(table), options);
      // 2 ta qator-paragraf + footer
      expect(nodes.length).toBe(3);
      expect(nodes[0]).toEqual({
        tag: "p",
        children: [
          { tag: "strong", children: ["A"] },
          { tag: "br" },
          "Narx: ",
          "10",
          { tag: "br" },
          "Tezlik: ",
          "Tez",
        ],
      });
      expect(JSON.stringify(nodes)).not.toContain("|");
    });

    it("keeps links inside cells", () => {
      const linkCell = {
        type: "tableCell",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "docs", marks: [{ type: "link", attrs: { href: "https://d.example" } }] }] },
        ],
      };
      const table = {
        type: "table",
        content: [row(cell("tableHeader", "Nom"), cell("tableHeader", "Havola")), row(cell("tableCell", "X"), linkCell)],
      };
      const nodes = tiptapToTelegraphNodes(doc(table), options);
      const a = findTag(nodes, "a") as unknown as { attrs: { href: string } };
      expect(a.attrs.href).toBe("https://d.example");
    });

    it("joins cells with an em dash when there is no usable header row", () => {
      const table = {
        type: "table",
        content: [row(cell("tableCell", "A"), cell("tableCell", "B"), cell("tableCell", "C"))],
      };
      const nodes = tiptapToTelegraphNodes(doc(table), options);
      expect(nodes[0]).toEqual({ tag: "p", children: ["A", " \u2014 ", "B", " \u2014 ", "C"] });
    });
  });
});
