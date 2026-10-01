import type { ContentNode as JSONContent } from "./content-stats.js";

/**
 * Shablonlar — faqat mavjud tugunlardan (paragraph / heading / list / codeBlock / blockquote).
 * "Maslahat" matnlari (HINTS) haqiqiy tugunlar; yozuvchi ustidan yozadi. Chop etishdan oldin
 * ro'yxat qolib ketgan maslahatlarni ogohlantiradi (`docHasHints`).
 */

export type TemplateId = "article" | "guide" | "tips" | "news";

export interface TemplateInfo {
  id: TemplateId;
  title: string;
  description: string;
}

export const TEMPLATES: TemplateInfo[] = [
  { id: "article", title: "Maqola", description: "Kirish, 3 ta bo'lim, xulosa" },
  { id: "guide", title: "Qo'llanma (qadam-baqadam)", description: "Tayyorgarlik, qadamlar, natija" },
  { id: "tips", title: "Ro'yxat (N ta maslahat)", description: "Kirish va 5 ta maslahat" },
  { id: "news", title: "Yangilik / qisqa post", description: "Asosiy xabar, tafsilot, manba" },
];

const HINT = {
  intro: "Maqola nima haqida ekanini bir-ikki gapda yozing.",
  section: "Bo'lim sarlavhasini yozing",
  sectionBody: "Bu bo'limning asosiy fikrini yozing.",
  conclusion: "Asosiy fikrlarni qisqacha takrorlang va o'quvchiga keyingi qadamni ayting.",
  guideIntro: "Qo'llanma nimaga o'rgatishini va natijani yozing.",
  need: "Kerak bo'ladigan narsani yozing",
  stepTitle: "Qadam nomini yozing",
  stepBody: "Bu qadamda nima qilinishini tushuntiring.",
  stepCode: "# buyruq yoki kod",
  result: "Oxirida nima chiqishi kerakligini yozing.",
  tipsIntro: "Ro'yxat nima haqida va kim uchun ekanini yozing.",
  tipTitle: "Maslahat sarlavhasini yozing",
  tipBody: "Maslahatni misol bilan tushuntiring.",
  newsLead: "Eng muhim xabarni bitta gapda yozing: nima, kim, qachon.",
  newsDetail: "Tafsilotlar va kontekstni yozing.",
  newsSource: "Manba: havolani yozing",
} as const;

export const TEMPLATE_HINTS: ReadonlySet<string> = new Set<string>(Object.values(HINT));

export function isHintText(text: string): boolean {
  return TEMPLATE_HINTS.has(text.trim());
}

const p = (text?: string): JSONContent => (text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" });
const h = (level: 2 | 3, text: string): JSONContent => ({ type: "heading", attrs: { level }, content: [{ type: "text", text }] });
const ul = (...items: string[]): JSONContent => ({
  type: "bulletList",
  content: items.map((t) => ({ type: "listItem", content: [p(t)] })),
});
const code = (text: string): JSONContent => ({ type: "codeBlock", attrs: { language: "bash" }, content: [{ type: "text", text }] });

export function buildTemplate(id: TemplateId): JSONContent[] {
  switch (id) {
    case "article":
      return [
        p(HINT.intro),
        h(2, "1-bo'lim"), p(HINT.sectionBody),
        h(2, "2-bo'lim"), p(HINT.sectionBody),
        h(2, "3-bo'lim"), p(HINT.sectionBody),
        h(2, "Xulosa"), p(HINT.conclusion),
      ];
    case "guide":
      return [
        p(HINT.guideIntro),
        h(2, "Nimalar kerak bo'ladi"), ul(HINT.need, HINT.need),
        h(2, "1-qadam"), p(HINT.stepBody), code(HINT.stepCode),
        h(2, "2-qadam"), p(HINT.stepBody),
        h(2, "3-qadam"), p(HINT.stepBody),
        h(2, "Natija"), p(HINT.result),
      ];
    case "tips":
      return [
        p(HINT.tipsIntro),
        ...[1, 2, 3, 4, 5].flatMap((n) => [h(2, `${n}-maslahat`), p(HINT.tipBody)]),
        h(2, "Xulosa"), p(HINT.conclusion),
      ];
    case "news":
      return [p(HINT.newsLead), p(HINT.newsDetail), p(HINT.newsSource)];
  }
}

function textOf(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(textOf).join("");
}

/** Hujjatda hali yozilmagan shablon maslahatlari qolganmi? Qolgan matnlar ro'yxatini qaytaradi. */
export function docHintTexts(doc: JSONContent | null | undefined): string[] {
  const found: string[] = [];
  const walk = (node: JSONContent) => {
    if (node.type === "paragraph" || node.type === "codeBlock") {
      const t = textOf(node).trim();
      if (t && isHintText(t)) found.push(t);
      return;
    }
    (node.content ?? []).forEach(walk);
  };
  if (doc) walk(doc);
  return found;
}
