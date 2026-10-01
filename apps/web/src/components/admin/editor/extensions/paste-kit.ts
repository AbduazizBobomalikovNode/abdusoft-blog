import { Extension, type Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Fragment, Node as PMNode, Slice } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { JSONContent } from "@tiptap/core";
import { toast } from "sonner";
import { cleanPastedHtml } from "@/lib/editor/html-clean";
import { isBareUrl, isImageUrl, looksLikeMarkdown, markdownToDoc, normalizeCodeLanguage } from "@blog/shared";
import { uploadAnchor, uploadImages } from "./upload-placeholders";

/**
 * Joylashtirish va tashlash: rasm fayllari, Markdown, boy HTML (tozalanadi), havola.
 * Hammasi mavjud tugunlar bilan — yangi tugun/belgi YO'Q.
 */

const pasteKitKey = new PluginKey("pasteKit");

function imageFiles(list: FileList | null | undefined): File[] {
  return Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
}

function plainParagraphs(state: EditorState, text: string): PMNode[] {
  const para = state.schema.nodes.paragraph;
  if (!para) return [];
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n+/)
    .map((line) => para.create(null, line ? state.schema.text(line) : undefined));
}

function blocksFromJson(state: EditorState, nodes: JSONContent[]): PMNode[] {
  const out: PMNode[] = [];
  for (const json of nodes) {
    try {
      out.push(PMNode.fromJSON(state.schema, json));
    } catch {
      /* sxemada yo'q tugun (masalan, "Haqida" muharririda jadval) — o'tkazib yuboriladi */
    }
  }
  return out;
}

function shiftHeld(view: EditorView): boolean {
  return Boolean((view as unknown as { input?: { shiftKey?: boolean } }).input?.shiftKey);
}

let skipMarkdownOnce = false;

function pasteMarkdown(editor: Editor, view: EditorView, text: string): boolean {
  const { title, doc } = markdownToDoc(text);
  const json: JSONContent[] = [...(title ? [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: title }] }] : []), ...(doc.content ?? [])];
  const blocks = blocksFromJson(view.state, json);
  if (blocks.length === 0) return false;

  const { selection } = view.state;
  const $from = selection.$from;
  const emptyLine = selection.empty && $from.depth === 1 && $from.parent.isTextblock && $from.parent.content.size === 0;

  if (emptyLine) {
    // 1-qadam: oddiy matn sifatida (tarixga alohida yozuv) → 2-qadam: bloklarga aylantirish.
    // Shunda bitta Mod+Z oddiy matnni qaytaradi, ikkinchisi butunlay olib tashlaydi.
    const from = $from.before(1);
    const plain = plainParagraphs(view.state, text);
    const plainSize = plain.reduce((n, p) => n + p.nodeSize, 0);
    view.dispatch(view.state.tr.replaceWith(from, from + $from.parent.nodeSize, plain));
    const tr = closeHistory(view.state.tr).replaceWith(from, from + plainSize, blocks);
    view.dispatch(tr.scrollIntoView());
    toast("Markdown bloklarga aylantirildi", { description: "Ortga qaytarish (Mod+Z) oddiy matnni tiklaydi.", duration: 4000 });
    return true;
  }

  const before = view.state.doc;
  const tr = closeHistory(view.state.tr).replaceSelection(new Slice(Fragment.from(blocks), 0, 0));
  view.dispatch(tr.scrollIntoView());
  const afterDoc = view.state.doc;
  toast("Markdown bloklarga aylantirildi", {
    duration: 6000,
    action: {
      label: "Oddiy matn",
      onClick: () => {
        if (editor.isDestroyed || !editor.state.doc.eq(afterDoc)) return;
        editor.commands.undo();
        if (editor.state.doc.eq(before)) {
          skipMarkdownOnce = true;
          editor.view.pasteText(text);
        }
      },
    },
  });
  return true;
}

function pasteImageUrl(editor: Editor, url: string): void {
  const { from } = editor.state.selection;
  editor.chain().focus().insertContent({ type: "text", text: url, marks: [{ type: "link", attrs: { href: url } }] }).run();
  const to = editor.state.selection.from;
  toast("Rasm havolasi qo'yildi", {
    duration: 8000,
    action: {
      label: "Rasm sifatida qo'shish",
      onClick: () => {
        if (editor.isDestroyed) return;
        if (editor.state.doc.textBetween(from, to) !== url) return;
        editor.chain().focus().deleteRange({ from, to }).insertContent({ type: "image", attrs: { src: url, alt: "" } }).run();
      },
    },
  });
}

export const PasteKit = Extension.create({
  name: "pasteKit",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: pasteKitKey,
        props: {
          transformPastedHTML(html) {
            // ProseMirror'ning o'z nusxasi (data-pm-slice) — tuzilmani buzmaslik uchun tegilmaydi.
            if (html.includes("data-pm-slice")) return html;
            return cleanPastedHtml(html);
          },
          handlePaste(view, event) {
            if (!view.editable) return false;
            const data = event.clipboardData;
            if (!data) return false;

            const files = imageFiles(data.files);
            if (files.length > 0 && view.state.schema.nodes.image) {
              event.preventDefault();
              void uploadImages(editor, files);
              return true;
            }

            if (editor.isActive("codeBlock") || shiftHeld(view)) return false;

            const text = data.getData("text/plain");
            const html = data.getData("text/html");

            // VS Code'dan nusxa — kod bloki sifatida.
            const vscode = data.getData("vscode-editor-data");
            if (vscode && text && view.state.schema.nodes.codeBlock) {
              let mode: string | null = null;
              try {
                mode = (JSON.parse(vscode) as { mode?: string }).mode ?? null;
              } catch {
                mode = null;
              }
              event.preventDefault();
              editor
                .chain()
                .focus()
                .insertContent({ type: "codeBlock", attrs: { language: normalizeCodeLanguage(mode) }, content: [{ type: "text", text: text.replace(/\n$/, "") }] })
                .run();
              return true;
            }

            if (isBareUrl(text)) {
              const url = text.trim();
              const { empty } = view.state.selection;
              if (!empty && view.state.schema.marks.link) {
                event.preventDefault();
                editor.chain().focus().setLink({ href: url }).run();
                return true;
              }
              if (empty && isImageUrl(url) && view.state.schema.nodes.image) {
                event.preventDefault();
                pasteImageUrl(editor, url);
                return true;
              }
              return false;
            }

            if (skipMarkdownOnce) {
              skipMarkdownOnce = false;
              return false;
            }

            // Boy HTML bo'lsa (Docs/Word/veb) — tozalangan holda standart yo'l; faqat oddiy matn Markdown bo'lishi mumkin.
            const richHtml = /<(p|h[1-6]|ul|ol|li|table|pre|blockquote|img|a|strong|em|b|i)[\s>]/i.test(html);
            if (!richHtml && text && looksLikeMarkdown(text)) {
              event.preventDefault();
              return pasteMarkdown(editor, view, text);
            }
            return false;
          },
          handleDrop(view, event, _slice, moved) {
            if (moved || !view.editable || !view.state.schema.nodes.image) return false;
            const files = imageFiles(event.dataTransfer?.files);
            if (files.length === 0) return false;
            event.preventDefault();
            const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
            const anchor = uploadAnchor(view.state, coords?.pos);
            void uploadImages(editor, files, anchor.replaceEmpty ? anchor.pos + 1 : anchor.pos);
            return true;
          },
        },
      }),
    ];
  },
});
