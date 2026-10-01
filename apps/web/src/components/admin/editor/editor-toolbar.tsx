"use client";

import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import {
  ArrowDown,
  ArrowUp,
  Bold,
  Code,
  Code2,
  Eraser,
  Heading2,
  Heading3,
  ImageIcon,
  Italic,
  Keyboard,
  Link2,
  List,
  ListOrdered,
  Maximize2,
  MessageSquareQuote,
  MoreHorizontal,
  Pilcrow,
  Plus,
  Quote,
  Redo2,
  Strikethrough,
  Table2,
  Underline,
  Undo2,
  Minus,
} from "lucide-react";
import { activeCallout, toggleCallout, type CalloutVariant } from "./callout";
import { BLOCK_ITEMS, availableBlockItems } from "./block-items";
import { OPEN_LINK_EVENT, OPEN_SHORTCUTS_EVENT } from "./events";
import { formatShortcut } from "./shortcuts";
import { ToolbarMenu, ToolbarMenuItem } from "./toolbar-menu";
import { moveBlock } from "./extensions/block-move";
import { useIsMobile } from "./use-media-query";
import { useKeyboardPin } from "./use-keyboard-pin";
import { cn } from "@/lib/utils";


function Btn({
  label,
  shortcut,
  active,
  disabled,
  onClick,
  children,
  testId,
}: {
  label: string;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  const title = shortcut ? `${label} (${formatShortcut(shortcut)})` : label;
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      aria-pressed={active}
      title={title}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn("editor-tb-btn", active && "is-active")}
    >
      {children}
    </button>
  );
}

const Sep = () => <span aria-hidden className="editor-tb-sep" />;

const CALLOUT_ITEMS: { variant: CalloutVariant; label: string; emoji: string }[] = [
  { variant: "info", label: "Ma'lumot", emoji: "ℹ️" },
  { variant: "warning", label: "Ogohlantirish", emoji: "⚠️" },
  { variant: "tip", label: "Maslahat", emoji: "💡" },
];

