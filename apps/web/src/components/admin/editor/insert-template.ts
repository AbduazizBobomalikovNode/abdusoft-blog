import type { Editor, JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { buildTemplate, isHintText, type TemplateId } from "@blog/shared";

/** Qo'yilgan hudud ichidagi birinchi maslahat matnini tanlaydi — yozilganda uning o'rniga yoziladi. */
function selectFirstHint(editor: Editor, from: number): void {
  let target: { pos: number; size: number } | null = null;
  editor.state.doc.nodesBetween(from, editor.state.doc.content.size, (node, pos) => {
    if (target) return false;
    if (node.type.name === "paragraph" && node.content.size > 0 && isHintText(node.textContent)) {
      target = { pos, size: node.nodeSize };
      return false;
    }
    return true;
  });
  const hit = target as { pos: number; size: number } | null;
  if (!hit) {
    editor.commands.focus();
    return;
  }
  const { state, view } = editor;
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, hit.pos + 1, hit.pos + hit.size - 1)).scrollIntoView());
  editor.commands.focus();
}

/** Bo'sh hujjatda — to'liq almashtiradi; aks holda joriy blokdan keyin qo'yadi. */
export function insertNodes(editor: Editor, nodes: JSONContent[]): void {
  if (editor.isEmpty) {
    editor.chain().setContent({ type: "doc", content: nodes }, { emitUpdate: true }).run();
    selectFirstHint(editor, 0);
    return;
  }
  const { $from } = editor.state.selection;
  const at = $from.depth >= 1 ? $from.after(1) : $from.pos;
  editor.chain().insertContentAt(at, nodes).run();
  selectFirstHint(editor, at);
}

export function insertTemplate(editor: Editor, id: TemplateId): void {
  insertNodes(editor, buildTemplate(id));
}
