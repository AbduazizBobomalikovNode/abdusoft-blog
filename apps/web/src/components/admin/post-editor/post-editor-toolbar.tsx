"use client";

import type { Editor } from "@tiptap/core";
import { BubbleMenu } from "@tiptap/react/menus";
import { Bold, Code, Italic, Link2, Strikethrough, Underline } from "lucide-react";
import { OPEN_LINK_EVENT } from "@/components/admin/editor/events";
import { cn } from "@/lib/utils";

function ToolbarButton({
  active,
  label,
  onClick,
  children,
}: {
  active?: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "flex size-7 items-center justify-center rounded-md text-sm hover:bg-muted",
        active && "bg-muted text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Desktopda tanlangan matn ustida tezkor inline formatlash. Mobilda yo'q — u yerda klaviatura tepasidagi
 * asboblar paneli bor (tanlov menyusi tizim "nusxa/qo'yish" menyusi bilan to'qnashmasligi uchun).
 */
export function PostEditorBubbleMenu({ editor }: { editor: Editor }) {
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="textBubbleMenu"
      shouldShow={({ editor: ed, from, to }) =>
        ed.isEditable && from !== to && !ed.isActive("codeBlock") && !ed.isActive("image") && window.matchMedia("(min-width: 768px)").matches
      }
      className="editor-bubble-menu"
    >
      <ToolbarButton label="Qalin" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold className="size-4" />
      </ToolbarButton>
      <ToolbarButton label="Kursiv" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic className="size-4" />
      </ToolbarButton>
      <ToolbarButton label="Tagiga chizilgan" active={editor.isActive("underline")} onClick={() => editor.chain().focus().toggleUnderline().run()}>
        <Underline className="size-4" />
      </ToolbarButton>
      <ToolbarButton label="Kesilgan" active={editor.isActive("strike")} onClick={() => editor.chain().focus().toggleStrike().run()}>
        <Strikethrough className="size-4" />
      </ToolbarButton>
      <ToolbarButton label="Kod" active={editor.isActive("code")} onClick={() => editor.chain().focus().toggleCode().run()}>
        <Code className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        label="Havola"
        active={editor.isActive("link")}
        onClick={() => window.dispatchEvent(new CustomEvent(OPEN_LINK_EVENT, { detail: { editor } }))}
      >
        <Link2 className="size-4" />
      </ToolbarButton>
    </BubbleMenu>
  );
}
