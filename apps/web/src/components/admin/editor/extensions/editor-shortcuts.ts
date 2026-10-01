import { Extension } from "@tiptap/core";
import { OPEN_LINK_EVENT } from "../events";

/** Mod+K — havola oynasi (`LinkPopover` tinglaydi). */
export const EditorShortcuts = Extension.create({
  name: "editorShortcuts",
  addKeyboardShortcuts() {
    return {
      "Mod-k": () => {
        if (!this.editor.schema.marks.link) return false;
        window.dispatchEvent(new CustomEvent(OPEN_LINK_EVENT, { detail: { editor: this.editor } }));
        return true;
      },
    };
  },
});