export function EditorToolbar({
  editor,
  onToggleFocus,
  focusMode = false,
  className,
}: {
  editor: Editor;
  /** Berilsa — "Diqqat rejimi" bandi ko'rsatiladi (faqat post muharririda). */
  onToggleFocus?: () => void;
  focusMode?: boolean;
  className?: string;
}) {
  const isMobile = useIsMobile();
  const barRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(() => editor.isFocused);
  useKeyboardPin(barRef, isMobile);

  useEffect(() => {
    const onFocus = () => setFocused(true);
    const onBlur = () => {
      // Tugmalar `mousedown`ni to'xtatadi — haqiqiy blur bo'lsagina yashiramiz (kichik kechikish bilan).
      window.setTimeout(() => {
        if (!editor.isDestroyed && !editor.isFocused && !barRef.current?.contains(document.activeElement)) setFocused(false);
      }, 120);
    };
    editor.on("focus", onFocus);
    editor.on("blur", onBlur);
    return () => {
      editor.off("focus", onFocus);
      editor.off("blur", onBlur);
    };
  }, [editor]);

  const s = useEditorState({
    editor,
    selector: ({ editor: ed }) => ({
      bold: ed.isActive("bold"),
      italic: ed.isActive("italic"),
      underline: ed.isActive("underline"),
      strike: ed.isActive("strike"),
      code: ed.isActive("code"),
      link: ed.isActive("link"),
      h2: ed.isActive("heading", { level: 2 }),
      h3: ed.isActive("heading", { level: 3 }),
      bullet: ed.isActive("bulletList"),
      ordered: ed.isActive("orderedList"),
      quote: ed.isActive("blockquote"),
      callout: activeCallout(ed),
      codeBlock: ed.isActive("codeBlock"),
      table: ed.isActive("table"),
      canUndo: ed.can().undo(),
      canRedo: ed.can().redo(),
      editable: ed.isEditable,
    }),
  });

  const placement = isMobile ? "up" : "down";
  const hasImage = !!editor.schema.nodes.image;
  const hasTable = !!editor.schema.nodes.table;
  const blockLabel = s.h2 ? "Sarlavha 2" : s.h3 ? "Sarlavha 3" : "Matn";
  const BlockIcon = s.h2 ? Heading2 : s.h3 ? Heading3 : Pilcrow;
  const chain = () => editor.chain().focus();
  const insertItems = availableBlockItems(editor).filter((i) => !["paragraph", "h2", "h3"].includes(i.id));

  return (
    <div
      ref={barRef}
      data-editor-toolbar
      data-visible={isMobile ? focused : true}
      role="toolbar"
      aria-label="Formatlash"
      aria-disabled={!s.editable}
      className={cn("editor-toolbar", s.editable ? "" : "pointer-events-none opacity-50", className)}
    >
      <div className="editor-toolbar-scroll">
        <Btn label="Ortga" shortcut="Mod+Z" disabled={!s.canUndo} onClick={() => chain().undo().run()} testId="tb-undo"><Undo2 className="size-4" /></Btn>
        <Btn label="Qayta bajarish" shortcut="Mod+Shift+Z" disabled={!s.canRedo} onClick={() => chain().redo().run()} testId="tb-redo"><Redo2 className="size-4" /></Btn>
        <Sep />
        <ToolbarMenu label={`Blok turi: ${blockLabel}`} testId="tb-block" placement={placement} icon={<BlockIcon className="size-4" />} active={s.h2 || s.h3}>
          {(close) => (
            <>
              <ToolbarMenuItem testId="tb-block-p" icon={<Pilcrow className="size-4" />} label="Matn" hint={formatShortcut("Mod+Alt+0")} active={!s.h2 && !s.h3} onSelect={() => { chain().setParagraph().run(); close(); }} />
              <ToolbarMenuItem testId="tb-block-h2" icon={<Heading2 className="size-4" />} label="Sarlavha 2" hint={formatShortcut("Mod+Alt+2")} active={s.h2} onSelect={() => { chain().setNode("heading", { level: 2 }).run(); close(); }} />
              <ToolbarMenuItem testId="tb-block-h3" icon={<Heading3 className="size-4" />} label="Sarlavha 3" hint={formatShortcut("Mod+Alt+3")} active={s.h3} onSelect={() => { chain().setNode("heading", { level: 3 }).run(); close(); }} />
            </>
          )}
        </ToolbarMenu>
        <Sep />
        <Btn label="Qalin" shortcut="Mod+B" active={s.bold} onClick={() => chain().toggleBold().run()} testId="tb-bold"><Bold className="size-4" /></Btn>
        <Btn label="Kursiv" shortcut="Mod+I" active={s.italic} onClick={() => chain().toggleItalic().run()} testId="tb-italic"><Italic className="size-4" /></Btn>
        <Btn label="Tagiga chizilgan" shortcut="Mod+U" active={s.underline} onClick={() => chain().toggleUnderline().run()} testId="tb-underline"><Underline className="size-4" /></Btn>
        <Btn label="Ustidan chizilgan" shortcut="Mod+Shift+S" active={s.strike} onClick={() => chain().toggleStrike().run()} testId="tb-strike"><Strikethrough className="size-4" /></Btn>
        <Btn label="Satr ichidagi kod" shortcut="Mod+E" active={s.code} onClick={() => chain().toggleCode().run()} testId="tb-code"><Code className="size-4" /></Btn>
        <Btn label="Havola" shortcut="Mod+K" active={s.link} onClick={() => window.dispatchEvent(new CustomEvent(OPEN_LINK_EVENT, { detail: { editor } }))} testId="tb-link"><Link2 className="size-4" /></Btn>
        <Sep />
        <Btn label="Ro'yxat" shortcut="Mod+Shift+8" active={s.bullet} onClick={() => chain().toggleBulletList().run()} testId="tb-bullet"><List className="size-4" /></Btn>
        <Btn label="Raqamli ro'yxat" shortcut="Mod+Shift+7" active={s.ordered} onClick={() => chain().toggleOrderedList().run()} testId="tb-ordered"><ListOrdered className="size-4" /></Btn>
        <Btn label="Iqtibos" shortcut="Mod+Shift+B" active={s.quote && !s.callout} onClick={() => chain().toggleBlockquote().run()} testId="tb-quote"><Quote className="size-4" /></Btn>
        <ToolbarMenu label="Callout" testId="tb-callout" placement={placement} icon={<MessageSquareQuote className="size-4" />} active={!!s.callout}>
          {(close) =>
            CALLOUT_ITEMS.map((item) => (
              <ToolbarMenuItem key={item.variant} testId={`tb-callout-${item.variant}`} icon={<span className="w-4 text-center">{item.emoji}</span>} label={item.label} active={s.callout === item.variant} onSelect={() => { toggleCallout(editor, item.variant); close(); }} />
            ))
          }
        </ToolbarMenu>
        <Btn label="Kod bloki" shortcut="Mod+Alt+C" active={s.codeBlock} onClick={() => chain().toggleCodeBlock().run()} testId="tb-codeblock"><Code2 className="size-4" /></Btn>
        {hasImage ? <Btn label="Rasm" onClick={() => BLOCK_ITEMS.find((i) => i.id === "image")?.run(editor)} testId="tb-image"><ImageIcon className="size-4" /></Btn> : null}
        {hasTable ? <Btn label="Jadval" active={s.table} onClick={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} testId="tb-table"><Table2 className="size-4" /></Btn> : null}
        <Btn label="Ajratgich" onClick={() => chain().setHorizontalRule().run()} testId="tb-divider"><Minus className="size-4" /></Btn>
        <Sep />
        <Btn label="Formatlashni tozalash" onClick={() => chain().clearNodes().unsetAllMarks().run()} testId="tb-clear"><Eraser className="size-4" /></Btn>
        <ToolbarMenu label="Qo'shish" testId="tb-insert" placement={placement} icon={<Plus className="size-4" />}>
          {(close) =>
            insertItems.map((item) => {
              const Icon = item.icon;
              return <ToolbarMenuItem key={item.id} icon={<Icon className="size-4" />} label={item.title} onSelect={() => { item.run(editor); close(); }} />;
            })
          }
        </ToolbarMenu>
        <ToolbarMenu label="Ko'proq" testId="tb-more" placement={placement} icon={<MoreHorizontal className="size-4" />}>
          {(close) => (
            <>
              <ToolbarMenuItem icon={<ArrowUp className="size-4" />} label="Blokni yuqoriga" hint={formatShortcut("Alt+Up")} onSelect={() => { const tr = moveBlock(editor.state, -1); if (tr) editor.view.dispatch(tr); editor.commands.focus(); close(); }} />
              <ToolbarMenuItem icon={<ArrowDown className="size-4" />} label="Blokni pastga" hint={formatShortcut("Alt+Down")} onSelect={() => { const tr = moveBlock(editor.state, 1); if (tr) editor.view.dispatch(tr); editor.commands.focus(); close(); }} />
              {onToggleFocus ? <ToolbarMenuItem icon={<Maximize2 className="size-4" />} label={focusMode ? "Diqqat rejimidan chiqish" : "Diqqat rejimi"} hint={formatShortcut("Mod+Shift+F")} onSelect={() => { onToggleFocus(); close(); }} /> : null}
              <ToolbarMenuItem icon={<Keyboard className="size-4" />} label="Tezkor tugmalar" hint={formatShortcut("Mod+/")} onSelect={() => { window.dispatchEvent(new CustomEvent(OPEN_SHORTCUTS_EVENT)); close(); }} />
            </>
          )}
        </ToolbarMenu>
      </div>
    </div>
  );
}
