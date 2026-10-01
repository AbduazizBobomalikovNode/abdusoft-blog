/**
 * Maxsus kanal versiyasi hujjatining Telegram "ko'rinadigan" uzunligi — API'dagi
 * `telegramVisibleLength(renderRestrictedDoc(doc))` bilan AYNAN bir xil natija
 * (bloklar orasida "\n\n", blockquote/ro'yxat ichida "\n", bo'sh bloklar tashlanadi,
 * ro'yxat belgilari "• " / "N. " hisobga olinadi). Web muharriri jonli hisoblagich
 * uchun ishlatadi, shunda saqlashdan keyin son "sakramaydi".
 */

interface DocNode {
  type?: string;
  text?: string;
  content?: DocNode[];
}

function inlineText(nodes: DocNode[] | undefined): string {
  if (!nodes) return "";
  return nodes
    .map((node) => {
      if (node.type === "text") return node.text ?? "";
      if (node.type === "hardBreak") return "\n";
      return inlineText(node.content);
    })
    .join("");
}

function listItemLine(item: DocNode): string {
  return (item.content ?? [])
    .map((child) => inlineText(child.type === "paragraph" ? child.content : [child]))
    .join(" ")
    .trim();
}

function blockText(node: DocNode): string | null {
  switch (node.type) {
    case "paragraph": {
      const text = inlineText(node.content);
      return text.trim() ? text.replace(/^\n+|\n+$/g, "") : null;
    }
    case "bulletList":
    case "orderedList": {
      const lines = (node.content ?? [])
        .map(listItemLine)
        .filter(Boolean)
        .map((text, idx) => `${node.type === "orderedList" ? `${idx + 1}.` : "•"} ${text}`);
      return lines.length > 0 ? lines.join("\n") : null;
    }
    case "blockquote": {
      const inner = (node.content ?? [])
        .map(blockText)
        .filter((b): b is string => Boolean(b))
        .join("\n");
      return inner || null;
    }
    default:
      return null;
  }
}

export function channelDocVisibleLength(doc: unknown): number {
  const root = (doc ?? {}) as DocNode;
  return (root.content ?? [])
    .map(blockText)
    .filter((b): b is string => Boolean(b))
    .join("\n\n")
    .trim().length;
}
