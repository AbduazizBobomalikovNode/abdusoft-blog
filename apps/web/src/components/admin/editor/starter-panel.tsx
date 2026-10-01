"use client";

import type { Editor } from "@tiptap/core";
import { FileUp, FilePlus2 } from "lucide-react";
import { TemplateGrid } from "./insert-dialog";

/** Bo'sh matn ostida: "Bo'sh sahifa" yoki shablon / Markdown import. Matn paydo bo'lishi bilan yo'qoladi. */
export function StarterPanel({ editor, onBlank, onImportMarkdown }: { editor: Editor; onBlank: () => void; onImportMarkdown: () => void }) {
  return (
    <section data-starter-panel aria-label="Boshlash" className="flex flex-col gap-3 rounded-2xl border border-dashed border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-sm font-medium">Qanday boshlaymiz?</p>
        <button type="button" data-testid="starter-blank" onClick={onBlank} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm hover:bg-muted md:min-h-8">
          <FilePlus2 className="size-4" />Bo&apos;sh sahifa
        </button>
        <button type="button" data-testid="starter-markdown" onClick={onImportMarkdown} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm hover:bg-muted md:min-h-8">
          <FileUp className="size-4" />Markdown import
        </button>
      </div>
      <TemplateGrid editor={editor} onPicked={() => undefined} />
    </section>
  );
}
