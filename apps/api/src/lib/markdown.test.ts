import { describe, expect, it } from "vitest";
import { renderCommentBody } from "./markdown";

/**
 * `renderCommentBody` ikki qatlamli himoyaga tayanadi: markdown-it `html:false`
 * (xom HTML hech qachon parse qilinmaydi — teglar matn sifatida escape qilinadi
 * yoki xavfli link protokollari butunlay rad etiladi) + `sanitize-html` (ikkinchi
 * qatlam). Testlar tuzilmaviy xavfsizlikni tekshiradi: xavfli teg/atribut/protokol
 * HECH QACHON jonli (ijro etiladigan) HTML sifatida chiqmasligi kerak — inert matn
 * sifatida ko'rinishi (escape qilingan holda) xavfsiz va kutilgan holat.
 */
describe("renderCommentBody (XSS sanitization)", () => {
  it("never emits a live <script> element", () => {
    const out = renderCommentBody("Salom <script>alert(1)</script> dunyo");
    expect(out).not.toMatch(/<script[\s>]/i);
  });

  it("never emits an href with the javascript: scheme", () => {
    const out = renderCommentBody("[bosing](javascript:alert(1))");
    expect(out).not.toMatch(/href\s*=\s*"javascript:/i);
  });

  it("never emits a live <img> tag with an onerror handler", () => {
    const out = renderCommentBody('<img src="x" onerror="alert(1)">');
    expect(out).not.toMatch(/<img[\s>]/i);
    expect(out).not.toMatch(/<[a-z]+[^>]*\son\w+\s*=/i);
  });

  it("never emits a live style attribute", () => {
    const out = renderCommentBody('<p style="background:url(javascript:alert(1))">matn</p>');
    expect(out).not.toMatch(/<[a-z]+[^>]*\sstyle\s*=/i);
  });

  it("drops disallowed tags like <iframe> and <svg onload> entirely", () => {
    const out = renderCommentBody('<iframe src="https://evil.example"></iframe>');
    expect(out).not.toMatch(/<iframe[\s>]/i);

    const svg = renderCommentBody('<svg onload="alert(1)"></svg>');
    expect(svg).not.toMatch(/<svg[\s>]/i);
  });

  it("allows safe markdown formatting through", () => {
    const out = renderCommentBody("**qalin** va _kursiv_ va `kod`");
    expect(out).toContain("<strong>qalin</strong>");
    expect(out).toContain("<em>kursiv</em>");
    expect(out).toContain("<code>kod</code>");
  });

  it("adds rel=nofollow noopener and target=_blank to links, keeps http(s) hrefs", () => {
    const out = renderCommentBody("[sayt](https://example.com)");
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('rel="nofollow noopener"');
    expect(out).toContain('target="_blank"');
  });

  it("does not render raw HTML tags passed directly in the source (md html:false)", () => {
    const out = renderCommentBody("<b>qalin emas</b>, oddiy matn");
    expect(out).not.toMatch(/<b>/);
  });

  it("never emits a data: URI href (markdown-it's link validator rejects it)", () => {
    const out = renderCommentBody("[bosing](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)");
    expect(out).not.toMatch(/href\s*=\s*"data:/i);
  });
});
