import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { cleanPastedHtml, type HtmlParser } from "./html-clean";

const parse: HtmlParser = (html) => parseHTML(`<!doctype html><html><head></head>${html.startsWith("<body") ? html : `<body>${html}</body>`}</html>`).document as unknown as Document;
const clean = (html: string) => cleanPastedHtml(html, parse);

describe("cleanPastedHtml", () => {
  it("strips Google Docs wrapper, styles, fonts and colors", () => {
    const out = clean(
      `<meta charset='utf-8'><b style="font-weight:normal;" id="docs-internal-guid-1"><h2 dir="ltr" style="margin:18pt"><span style="font-size:17pt;font-family:Arial;color:#000">Sarlavha</span></h2><p dir="ltr"><span style="color:#f00;font-size:11pt">Qizil </span><span style="font-weight:700">qalin</span></p></b>`,
    );
    expect(out).not.toMatch(/style=|font|<span|dir=|id=|<meta|<b /);
    expect(out).toContain("<h2>Sarlavha</h2>");
    expect(out).toContain("<strong>qalin</strong>");
  });

  it("converts italic/underline spans but keeps links un-underlined", () => {
    const out = clean(`<p><span style="font-style:italic">kursiv</span> <a href="https://x.test"><span style="text-decoration:underline">havola</span></a> <span style="text-decoration:underline">chizilgan</span></p>`);
    expect(out).toContain("<em>kursiv</em>");
    expect(out).toContain('<a href="https://x.test">havola</a>');
    expect(out).toContain("<u>chizilgan</u>");
  });

  it("drops <style>, comments, scripts and Word o:p markup", () => {
    const out = clean(`<!--StartFragment--><style>p{color:red}</style><script>alert(1)</script><p class="MsoNormal">Matn<o:p></o:p></p><!--EndFragment-->`);
    expect(out).toBe("<p>Matn</p>");
  });

  it("maps h1 to h2 and h4+ to h3, removes bold/br inside headings", () => {
    const out = clean(`<h1><strong>Katta</strong></h1><h4>Kichik<br>sarlavha</h4>`);
    expect(out).toBe("<h2>Katta</h2><h3>Kichik sarlavha</h3>");
  });

  it("turns plain divs into paragraphs and removes empty blocks", () => {
    const out = clean(`<div>bir</div><div><br></div><div><div>ikki</div></div><p>&nbsp;</p>`);
    expect(out).toBe("<p>bir</p><p>ikki</p>");
  });

  it("drops data: images and javascript links, keeps https images", () => {
    const out = clean(`<img src="data:image/png;base64,AAA"><img src="https://x.test/a.png" alt="a" style="width:10px"><a href="javascript:x()">t</a>`);
    expect(out).not.toContain("data:");
    expect(out).toContain('<img src="https://x.test/a.png" alt="a">');
    expect(out).not.toContain("javascript");
  });

  it("keeps code language class only", () => {
    const out = clean(`<pre class="x y"><code class="hljs language-ts foo">let a</code></pre>`);
    expect(out).toContain('<code class="language-ts">let a</code>');
    expect(out).not.toContain("hljs");
  });

  it("flattens table cell paragraphs", () => {
    const out = clean(`<table style="width:100%"><colgroup><col></colgroup><tbody><tr><td style="x"><p>a</p></td><th colspan="2">b</th></tr></tbody></table>`);
    expect(out).toContain("<td>a</td>");
    expect(out).toContain('<th colspan="2">b</th>');
    expect(out).not.toMatch(/style|colgroup|tbody/);
  });
});
