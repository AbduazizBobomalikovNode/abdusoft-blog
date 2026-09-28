import MarkdownIt from "markdown-it";
import sanitizeHtml from "sanitize-html";

/**
 * Izohlar uchun "markdown-lite": **qalin**, _kursiv_, `kod`, fenced kod
 * bloklari, avtomatik havolalar va qator uzilishlari. `html: false` — foydalanuvchi
 * yozgan xom HTML hech qachon render qilinmaydi; natija yana `sanitize-html`
 * bilan tozalanadi (ikki qatlamli himoya).
 */
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

const ALLOWED_TAGS = ["p", "br", "strong", "em", "code", "pre", "a", "blockquote", "ul", "ol", "li", "s"];

export function renderCommentBody(raw: string): string {
  const rendered = md.render(raw);

  return sanitizeHtml(rendered, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ["href", "rel", "target"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "nofollow noopener", target: "_blank" }, true),
    },
  });
}
