"use client";

import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { ArrowDownToLine, ArrowLeftToLine, ArrowRightToLine, ArrowUpToLine, PanelTop, Rows3, Columns3, Trash2 } from "lucide-react";
import { FloatingPanel, rectOf, useAnchorRect } from "./floating";

function tableElement(editor: Editor): Element | null {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === "table") {
      const dom = editor.view.nodeDOM($from.before(d));
      if (!(dom instanceof Element)) return null;
      return dom.querySelector("table") ?? dom;
    }
  }
  return null;
}

function Item({ label, onClick, children, danger }: { label: string; onClick: () => void; children: React.ReactNode; danger?: boolean }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} className={`editor-panel-btn ${danger ? "is-danger" : ""}`}>
      {children}
      <span className="max-2xl:sr-only">{label}</span>
    </button>
  );
}

/** Kursor jadval ichida bo'lganda — jadval ustida kichik asboblar paneli. */
export function TableToolbar({ editor }: { editor: Editor }) {
  const inTable = useEditorState({ editor, selector: ({ editor: ed }) => ed.isActive("table") && ed.isEditable });
  const rect = useAnchorRect(editor, (ed) => {
    const el = tableElement(ed);
    return el ? rectOf(el) : null;
  });
  if (!inTable) return null;
  const chain = () => editor.chain().focus();

  return (
    <FloatingPanel rect={rect} testId="table-toolbar" className="editor-table-panel" align="start">
      <div className="flex items-center gap-1 overflow-x-auto max-sm:max-w-[calc(100vw-1.5rem)]" data-table-toolbar>
        <Item label="Yuqoriga qator" onClick={() => chain().addRowBefore().run()}><ArrowUpToLine className="size-3.5" /></Item>
        <Item label="Pastga qator" onClick={() => chain().addRowAfter().run()}><ArrowDownToLine className="size-3.5" /></Item>
        <Item label="Chapga ustun" onClick={() => chain().addColumnBefore().run()}><ArrowLeftToLine className="size-3.5" /></Item>
        <Item label="O'ngga ustun" onClick={() => chain().addColumnAfter().run()}><ArrowRightToLine className="size-3.5" /></Item>
        <span aria-hidden className="editor-tb-sep" />
        <Item label="Qatorni o'chirish" onClick={() => chain().deleteRow().run()}><Rows3 className="size-3.5" /></Item>
        <Item label="Ustunni o'chirish" onClick={() => chain().deleteColumn().run()}><Columns3 className="size-3.5" /></Item>
        <Item label="Sarlavha qatori" onClick={() => chain().toggleHeaderRow().run()}><PanelTop className="size-3.5" /></Item>
        <Item label="Jadvalni o'chirish" danger onClick={() => chain().deleteTable().run()}><Trash2 className="size-3.5" /></Item>
      </div>
    </FloatingPanel>
  );
}
