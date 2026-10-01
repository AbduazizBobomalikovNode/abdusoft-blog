import { mergeAttributes, type Extensions } from "@tiptap/core";
import { Image } from "@tiptap/extension-image";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";
import { StarterKit } from "@tiptap/starter-kit";
import { BlockMove } from "./extensions/block-move";
import { EditorCodeBlock } from "./extensions/code-block";
import { EditorShortcuts } from "./extensions/editor-shortcuts";
import { PasteKit } from "./extensions/paste-kit";
import { SlashCommand } from "./extensions/slash-command";
import { TemplateHints } from "./extensions/template-hints";
import { UploadPlaceholders } from "./extensions/upload-placeholders";

export const EDITOR_PLACEHOLDER = 'Yozishni boshlang… "/" — buyruqlar, "+" — blok qo\'shish';

/** Tahrirlagichda alt matni bo'sh rasm belgilanadi (faqat tahrirlagich ko'rinishi; saqlanadigan JSON o'zgarmaydi). */
const EditorImage = Image.extend({
  renderHTML({ HTMLAttributes }) {
    const missing = !String(HTMLAttributes.alt ?? "").trim();
    return ["img", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, missing ? { class: "is-missing-alt" } : {})];
  },
});

/**
 * Saytdagi 4 ta konverter bilan bir xil hujjat sxemasi (StarterKit + Image + Table);
 * qolganlari — faqat tahrirlagich xulq-atvori (yangi tugun/belgi YO'Q).
 */
export function createEditorExtensions(options: { placeholder?: string; media: boolean }): Extensions {
  const extensions: Extensions = [
    StarterKit.configure({ link: { openOnClick: false }, codeBlock: false }),
    EditorCodeBlock,
    Placeholder.configure({ placeholder: options.placeholder ?? EDITOR_PLACEHOLDER, showOnlyCurrent: false }),
    SlashCommand,
    BlockMove,
    EditorShortcuts,
    TemplateHints,
    PasteKit,
  ];
  if (options.media) {
    extensions.push(EditorImage, Table, TableRow, TableHeader, TableCell, UploadPlaceholders);
  }
  return extensions;
}
