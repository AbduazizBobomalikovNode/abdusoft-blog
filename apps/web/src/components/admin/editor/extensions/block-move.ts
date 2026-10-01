import { Extension } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";

/** Alt+↑/↓: kursor turgan blokni (ro'yxatda — ro'yxat elementini) qo'shnisi bilan almashtiradi. */
export function moveBlock(state: EditorState, dir: -1 | 1): Transaction | null {
  const { selection } = state;
  let parentIndex: { index: number; childCount: number; child: (i: number) => import("@tiptap/pm/model").Node };
  let start: number;

  if (selection instanceof NodeSelection) {
    const $pos = state.doc.resolve(selection.from);
    parentIndex = { index: $pos.index(), childCount: $pos.parent.childCount, child: (i) => $pos.parent.child(i) };
    start = selection.from;
  } else {
    const { $from } = selection;
    if ($from.depth < 1) return null;
    let depth = 1;
    for (let d = $from.depth; d >= 1; d--) {
      if ($from.node(d).type.name === "listItem") {
        depth = d;
        break;
      }
    }
    const parent = $from.node(depth - 1);
    parentIndex = { index: $from.index(depth - 1), childCount: parent.childCount, child: (i) => parent.child(i) };
    start = $from.before(depth);
  }

  const siblingIndex = parentIndex.index + dir;
  if (siblingIndex < 0 || siblingIndex >= parentIndex.childCount) return null;
  const node = parentIndex.child(parentIndex.index);
  const sibling = parentIndex.child(siblingIndex);
  const delta = dir === -1 ? -sibling.nodeSize : sibling.nodeSize;
  const rangeFrom = dir === -1 ? start - sibling.nodeSize : start;
  const rangeTo = dir === -1 ? start + node.nodeSize : start + node.nodeSize + sibling.nodeSize;
  const tr = state.tr.replaceWith(rangeFrom, rangeTo, dir === -1 ? [node, sibling] : [sibling, node]);
  if (selection instanceof NodeSelection) tr.setSelection(NodeSelection.create(tr.doc, selection.from + delta));
  else tr.setSelection(TextSelection.create(tr.doc, selection.anchor + delta, selection.head + delta));
  return tr.scrollIntoView();
}

export const BlockMove = Extension.create({
  name: "blockMove",
  addKeyboardShortcuts() {
    const run = (dir: -1 | 1) => () => {
      const tr = moveBlock(this.editor.state, dir);
      // Chegarada ham brauzerning "paragraf boshiga" harakatini to'xtatamiz.
      if (tr) this.editor.view.dispatch(tr);
      return true;
    };
    return { "Alt-ArrowUp": run(-1), "Alt-ArrowDown": run(1) };
  },
});
