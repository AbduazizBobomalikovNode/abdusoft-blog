"use client";

import type { Editor } from "@tiptap/core";
import { BubbleMenu } from "@tiptap/react/menus";
import { Bold, Code, Italic, Link2, Strikethrough } from "lucide-react";
import { cn } from "@/lib/utils";

const CODE_LANGUAGES = [
  { value: "typescript", label: "ts" },
  { value: "javascript", label: "js" },
  { value: "tsx", label: "tsx" },
  { value: "json", label: "json" },
  { value: "bash", label: "bash" },
  { value: "python", label: "python" },
  { value: "sql", label: "sql" },
  { value: "yaml", label: "yaml" },
  { value: "markdown", label: "md" },
  { value: "plaintext", label: "plain" },
];

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

export function PostEditorBubbleMenu({ editor }: { editor: Editor }) {
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="textBubbleMenu"
      shouldShow={({ editor: ed, from, to }) => from !== to && !ed.isActive("codeBlock")}
      className="editor-bubble-menu"
    >
      <ToolbarButton
        label="Qalin"
        active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <Bold className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        label="Kursiv"
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <Italic className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        label="Kesilgan"
        active={editor.isActive("strike")}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      >
        <Strikethrough className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        label="Kod"
        active={editor.isActive("code")}
        onClick={() => editor.chain().focus().toggleCode().run()}
      >
        <Code className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        label="Havola"
        active={editor.isActive("link")}
        onClick={() => {
          if (editor.isActive("link")) {
            editor.chain().focus().unsetLink().run();
            return;
          }
          const url = window.prompt("Havola URL manzili:");
          if (url) editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
        }}
      >
        <Link2 className="size-4" />
      </ToolbarButton>
    </BubbleMenu>
  );
}

export function CodeBlockLanguageMenu({ editor }: { editor: Editor }) {
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="codeBlockLangMenu"
      shouldShow={({ editor: ed }) => ed.isActive("codeBlock")}
      className="code-block-lang-menu"
      options={{ placement: "top-start" }}
    >
      <select
        value={(editor.getAttributes("codeBlock").language as string | undefined) ?? "plaintext"}
        onChange={(event) =>
          editor.chain().focus().updateAttributes("codeBlock", { language: event.target.value }).run()
        }
      >
        {CODE_LANGUAGES.map((lang) => (
          <option key={lang.value} value={lang.value}>
            {lang.label}
          </option>
        ))}
      </select>
    </BubbleMenu>
  );
}
