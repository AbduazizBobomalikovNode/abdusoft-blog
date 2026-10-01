"use client";

import { useRef, useState } from "react";
import type { Editor, JSONContent } from "@tiptap/core";
import { FileText, FileUp, LayoutTemplate, ListChecks, Newspaper, Footprints } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { markdownToDoc } from "@blog/shared";
import { TEMPLATES, type TemplateId } from "@blog/shared";
import { insertNodes, insertTemplate } from "./insert-template";

const TEMPLATE_ICONS: Record<TemplateId, typeof FileText> = {
  article: FileText,
  guide: Footprints,
  tips: ListChecks,
  news: Newspaper,
};

/** Hujjatga Markdown qo'yadi; birinchi `# ` sarlavha post sarlavhasiga (agar bo'sh/standart bo'lsa) o'tadi. */
export function applyMarkdown(editor: Editor, text: string, setTitle: ((title: string) => void) | null): boolean {
  if (!text.trim()) return false;
  const { title, doc } = markdownToDoc(text);
  const nodes: JSONContent[] = [...(doc.content ?? [])];
  if (title && setTitle) setTitle(title);
  else if (title) nodes.unshift({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: title }] });
  insertNodes(editor, nodes);
  return true;
}

export function MarkdownImportForm({ editor, setTitle, onDone }: { editor: Editor; setTitle: ((title: string) => void) | null; onDone: () => void }) {
  const [text, setText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    if (file.size > 2 * 1024 * 1024) {
      toast.error("Fayl 2 MB dan katta");
      return;
    }
    setText(await file.text());
  }

  return (
    <div className="flex flex-col gap-2" data-testid="markdown-import">
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={"# Sarlavha\n\nMarkdown matnini shu yerga qo'ying…"}
        rows={7}
        className="font-mono text-xs"
        data-testid="markdown-textarea"
      />
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          className="hidden"
          data-testid="markdown-file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void handleFile(file);
          }}
        />
        <Button type="button" variant="outline" size="sm" className="max-md:h-11" onClick={() => fileRef.current?.click()}>
          <FileUp className="size-4" />.md fayl tanlash
        </Button>
        <Button
          type="button"
          size="sm"
          className="max-md:h-11"
          disabled={!text.trim()}
          data-testid="markdown-apply"
          onClick={() => {
            if (applyMarkdown(editor, text, setTitle)) {
              setText("");
              onDone();
            }
          }}
        >
          Import qilish
        </Button>
      </div>
    </div>
  );
}

export function TemplateGrid({ editor, onPicked }: { editor: Editor; onPicked: () => void }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="template-grid">
      {TEMPLATES.map((t) => {
        const Icon = TEMPLATE_ICONS[t.id];
        return (
          <button
            key={t.id}
            type="button"
            data-testid={`template-${t.id}`}
            onClick={() => {
              insertTemplate(editor, t.id);
              onPicked();
            }}
            className="flex min-h-11 items-start gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          >
            <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{t.title}</span>
              <span className="block text-xs text-muted-foreground">{t.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** "⋯" menyusidagi "Shablon qo'shish": shablonlar + Markdown import (kursor o'rniga qo'yiladi). */
export function InsertDialog({
  editor,
  open,
  onOpenChange,
  setTitle,
}: {
  editor: Editor;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  setTitle: ((title: string) => void) | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88svh] overflow-y-auto sm:max-w-xl" data-testid="insert-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><LayoutTemplate className="size-4" />Shablon qo&apos;shish</DialogTitle>
          <DialogDescription>Tanlangan shablon kursor turgan joyga qo&apos;yiladi (bo&apos;sh sahifada — butun matnni to&apos;ldiradi).</DialogDescription>
        </DialogHeader>
        <TemplateGrid editor={editor} onPicked={() => onOpenChange(false)} />
        <h3 className="text-sm font-medium">Markdown import</h3>
        <MarkdownImportForm editor={editor} setTitle={setTitle} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
