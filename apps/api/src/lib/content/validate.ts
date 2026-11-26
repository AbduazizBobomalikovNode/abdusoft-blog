import { getSchema } from "@tiptap/core";
import { validateDocument } from "@blog/shared";
import { ownMediaMatcher } from "../media/own-url.js";
import { tiptapExtensions } from "./render.js";

let schema: ReturnType<typeof getSchema> | null = null;

/**
 * Muharrir schemasi bo'yicha TUGUN JOYLASHUVI (kontent modeli): jadval -> qatorlar -> katak/sarlavha -> blok; ro'yxat -> element; va h.k.
 * Faqat tur nomlari bo'yicha ishlaydi (tugun yaratilmaydi, belgi/atribut tekshirilmaydi): muharrir hujjatni har tranzaksiyada shu
 * model bo'yicha ushlab turadi, shuning uchun haqiqiy muharrir saqlagan hujjat bu yerdan HAR DOIM o'tadi. Ildizning bo'sh kontenti
 * (`{type:"doc"}` / `content: []`) mahsulotning o'zi saqlaydigan shakl (masalan "Haqida" sukut qiymati) — ruxsat etiladi.
 * Hujjat juda katta/chuqur/begona bo'lsa (chegaralar tekshiruvchisi baribir rad etadi) bu yerda jim o'tadi: xarajat chegaralangan.
 * Xabar noto'g'ri joylashgan tugunni ko'rsatadi.
 */
function structureProblem(doc: unknown): string | null {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  schema ??= getSchema(tiptapExtensions);
  const nodes = schema.nodes;
  let budget = 40_000;
  let aborted = false;
  const typeOf = (n: unknown): string | null => {
    const t = typeof n === "object" && n !== null ? (n as { type?: unknown }).type : null;
    return typeof t === "string" && nodes[t] ? t : null;
  };
  const visit = (node: unknown, depth: number, path: string): string | null => {
    if (aborted) return null;
    if (--budget < 0 || depth > 40) {
      aborted = true;
      return null;
    }
    const type = typeOf(node);
    if (!type) return null; // noma'lum tur / shakl — chegaralar tekshiruvchisi xabar beradi
    const content = (node as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      if (content === undefined || content === null) {
        if (depth === 0 && (type === "doc")) return null;
        const m = nodes[type]!.contentMatch;
        return m.validEnd ? null : `${path}: a ${type} needs content (the editor's structure)`;
      }
      return null;
    }
    if (depth === 0 && type === "doc" && content.length === 0) return null;
    let match = nodes[type]!.contentMatch;
    for (let i = 0; i < content.length; i++) {
      const childType = typeOf(content[i]);
      if (childType) {
        const next = match.matchType(nodes[childType]!);
        if (!next) return `${path}/${type}[${i}]: a ${childType} is not allowed inside a ${type} (the editor's structure: tables hold rows, rows hold cells, lists hold list items)`;
        match = next;
      }
      const inner = visit(content[i], depth + 1, `${path}/${type}[${i}]`);
      if (inner) return inner;
      if (aborted) return null;
    }
    if (!match.validEnd) return `${path}/${type}: its content is incomplete for the editor's structure (a ${type} cannot be empty or end here)`;
    return null;
  };
  const problem = visit(doc, 0, "doc");
  return aborted ? null : problem;
}

/**
 * Panel (admin muharriri) darajasi: muharrir schemasi bo'yicha tugun joylashuvi, so'ng resurs chegaralari va tur nomlari —
 * renderdan oldin, O'ZGARTIRMASDAN. Joylashuv birinchi: noto'g'ri tuzilgan hujjat (masalan, qator bo'lmagan jadval bolasi) tushunarli xabar bilan rad etiladi.
 */
export function validatePanelDocument(doc: unknown): { ok: true } | { ok: false; message: string } {
  const structure = structureProblem(doc);
  if (structure) return { ok: false, message: structure };
  const result = validateDocument(doc, { mode: "panel" });
  return result.ok ? { ok: true } : { ok: false, message: result.message };
}

/**
 * Konnektor darajasi: chegaralar + atribut ruxsat ro'yxati + xavfsiz URL + faqat blogning o'z rasmlari + muharrir sxemasi bo'yicha
 * kontent modeli (`Node.check()`). Tozalangan nusxani qaytaradi.
 */
export async function validateConnectorDocument(doc: unknown): Promise<{ ok: true; doc: unknown } | { ok: false; message: string }> {
  const result = validateDocument(doc, { mode: "connector", isAllowedImageUrl: await ownMediaMatcher() });
  if (!result.ok) return result;
  try {
    schema ??= getSchema(tiptapExtensions);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tiptap JSON
    schema.nodeFromJSON(result.doc as any).check();
  } catch (error) {
    return { ok: false, message: `the document does not follow the editor's structure (${error instanceof Error ? error.message.slice(0, 160) : "invalid content"})` };
  }
  return { ok: true, doc: result.doc };
}
