"use client";

import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { useEditorState } from "@tiptap/react";
import { ImageUp, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { IMAGE_PICKER_EVENT } from "./events";
import { uploadImages, validateImageFile } from "./extensions/upload-placeholders";
import { FloatingPanel, rectOf, useAnchorRect, type AnchorRect } from "./floating";
import { AdminApiError, adminApi } from "@/lib/admin-client";

interface SelectedImage {
  pos: number;
  alt: string;
}

function selectedImage(editor: Editor): SelectedImage | null {
  const { selection } = editor.state;
  if (selection instanceof NodeSelection && selection.node.type.name === "image") {
    return { pos: selection.from, alt: String(selection.node.attrs.alt ?? "") };
  }
  return null;
}

async function replaceImage(editor: Editor, pos: number, file: File): Promise<void> {
  const problem = validateImageFile(file);
  if (problem) {
    toast.error(problem);
    return;
  }
  const toastId = toast.loading("Rasm almashtirilmoqda…");
  try {
    const media = await adminApi.uploadMediaWithProgress(file);
    const node = editor.state.doc.nodeAt(pos);
    if (!node || node.type.name !== "image") throw new Error("Rasm topilmadi");
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: media.url }));
    toast.success("Rasm almashtirildi", { id: toastId });
  } catch (error) {
    toast.error(error instanceof AdminApiError ? error.message : "Rasmni almashtirib bo'lmadi", { id: toastId });
  }
}

/** Yashirin fayl tanlagich: "Rasm" bandi (qo'shish) va "Almashtirish" (replacePos) uchun. */
export function ImagePicker({ editor }: { editor: Editor }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const replacePos = useRef<number | null>(null);

  useEffect(() => {
    const onOpen = (event: Event) => {
      replacePos.current = (event as CustomEvent<{ replacePos?: number }>).detail?.replacePos ?? null;
      inputRef.current?.click();
    };
    window.addEventListener(IMAGE_PICKER_EVENT, onOpen);
    return () => window.removeEventListener(IMAGE_PICKER_EVENT, onOpen);
  }, []);

  return (
    <input
      ref={inputRef}
      type="file"
      accept="image/*"
      multiple
      className="hidden"
      data-testid="image-file-input"
      onChange={(event) => {
        const files = Array.from(event.target.files ?? []);
        event.target.value = "";
        if (files.length === 0) return;
        const pos = replacePos.current;
        replacePos.current = null;
        if (pos !== null && files[0]) void replaceImage(editor, pos, files[0]);
        else void uploadImages(editor, files);
      }}
    />
  );
}

function ImagePanel({ editor, pos, initialAlt, rect }: { editor: Editor; pos: number; initialAlt: string; rect: AnchorRect | null }) {
  const [alt, setAlt] = useState(initialAlt);
  const timer = useRef<number | null>(null);

  function commit(value: string) {
    const node = editor.state.doc.nodeAt(pos);
    if (!node || node.type.name !== "image" || String(node.attrs.alt ?? "") === value) return;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, alt: value }));
  }

  const missing = alt.trim().length === 0;
  return (
    <FloatingPanel rect={rect} testId="image-toolbar" className="editor-image-panel">
      <div className="flex flex-wrap items-center gap-1.5 max-sm:w-[min(22rem,calc(100vw-1.5rem))]">
        <div className="relative min-w-0 flex-1">
          <input
            type="text"
            data-testid="image-alt-input"
            aria-label="Alt matn / izoh"
            placeholder="Alt matn / izoh…"
            value={alt}
            onChange={(event) => {
              const v = event.target.value;
              setAlt(v);
              if (timer.current) window.clearTimeout(timer.current);
              timer.current = window.setTimeout(() => commit(v), 350);
            }}
            onBlur={() => {
              if (timer.current) window.clearTimeout(timer.current);
              commit(alt);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                if (timer.current) window.clearTimeout(timer.current);
                commit(alt);
                editor.commands.focus();
              }
            }}
            className={`editor-panel-input w-64 max-sm:w-full ${missing ? "is-warn" : ""}`}
          />
        </div>
        {missing ? (
          <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400" data-testid="image-alt-warning">
            <TriangleAlert className="size-3.5" />Alt matn yo&apos;q
          </span>
        ) : null}
        <button type="button" className="editor-panel-btn" onClick={() => window.dispatchEvent(new CustomEvent(IMAGE_PICKER_EVENT, { detail: { replacePos: pos } }))}>
          <ImageUp className="size-3.5" />Almashtirish
        </button>
        <button type="button" className="editor-panel-btn is-danger" data-testid="image-delete" onClick={() => editor.chain().focus().deleteSelection().run()}>
          <Trash2 className="size-3.5" />O&apos;chirish
        </button>
      </div>
    </FloatingPanel>
  );
}

/** Tanlangan rasm ustida: alt matn, almashtirish, o'chirish. */
export function ImageToolbar({ editor }: { editor: Editor }) {
  const img = useEditorState({ editor, selector: ({ editor: ed }) => selectedImage(ed) });
  const rect = useAnchorRect(editor, (ed) => {
    const sel = selectedImage(ed);
    if (!sel) return null;
    const dom = ed.view.nodeDOM(sel.pos);
    return dom instanceof Element ? rectOf(dom) : null;
  });
  if (!img) return null;
  // `key` — boshqa rasm tanlansa alt maydoni yangidan boshlanadi.
  return <ImagePanel key={img.pos} editor={editor} pos={img.pos} initialAlt={img.alt} rect={rect} />;
}
