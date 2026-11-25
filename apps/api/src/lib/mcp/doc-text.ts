import type { ContentNode } from "@blog/shared";

const BLOCK_CONTAINERS = new Set(["doc", "blockquote", "bulletList", "orderedList", "listItem", "table", "tableRow"]);

function inlineText(node: ContentNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "image") {
    const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
    return alt ? `[image: ${alt}]` : "[image]";
  }
  return (node.content ?? []).map(inlineText).join("");
}

function blockLines(node: ContentNode, out: string[]): void {
  if (node.type === "bulletList" || node.type === "orderedList") {
    (node.content ?? []).forEach((item, index) => {
      const text = (item.content ?? []).map((child) => inlineText(child)).join(" ").replace(/\s+/g, " ").trim();
      out.push(`${node.type === "orderedList" ? `${index + 1}.` : "-"} ${text}`);
    });
    out.push("");
    return;
  }
  if (node.type === "tableRow") {
    out.push((node.content ?? []).map((cell) => inlineText(cell).replace(/\s+/g, " ").trim()).join(" | "));
    return;
  }
  if (node.type && BLOCK_CONTAINERS.has(node.type)) {
    for (const child of node.content ?? []) blockLines(child, out);
    if (node.type === "table") out.push("");
    return;
  }
  if (node.type === "codeBlock") {
    out.push(inlineText(node), "");
    return;
  }
  if (node.type === "horizontalRule") {
    out.push("---", "");
    return;
  }
  const text = inlineText(node).trim();
  if (node.type === "heading" && text) {
    const level = typeof node.attrs?.level === "number" ? Math.min(6, Math.max(1, node.attrs.level)) : 2;
    out.push(`${"#".repeat(level)} ${text}`, "");
    return;
  }
  if (text) out.push(text, "");
}

/**
 * Tiptap hujjatidan model o'qiy oladigan matn: bloklar bo'sh qator bilan ajratiladi, sarlavhalar `#` bilan, ro'yxatlar `- `/`1.` bilan,
 * jadval qatorlari `|` bilan. Bu Markdown serializatori EMAS (repoda teskari konverter yo'q — `markdownToDoc` faqat
 * bir tomonlama): inline format yo'qoladi (qalin/kursiv/havola). Aniq tahrir uchun
 * `content.document` (Tiptap JSON) ham qaytariladi.
 */
export function docToReadableText(doc: ContentNode | null | undefined): string {
  if (!doc) return "";
  const out: string[] = [];
  blockLines(doc, out);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
