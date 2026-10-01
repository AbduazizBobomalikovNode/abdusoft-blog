import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { toast } from "sonner";
import { AdminApiError, adminApi } from "@/lib/admin-client";

/**
 * Rasm yuklash: hujjatda tugun yaratmaydi (4 ta konverter uchun yangi tugun YO'Q) — yuklash paytida
 * widget-dekoratsiya (joy egallovchi) ko'rsatiladi; muvaffaqiyatda oddiy `image` tuguni qo'yiladi.
 */

const MAX_SIZE = 10 * 1024 * 1024;

interface PlaceholderSpec {
  id: string;
}
interface AddMeta {
  add: { id: string; pos: number; name: string };
}
interface RemoveMeta {
  remove: { id: string };
}
type Meta = AddMeta | RemoveMeta;

export const uploadPluginKey = new PluginKey<DecorationSet>("uploadPlaceholders");

const progressById = new Map<string, number>();

function buildWidget(id: string, name: string): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-upload-placeholder", "");
  el.setAttribute("data-upload-id", id);
  el.contentEditable = "false";
  el.className = "upload-placeholder";
  const label = document.createElement("span");
  label.className = "upload-placeholder-label";
  label.textContent = `Yuklanmoqda: ${name}`;
  const bar = document.createElement("span");
  bar.className = "upload-placeholder-bar";
  const fill = document.createElement("span");
  fill.className = "upload-placeholder-fill";
  fill.style.width = `${progressById.get(id) ?? 0}%`;
  bar.appendChild(fill);
  el.append(label, bar);
  return el;
}

function setProgress(id: string, percent: number): void {
  progressById.set(id, percent);
  const fill = document.querySelector(`[data-upload-id="${id}"] .upload-placeholder-fill`);
  if (fill instanceof HTMLElement) fill.style.width = `${percent}%`;
}

export const UploadPlaceholders = Extension.create({
  name: "uploadPlaceholders",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: uploadPluginKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            let next = set.map(tr.mapping, tr.doc);
            const meta = tr.getMeta(uploadPluginKey) as Meta | undefined;
            if (meta && "add" in meta) {
              const { id, pos, name } = meta.add;
              next = next.add(tr.doc, [
                // side: 0 — bir xil joyga qo'yilgan keyingi yuklashlar tasvirdan KEYIN qoladi.
                Decoration.widget(pos, () => buildWidget(id, name), { id, side: 0, key: `upload-${id}` }),
              ]);
            } else if (meta && "remove" in meta) {
              const found = next.find(undefined, undefined, (spec: PlaceholderSpec) => spec.id === meta.remove.id);
              next = next.remove(found);
              progressById.delete(meta.remove.id);
            }
            return next;
          },
        },
        props: {
          decorations: (state) => uploadPluginKey.getState(state),
        },
      }),
    ];
  },
});

function placeholderPos(state: EditorState, id: string): number | null {
  const set = uploadPluginKey.getState(state);
  const found = set?.find(undefined, undefined, (spec: PlaceholderSpec) => spec.id === id)[0];
  return found ? found.from : null;
}

/** Yuklash joyi: har doim eng yuqori daraja blok chegarasi. Bo'sh paragrafda — uning o'rniga. */
export function uploadAnchor(state: EditorState, pos?: number): { pos: number; replaceEmpty: boolean } {
  const $pos = state.doc.resolve(pos ?? state.selection.from);
  if ($pos.depth === 0) return { pos: $pos.pos, replaceEmpty: false };
  const top = $pos.node(1);
  const isEmptyPara = top.type.name === "paragraph" && top.content.size === 0;
  return isEmptyPara ? { pos: $pos.before(1), replaceEmpty: true } : { pos: $pos.after(1), replaceEmpty: false };
}

function errorMessage(error: unknown): string {
  return error instanceof AdminApiError ? error.message : "Rasm yuklanmadi";
}

export function validateImageFile(file: File): string | null {
  if (!file.type.startsWith("image/")) return `"${file.name}" — rasm emas`;
  if (file.size > MAX_SIZE) return `"${file.name}" 10 MB dan katta`;
  return null;
}

/** Bir yoki bir nechta rasmni ketma-ket yuklaydi; har biri uchun joy egallovchi + progress. */
export async function uploadImages(editor: Editor, files: File[], at?: number): Promise<void> {
  const valid: File[] = [];
  for (const file of files) {
    const problem = validateImageFile(file);
    if (problem) toast.error(problem);
    else valid.push(file);
  }
  if (valid.length === 0) return;

  const anchor = uploadAnchor(editor.state, at);
  const ids = valid.map(() => crypto.randomUUID());
  const names = valid.map((f) => f.name);
  // Hammasi bir vaqtda joy egallovchi sifatida ko'rsatiladi (tartib saqlanadi).
  ids.forEach((id, i) => {
    editor.view.dispatch(editor.state.tr.setMeta(uploadPluginKey, { add: { id, pos: anchor.pos, name: names[i] ?? "rasm" } } satisfies AddMeta).setMeta("addToHistory", false));
  });

  for (let i = 0; i < valid.length; i++) {
    const id = ids[i] as string;
    const file = valid[i] as File;
    try {
      const media = await adminApi.uploadMediaWithProgress(file, (p) => setProgress(id, p));
      if (editor.isDestroyed) return;
      const pos = placeholderPos(editor.state, id);
      const { state } = editor;
      const image = state.schema.nodes.image?.create({ src: media.url, alt: media.alt ?? "" });
      if (pos === null || !image) {
        editor.view.dispatch(state.tr.setMeta(uploadPluginKey, { remove: { id } } satisfies RemoveMeta));
        continue;
      }
      // Bo'sh qatorda — rasm uning oldiga qo'yiladi (qator keyingi matn uchun qoladi). O'rniga qo'ymaymiz:
      // aks holda boshqa kutayotgan joy egallovchilar o'chib ketadi (ProseMirror "deleted" xaritasi).
      const t = state.tr.setMeta(uploadPluginKey, { remove: { id } } satisfies RemoveMeta).insert(pos, image);
      editor.view.dispatch(t);
    } catch (error) {
      if (editor.isDestroyed) return;
      editor.view.dispatch(editor.state.tr.setMeta(uploadPluginKey, { remove: { id } } satisfies RemoveMeta));
      toast.error(`${file.name}: ${errorMessage(error)}`);
    }
  }
}

export function hasPendingUploads(state: EditorState): boolean {
  const set = uploadPluginKey.getState(state);
  return !!set && set.find().length > 0;
}
