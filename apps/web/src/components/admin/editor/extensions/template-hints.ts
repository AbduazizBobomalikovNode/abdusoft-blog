import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { isHintText } from "@blog/shared";

/**
 * Shablon maslahat matnlari: ko'rinishi (xira) va Tab bilan keyingisiga o'tish.
 * Hujjatda hech narsa o'zgarmaydi — faqat dekoratsiya.
 */
const hintKey = new PluginKey<DecorationSet>("templateHints");

function build(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "paragraph" && node.content.size > 0 && isHintText(node.textContent)) {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "is-template-hint" }));
    }
    return !node.isTextblock;
  });
  return DecorationSet.create(doc, decorations);
}

export const TemplateHints = Extension.create({
  name: "templateHints",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: hintKey,
        state: {
          init: (_, state) => build(state.doc),
          apply: (tr, old) => (tr.docChanged ? build(tr.doc) : old),
        },
        props: { decorations: (state) => hintKey.getState(state) },
      }),
    ];
  },
  addKeyboardShortcuts() {
    return {
      Tab: () => {
        const { state, view } = this.editor;
        const { $from } = state.selection;
        for (let d = $from.depth; d > 0; d--) {
          const name = $from.node(d).type.name;
          if (name === "listItem" || name === "tableCell" || name === "tableHeader" || name === "codeBlock") return false;
        }
        const next = hintKey.getState(state)?.find().find((d) => d.from > $from.pos);
        if (!next) return false;
        const node = state.doc.nodeAt(next.from);
        if (!node) return false;
        view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, next.from + 1, next.from + node.nodeSize - 1)).scrollIntoView());
        return true;
      },
    };
  },
});
