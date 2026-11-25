"use client";

import type { JSONContent } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { createEditorExtensions } from "@/components/admin/editor/kit";

/**
 * Revision matnini FAQAT O'QISH rejimida ko'rsatadi — tahrirlagichning o'zi (ProseMirror sxemasi) orqali. Xom HTML
 * hech qachon DOM'ga qo'yilmaydi, shuning uchun tozalanmagan HTML kirishi mumkin emas.
 */
export function RevisionContent({ contentJson }: { contentJson: unknown }) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: createEditorExtensions({ media: true, placeholder: "" }),
    content: (contentJson ?? { type: "doc", content: [] }) as JSONContent,
    editable: false,
    editorProps: { attributes: { class: "tiptap prose-article", "aria-label": "Versiya matni (faqat o'qish)", role: "document" } },
  });
  return (
    <div className="tiptap-editor-content" data-testid="revision-content">
      <EditorContent editor={editor} />
    </div>
  );
}
