"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getMarkRange, type Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { ExternalLink, Pencil, Unlink } from "lucide-react";
import { FloatingPanel, rangeRect, rectOf, useAnchorRect, type AnchorRect } from "./floating";
import { OPEN_LINK_EVENT } from "./events";

interface LinkTarget {
  from: number;
  to: number;
  href: string;
}

/** `javascript:` kabilarni rad etadi; sxemasiz domen — `https://` bilan. */
export function normalizeHref(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^(https?:\/\/|mailto:|tel:|\/|#)/i.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  if (/^[^\s]+\.[^\s]{2,}$/.test(value)) return `https://${value}`;
  return null;
}

function shortHref(href: string): string {
  return href.length > 42 ? `${href.slice(0, 40)}…` : href;
}

/** Havola mini-popover'i: kursor/hover ostida — ko'rish; Mod+K — tahrirlash. */
export function LinkPopover({ editor }: { editor: Editor }) {
  const [edit, setEdit] = useState<(LinkTarget & { isNew: boolean }) | null>(null);
  const [hover, setHover] = useState<{ el: HTMLAnchorElement; id: number } | null>(null);
  const hoverEl = hover?.el ?? null;
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const hoverTimer = useRef<number | null>(null);
  const hoverIdRef = useRef(0);

  const caret = useEditorState({
    editor,
    selector: ({ editor: ed }): LinkTarget | null => {
      if (!ed.state.selection.empty || !ed.isActive("link")) return null;
      const type = ed.schema.marks.link;
      const range = type ? getMarkRange(ed.state.selection.$from, type) : undefined;
      return range ? { from: range.from, to: range.to, href: String(ed.getAttributes("link").href ?? "") } : null;
    },
  });

  const targetRef = useRef<{ edit: typeof edit; caret: LinkTarget | null; hoverEl: HTMLAnchorElement | null }>({ edit, caret, hoverEl });
  useLayoutEffect(() => {
    targetRef.current = { edit, caret, hoverEl };
  });
  // Nishon o'zgarganda (tahrirlash/hover/kursor) panel o'rni qayta hisoblanadi.
  const anchorKey = edit ? `e${edit.from}-${edit.to}` : caret ? `c${caret.from}` : hover ? `h${hover.id}` : "";

  const rect = useAnchorRect(editor, (ed): AnchorRect | null => {
    const t = targetRef.current;
    if (t.edit) return rangeRect(ed, t.edit.from, t.edit.to);
    if (t.caret) return rangeRect(ed, t.caret.from, t.caret.to);
    if (t.hoverEl && t.hoverEl.isConnected) return rectOf(t.hoverEl);
    return null;
  }, anchorKey);

  // Hover (faqat sichqoncha): havola ustiga kelganda ko'rsatamiz.
  useEffect(() => {
    const dom = editor.view.dom;
    const clear = () => {
      if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    };
    const onOver = (event: MouseEvent) => {
      const a = (event.target as HTMLElement | null)?.closest?.("a[href]");
      if (!a || !dom.contains(a)) return;
      clear();
      hoverTimer.current = window.setTimeout(() => {
        hoverIdRef.current += 1;
        setHover({ el: a as HTMLAnchorElement, id: hoverIdRef.current });
      }, 250);
    };
    const onOut = (event: MouseEvent) => {
      const a = (event.target as HTMLElement | null)?.closest?.("a[href]");
      if (!a) return;
      clear();
      hoverTimer.current = window.setTimeout(() => setHover(null), 350);
    };
    dom.addEventListener("mouseover", onOver);
    dom.addEventListener("mouseout", onOut);
    return () => {
      clear();
      dom.removeEventListener("mouseover", onOver);
      dom.removeEventListener("mouseout", onOut);
    };
  }, [editor]);

  const openEdit = useCallback(
    (target?: LinkTarget) => {
      const { from, to, empty } = editor.state.selection;
      const type = editor.schema.marks.link;
      const range = !target && type && editor.isActive("link") ? getMarkRange(editor.state.selection.$from, type) : undefined;
      const t: LinkTarget = target ?? (range ? { from: range.from, to: range.to, href: String(editor.getAttributes("link").href ?? "") } : { from, to, href: "" });
      setValue(t.href);
      setEdit({ ...t, isNew: !target && !range && empty });
    },
    [editor],
  );

  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ editor?: Editor }>).detail;
      if (detail?.editor && detail.editor !== editor) return;
      if (!detail?.editor && !editor.isFocused) return;
      openEdit();
    };
    window.addEventListener(OPEN_LINK_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_LINK_EVENT, onOpen);
  }, [editor, openEdit]);

  useEffect(() => {
    if (edit) requestAnimationFrame(() => inputRef.current?.focus());
  }, [edit]);

  const cancel = useCallback(() => {
    setEdit(null);
    editor.commands.focus();
  }, [editor]);

  function commit() {
    if (!edit) return;
    const href = normalizeHref(value);
    if (!href) {
      inputRef.current?.setAttribute("aria-invalid", "true");
      return;
    }
    const chain = editor.chain().focus();
    if (edit.isNew) {
      chain.insertContentAt({ from: edit.from, to: edit.to }, { type: "text", text: value.trim(), marks: [{ type: "link", attrs: { href } }] }).run();
    } else {
      chain.setTextSelection({ from: edit.from, to: edit.to }).setLink({ href }).setTextSelection(edit.to).run();
    }
    setEdit(null);
  }

  function removeLink(target: LinkTarget) {
    editor.chain().focus().setTextSelection({ from: target.from, to: target.to }).unsetLink().setTextSelection(target.to).run();
    setHover(null);
  }

  const hoverTarget: LinkTarget | null =
    hoverEl && hoverEl.isConnected
      ? (() => {
          try {
            const pos = editor.view.posAtDOM(hoverEl, 0);
            const type = editor.schema.marks.link;
            const range = type ? getMarkRange(editor.state.doc.resolve(pos + 1), type) : undefined;
            return range ? { from: range.from, to: range.to, href: hoverEl.getAttribute("href") ?? "" } : null;
          } catch {
            return null;
          }
        })()
      : null;
  const view = edit ? null : (caret ?? hoverTarget);

  if (!edit && !view) return null;

  return (
    <FloatingPanel
      rect={rect}
      testId="link-popover"
      placement={edit ? "bottom" : "top"}
      onMouseEnter={() => {
        if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
      }}
      onMouseLeave={() => setHover(null)}
    >
      {edit ? (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            commit();
          }}
        >
          <input
            ref={inputRef}
            data-link-input
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            placeholder="https://…"
            aria-label="Havola manzili"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              event.currentTarget.removeAttribute("aria-invalid");
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                cancel();
              }
            }}
            className="editor-panel-input w-60 max-sm:w-52"
          />
          <button type="submit" className="editor-panel-btn is-primary">Saqlash</button>
          {!edit.isNew && edit.href ? (
            <button type="button" className="editor-panel-btn" onClick={() => { removeLink(edit); setEdit(null); }}>
              Olib tashlash
            </button>
          ) : null}
        </form>
      ) : view ? (
        <div className="flex items-center gap-1">
          <span className="max-w-56 truncate px-1.5 text-xs text-muted-foreground" title={view.href}>{shortHref(view.href)}</span>
          <a className="editor-panel-btn" href={view.href} target="_blank" rel="noopener noreferrer"><ExternalLink className="size-3.5" />Ochish</a>
          <button type="button" className="editor-panel-btn" onClick={() => openEdit(view)}><Pencil className="size-3.5" />Tahrirlash</button>
          <button type="button" className="editor-panel-btn" onClick={() => removeLink(view)}><Unlink className="size-3.5" />Olib tashlash</button>
        </div>
      ) : null}
    </FloatingPanel>
  );
}
