/**
 * Joylashtirilgan (paste) HTML'ni tozalash: Google Docs / Word / veb-sahifadan kelgan
 * inline style, font, rang, span'lar olib tashlanadi; faqat qo'llab-quvvatlanadigan
 * bloklar qoladi. DOM'ni o'zi yaratmaydi — `parse` beriladi (brauzerda DOMParser, testda linkedom).
 */

export type HtmlParser = (html: string) => Document;

export const browserHtmlParser: HtmlParser = (html) => new DOMParser().parseFromString(html, "text/html");

const DROP_TAGS = new Set(["style", "script", "meta", "link", "title", "head", "xml", "noscript", "iframe", "object", "svg", "button", "input", "select", "textarea", "form", "nav", "aside", "footer"]);
const UNWRAP_TAGS = new Set(["span", "font", "o:p", "article", "section", "main", "header", "figure", "figcaption", "small", "big", "mark", "sup", "sub", "abbr", "cite", "label", "time", "center", "tbody", "thead", "tfoot", "colgroup", "col", "caption", "details", "summary", "dd", "dt", "dl", "address"]);
const KEEP_ATTRS: Record<string, string[]> = {
  a: ["href"],
  img: ["src", "alt", "title"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan"],
  ol: ["start"],
  code: ["class"],
  pre: ["class"],
};

function styleOf(el: Element): string {
  return (el.getAttribute("style") ?? "").toLowerCase().replace(/\s+/g, "");
}

function wrap(doc: Document, el: Element, tag: string): void {
  const outer = doc.createElement(tag);
  while (el.firstChild) outer.appendChild(el.firstChild);
  el.appendChild(outer);
}

function unwrap(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

/** `<span style="font-weight:700">` kabilarni semantik tegga aylantiradi (keyin style tashlanadi). */
function semanticizeSpans(doc: Document, root: Element): void {
  for (const el of Array.from(root.querySelectorAll("span, font"))) {
    const style = styleOf(el);
    if (!style) continue;
    if (/font-weight:(bold|bolder|[6-9]00)/.test(style)) wrap(doc, el, "strong");
    if (/font-style:italic/.test(style)) wrap(doc, el, "em");
    if (/text-decoration[^;]*line-through/.test(style)) wrap(doc, el, "s");
    // Google Docs havolalarida ham underline bor — faqat havola tashqarisida saqlaymiz.
    if (/text-decoration[^;]*underline/.test(style) && !el.closest("a")) wrap(doc, el, "u");
  }
}

function cleanAttributes(el: Element): void {
  const keep = KEEP_ATTRS[el.tagName.toLowerCase()] ?? [];
  for (const attr of Array.from(el.attributes)) {
    if (!keep.includes(attr.name.toLowerCase())) el.removeAttribute(attr.name);
  }
  if (el.tagName.toLowerCase() === "code" || el.tagName.toLowerCase() === "pre") {
    const cls = el.getAttribute("class") ?? "";
    const lang = /language-([a-z0-9+#-]+)/i.exec(cls)?.[1];
    if (lang) el.setAttribute("class", `language-${lang}`);
    else el.removeAttribute("class");
  }
}

function isBlankBlock(el: Element): boolean {
  return (el.textContent ?? "").replace(/[\s ​]/g, "") === "" && !el.querySelector("img, hr, table");
}

export function cleanPastedHtml(html: string, parse: HtmlParser = browserHtmlParser): string {
  const doc = parse(`<body>${html.replace(/<!--[\s\S]*?-->/g, "")}</body>`);
  const root = doc.body;

  for (const el of Array.from(root.querySelectorAll("*"))) {
    if (DROP_TAGS.has(el.tagName.toLowerCase())) el.remove();
  }
  // Word: `<o:p>` va `mso-*` izohlar; Google Docs: ichi `b[id^=docs-internal-guid]` o'rovchi.
  for (const el of Array.from(root.querySelectorAll("b, strong"))) {
    if ((el.getAttribute("id") ?? "").startsWith("docs-internal-guid") || styleOf(el).includes("font-weight:normal")) unwrap(el);
  }

  semanticizeSpans(doc, root);

  for (const el of Array.from(root.querySelectorAll("*"))) {
    const tag = el.tagName.toLowerCase();
    if (UNWRAP_TAGS.has(tag)) unwrap(el);
  }

  // Sarlavhalar: h1 → h2, h4–h6 → h3; ichidagi qalin/kursiv/br olib tashlanadi.
  for (const el of Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6"))) {
    const level = Number(el.tagName.slice(1));
    const target = level <= 2 ? "h2" : "h3";
    for (const inner of Array.from(el.querySelectorAll("strong, b, br"))) {
      if (inner.tagName.toLowerCase() === "br") inner.replaceWith(doc.createTextNode(" "));
      else unwrap(inner);
    }
    if (el.tagName.toLowerCase() !== target) {
      const replacement = doc.createElement(target);
      while (el.firstChild) replacement.appendChild(el.firstChild);
      el.replaceWith(replacement);
    }
  }

  // Jadval kataklaridagi paragraf o'rovlari — yagona paragrafga soddalashtiriladi.
  for (const cell of Array.from(root.querySelectorAll("td, th"))) {
    const ps = Array.from(cell.querySelectorAll(":scope > p, :scope > div"));
    if (ps.length === 1 && ps[0]) unwrap(ps[0]);
  }

  // Havolasiz <a>, data:/file:/blob: rasmlar.
  for (const a of Array.from(root.querySelectorAll("a"))) {
    const href = a.getAttribute("href") ?? "";
    if (!/^(https?:|mailto:|\/|#)/i.test(href)) unwrap(a);
  }
  for (const img of Array.from(root.querySelectorAll("img"))) {
    if (!/^https?:\/\//i.test(img.getAttribute("src") ?? "")) img.remove();
  }

  // div → p (ichida blok bo'lmasa), bo'sh bloklar tashlanadi.
  for (const div of Array.from(root.querySelectorAll("div"))) {
    if (div.querySelector("p, h2, h3, ul, ol, table, pre, blockquote, div")) unwrap(div);
    else {
      const p = doc.createElement("p");
      while (div.firstChild) p.appendChild(div.firstChild);
      div.replaceWith(p);
    }
  }
  for (const el of Array.from(root.querySelectorAll("p, li, h2, h3, blockquote"))) {
    if (el.tagName.toLowerCase() === "li" && el.querySelector("ul, ol")) continue;
    if (isBlankBlock(el)) el.remove();
  }

  for (const el of Array.from(root.querySelectorAll("*"))) cleanAttributes(el);

  return root.innerHTML.replace(/ /g, " ").replace(/&nbsp;/g, " ");
}
