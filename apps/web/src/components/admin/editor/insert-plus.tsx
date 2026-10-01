"use client";

import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { Plus } from "lucide-react";
import { openSlashMenuFromPlus } from "./extensions/slash-command";
import { useIsMobile } from "./use-media-query";
import { useAnchorRect } from "./floating";

/** Bo'sh qatorda "+" tugmasi: desktopda chap gutter'da, mobilda qatorning o'ng chetida. "/" bilan bir xil menyuni ochadi. */
export function InsertPlus({ editor }: { editor: Editor }) {
  const isMobile = useIsMobile();
  const onEmptyLine = useEditorState({
    editor,
    selector: ({ editor: ed }) => {
      const { selection } = ed.state;
      const { $from } = selection;
      return ed.isEditable && ed.isFocused && selection.empty && $from.depth === 1 && $from.parent.type.name === "paragraph" && $from.parent.content.size === 0;
    },
  });

  const rect = useAnchorRect(editor, (ed) => {
    if (!ed.isEditable || !ed.isFocused) return null;
    const { selection } = ed.state;
    const { $from } = selection;
    if (!(selection.empty && $from.depth === 1 && $from.parent.type.name === "paragraph" && $from.parent.content.size === 0)) return null;
    const coords = ed.view.coordsAtPos(selection.from);
    const dom = ed.view.dom.getBoundingClientRect();
    return { top: coords.top, bottom: coords.bottom, left: dom.left, right: dom.right };
  });

  if (!onEmptyLine || !rect) return null;
  const size = isMobile ? 36 : 28;
  const top = (rect.top + rect.bottom) / 2 - size / 2;
  const left = isMobile ? rect.right - size : rect.left - size - 12;

  return (
    <button
      type="button"
      data-testid="insert-plus"
      aria-label="Blok qo'shish"
      title='Blok qo&apos;shish ("/")'
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => openSlashMenuFromPlus(editor)}
      className="editor-insert-plus"
      style={{ position: "fixed", top: Math.round(top), left: Math.round(left), width: size, height: size }}
    >
      <Plus className="size-4" />
    </button>
  );
}
