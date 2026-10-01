"use client";

import { CodeBlock } from "@tiptap/extension-code-block";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import { normalizeCodeLanguage } from "@blog/shared";

export const CODE_LANGUAGES: { value: string; label: string }[] = [
  { value: "typescript", label: "ts" },
  { value: "javascript", label: "js" },
  { value: "tsx", label: "tsx" },
  { value: "json", label: "json" },
  { value: "bash", label: "bash" },
  { value: "python", label: "python" },
  { value: "sql", label: "sql" },
  { value: "yaml", label: "yaml" },
  { value: "markdown", label: "md" },
  { value: "html", label: "html" },
  { value: "css", label: "css" },
  { value: "plaintext", label: "plain" },
];

function CodeBlockView({ node, updateAttributes, editor }: ReactNodeViewProps) {
  const raw = (node.attrs.language as string | null) ?? null;
  const current = normalizeCodeLanguage(raw) ?? "plaintext";
  const known = CODE_LANGUAGES.some((l) => l.value === current);
  return (
    <NodeViewWrapper className="code-block-view">
      <div className="code-block-bar" contentEditable={false}>
        <select
          className="code-lang-select"
          aria-label="Dasturlash tili"
          value={current}
          disabled={!editor.isEditable}
          onChange={(event) => updateAttributes({ language: event.target.value })}
        >
          {known ? null : <option value={current}>{current}</option>}
          {CODE_LANGUAGES.map((lang) => (
            <option key={lang.value} value={lang.value}>
              {lang.label}
            </option>
          ))}
        </select>
      </div>
      <pre>
        <NodeViewContent<"code"> as="code" />
      </pre>
    </NodeViewWrapper>
  );
}

const INDENT = "  ";

export const EditorCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },
  addKeyboardShortcuts() {
    const parent = this.parent?.() ?? {};
    return {
      ...parent,
      Tab: ({ editor }) => {
        if (!editor.isActive(this.name)) return false;
        const { state, view } = editor;
        const { from, to, empty } = state.selection;
        if (empty || !state.doc.textBetween(from, to).includes("\n")) {
          view.dispatch(state.tr.insertText(INDENT, from, to));
          return true;
        }
        return indentLines(editor, 1);
      },
      "Shift-Tab": ({ editor }) => (editor.isActive(this.name) ? indentLines(editor, -1) : false),
      "Mod-Enter": ({ editor }) => (editor.isActive(this.name) ? editor.commands.exitCode() : false),
    };
  },
});

/** Tanlangan qatorlarni surish (dir=1) yoki qaytarish (dir=-1). */
function indentLines(editor: import("@tiptap/core").Editor, dir: 1 | -1): boolean {
  const { state, view } = editor;
  const { $from, $to } = state.selection;
  const blockStart = $from.start();
  const text = $from.parent.textContent;
  const startOffset = $from.pos - blockStart;
  const endOffset = $to.pos - blockStart;
  const lineStart = text.lastIndexOf("\n", startOffset - 1) + 1;
  const endNl = text.indexOf("\n", endOffset);
  const lineEnd = endNl === -1 ? text.length : endNl;
  const lines = text.slice(lineStart, lineEnd).split("\n");
  const next = lines.map((l) => (dir === 1 ? INDENT + l : l.startsWith(INDENT) ? l.slice(INDENT.length) : l.replace(/^ ?/, "")));
  const joined = next.join("\n");
  const tr = state.tr.insertText(joined, blockStart + lineStart, blockStart + lineEnd);
  tr.setSelection(TextSelection.create(tr.doc, blockStart + lineStart, blockStart + lineStart + joined.length));
  view.dispatch(tr);
  return true;
}
