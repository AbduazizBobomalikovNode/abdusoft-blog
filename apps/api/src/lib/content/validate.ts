import { getSchema } from "@tiptap/core";
import { validateDocument } from "@blog/shared";
import { ownMediaMatcher } from "../media/own-url.js";
import { tiptapExtensions } from "./render.js";

let schema: ReturnType<typeof getSchema> | null = null;

/** Panel (admin muharriri) darajasi: faqat resurs chegaralari va tur nomlari — renderdan oldin, O'ZGARTIRMASDAN. */
export function validatePanelDocument(doc: unknown): { ok: true } | { ok: false; message: string } {
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
