import type { Editor } from "@tiptap/core";

/** Callout = `blockquote` + birinchi paragraf emoji bilan boshlanadi (render.ts shu konventsiyani biladi). */
export const CALLOUT_MARKERS = { info: "ℹ️", warning: "⚠️", tip: "💡" } as const;
export type CalloutVariant = keyof typeof CALLOUT_MARKERS;

const ALL_MARKERS = Object.values(CALLOUT_MARKERS) as string[];

export function activeCallout(editor: Editor): CalloutVariant | null {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name !== "blockquote") continue;
    const text = $from.node(d).textContent.trimStart();
    const hit = (Object.entries(CALLOUT_MARKERS) as [CalloutVariant, string][]).find(([, m]) => text.startsWith(m));
    return hit ? hit[0] : null;
  }
  return null;
}

function inBlockquote(editor: Editor): boolean {
  return editor.isActive("blockquote");
}

/** Callout qo'yish / variantni almashtirish / bir xil variant bosilsa — olib tashlash. */
export function toggleCallout(editor: Editor, variant: CalloutVariant): void {
  const marker = CALLOUT_MARKERS[variant];
  const current = activeCallout(editor);

  if (current === variant) {
    removeMarker(editor);
    editor.chain().focus().lift("blockquote").run();
    return;
  }
  if (current) {
    removeMarker(editor);
    addMarker(editor, marker);
    return;
  }
  if (!inBlockquote(editor)) editor.chain().focus().toggleBlockquote().run();
  addMarker(editor, marker);
}

function quoteStart(editor: Editor): number | null {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === "blockquote") return $from.start(d) + 1; // birinchi paragraf ichi
  }
  return null;
}

function addMarker(editor: Editor, marker: string): void {
  const pos = quoteStart(editor);
  if (pos === null) return;
  editor.chain().focus().insertContentAt(pos, `${marker} `).run();
}

function removeMarker(editor: Editor): void {
  const pos = quoteStart(editor);
  if (pos === null) return;
  const text = editor.state.doc.textBetween(pos, Math.min(pos + 6, editor.state.doc.content.size), "\n");
  const marker = ALL_MARKERS.find((m) => text.startsWith(m));
  if (!marker) return;
  const extra = text.startsWith(`${marker} `) ? 1 : 0;
  editor.chain().focus().deleteRange({ from: pos, to: pos + marker.length + extra }).run();
}
