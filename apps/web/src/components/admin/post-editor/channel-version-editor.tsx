"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { JSONContent } from "@tiptap/core";
import {
  CHANNEL_CAPTION_HARD_LIMIT,
  CHANNEL_TEXT_HARD_LIMIT,
  channelDocVisibleLength,
  TELEGRAM_LIMITS,
  type ChannelMode,
  type ChannelPostImageOption,
  type ChannelVersion,
} from "@blog/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AdminApiError, adminApi } from "@/lib/admin-client";
import { cn } from "cn";
import { MODE_OPTIONS } from "./channel-preview";

const AUTOSAVE_DELAY_MS = 800;
type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

function limitFor(mode: ChannelMode): number {
  return mode === "media" ? CHANNEL_CAPTION_HARD_LIMIT : CHANNEL_TEXT_HARD_LIMIT;
}

function fileName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() || url);
  } catch {
    return url.split("/").pop() || url;
  }
}

/* eslint-disable @next/next/no-img-element -- admin ichidagi kichik rasm ko'rinishlari */
function Thumb({ url }: { url: string }) {
  return <img src={url} alt="" className="size-10 shrink-0 rounded object-cover" />;
}
/* eslint-enable @next/next/no-img-element */

interface Props {
  postId: string;
  version: ChannelVersion;
  postImages: ChannelPostImageOption[];
  /** Har bir muvaffaqiyatli saqlashdan keyin (yangi versiya bilan). */
  onSaved: (version: ChannelVersion) => void;
  /** Ota komponent qadam almashtirishdan oldin kutilmagan o'zgarishlarni saqlatishi uchun. `true` — hammasi saqlangan. */
  registerFlush: (flush: (() => Promise<boolean>) | null) => void;
}

/** 2-qadam: maxsus versiyani tahrirlash (cheklangan Tiptap + rasm tanlagich + avtosaqlash). */
export function ChannelVersionEditor({ postId, version, postImages, onSaved, registerFlush }: Props) {
  const [name, setName] = useState(version.name);
  const [mode, setMode] = useState<ChannelMode>(version.mode);
  const [imageUrls, setImageUrls] = useState<string[]>(version.imageUrls);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [liveLength, setLiveLength] = useState(version.visibleLength);

  const stateRef = useRef({ name, mode, imageUrls });
  useEffect(() => {
    stateRef.current = { name, mode, imageUrls };
  }, [name, mode, imageUrls]);
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef<Promise<void> | null>(null);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      // Faqat ruxsat etilgan belgilar/tugunlar (API ham shularni qabul qiladi).
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        horizontalRule: false,
        link: { openOnClick: false, autolink: false, protocols: ["http", "https"] },
      }),
    ],
    content: version.contentJson as JSONContent,
    editorProps: { attributes: { class: "tiptap min-h-40 rounded-md border border-input bg-background px-3 py-2 text-sm outline-none [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-2 [&_p+p]:mt-2 [&_blockquote_p+p]:mt-0 [&_blockquote]:my-2" } },
    onUpdate: ({ editor: ed }) => {
      // Server (`telegramVisibleLength(renderRestrictedDoc(...))`) bilan bir xil formula — saqlashdan keyin son sakramaydi.
      setLiveLength(channelDocVisibleLength(ed.getJSON()));
      markDirty();
    },
  });

  const save = useCallback(async () => {
    if (!editor || !dirtyRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    dirtyRef.current = false;
    setSaveState("saving");
    const run = (async () => {
      try {
        const s = stateRef.current;
        const saved = await adminApi.updateChannelVersion(postId, version.id, {
          name: s.name.trim() || version.name,
          mode: s.mode,
          imageUrls: s.mode === "text" ? [] : s.imageUrls,
          contentJson: editor.getJSON(),
        });
        setLiveLength(saved.visibleLength);
        setSaveError(null);
        setSaveState(dirtyRef.current ? "dirty" : "saved");
        onSaved(saved);
      } catch (error) {
        dirtyRef.current = true;
        setSaveError(error instanceof AdminApiError ? error.message : "Saqlab bo'lmadi");
        setSaveState("error");
      }
    })();
    savingRef.current = run;
    await run;
    savingRef.current = null;
  }, [editor, postId, version.id, version.name, onSaved]);

  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  function markDirty() {
    dirtyRef.current = true;
    setSaveState("dirty");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void saveRef.current(), AUTOSAVE_DELAY_MS);
  }

  useEffect(() => {
    registerFlush(async () => {
      await savingRef.current;
      await saveRef.current();
      // Saqlash muvaffaqiyatsiz bo'lsa (`dirty` qolgan) — chaqiruvchi qadam almashtirmasligi kerak.
      return !dirtyRef.current;
    });
    return () => {
      registerFlush(null);
      if (timerRef.current) clearTimeout(timerRef.current);
      if (dirtyRef.current) void saveRef.current();
    };
  }, [registerFlush]);

  const active = useEditorState({
    editor,
    selector: ({ editor: ed }) => ({
      bold: ed?.isActive("bold") ?? false,
      italic: ed?.isActive("italic") ?? false,
      underline: ed?.isActive("underline") ?? false,
      strike: ed?.isActive("strike") ?? false,
      code: ed?.isActive("code") ?? false,
      link: ed?.isActive("link") ?? false,
      blockquote: ed?.isActive("blockquote") ?? false,
    }),
  });

  function setLink() {
    if (!editor) return;
    const previous = (editor.getAttributes("link").href as string | undefined) ?? "";
    const input = window.prompt("Havola (http:// yoki https://). Bo'sh qoldirsangiz havola olib tashlanadi.", previous);
    if (input === null) return;
    const url = input.trim();
    if (!url) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      window.alert("Faqat http:// yoki https:// havolalar mumkin");
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  }

  const tools: { label: string; title: string; active: boolean; run: () => void; className?: string }[] = [
    { label: "B", title: "Qalin", active: active?.bold ?? false, run: () => editor?.chain().focus().toggleBold().run(), className: "font-bold" },
    { label: "I", title: "Kursiv", active: active?.italic ?? false, run: () => editor?.chain().focus().toggleItalic().run(), className: "italic" },
    { label: "U", title: "Tagiga chizilgan", active: active?.underline ?? false, run: () => editor?.chain().focus().toggleUnderline().run(), className: "underline" },
    { label: "S", title: "Ustiga chizilgan", active: active?.strike ?? false, run: () => editor?.chain().focus().toggleStrike().run(), className: "line-through" },
    { label: "</>", title: "Kod", active: active?.code ?? false, run: () => editor?.chain().focus().toggleCode().run(), className: "font-mono" },
    { label: "🔗", title: "Havola", active: active?.link ?? false, run: setLink },
    { label: "❝", title: "Iqtibos", active: active?.blockquote ?? false, run: () => editor?.chain().focus().toggleBlockquote().run() },
  ];

  const limit = limitFor(mode);
  const over = liveLength > limit;

  function changeMode(next: ChannelMode) {
    if (next === mode) return;
    setMode(next);
    if (next === "media" && imageUrls.length === 0) setImageUrls(postImages.slice(0, TELEGRAM_LIMITS.mediaGroupMaxItems).map((i) => i.url));
    markDirty();
  }

  function changeImages(next: string[]) {
    setImageUrls(next);
    markDirty();
  }

  function move(idx: number, delta: -1 | 1) {
    const target = idx + delta;
    if (target < 0 || target >= imageUrls.length) return;
    const next = [...imageUrls];
    [next[idx], next[target]] = [next[target]!, next[idx]!];
    changeImages(next);
  }

  const max = TELEGRAM_LIMITS.mediaGroupMaxItems;
  const unselected = postImages.filter((i) => !imageUrls.includes(i.url));
  const statusText =
    saveState === "saving"
      ? "Saqlanmoqda…"
      : saveState === "saved"
        ? "Saqlandi"
        : saveState === "dirty"
          ? "O'zgarishlar saqlanishi kutilmoqda…"
          : saveState === "error"
            ? `Saqlab bo'lmadi${saveError ? `: ${saveError}` : ""}`
            : "";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="channel-version-name">Versiya nomi</Label>
        <Input
          id="channel-version-name"
          value={name}
          maxLength={80}
          onChange={(event) => {
            setName(event.target.value);
            markDirty();
          }}
        />
      </div>

      <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
        {MODE_OPTIONS.map((item) => (
          <button
            key={item.value}
            type="button"
            onClick={() => changeMode(item.value)}
            className={cn(
              "rounded-md px-2 py-1.5 text-xs font-medium transition-colors max-sm:min-h-11",
              mode === item.value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap gap-1" role="toolbar" aria-label="Matn formatlash">
          {tools.map((tool) => (
            <Button
              key={tool.title}
              type="button"
              size="sm"
              variant={tool.active ? "secondary" : "outline"}
              title={tool.title}
              aria-pressed={tool.active}
              className={cn("h-7 min-w-8 px-2 text-xs max-sm:h-11 max-sm:min-w-11", tool.className)}
              onClick={tool.run}
            >
              {tool.label}
            </Button>
          ))}
        </div>
        <EditorContent editor={editor} />
        <div className="flex items-center justify-between text-xs">
          <span className={cn(over ? "font-semibold text-destructive" : "text-muted-foreground")}>
            {liveLength} / {limit}
            {over ? ` — ${liveLength - limit} belgi ortiqcha` : ""}
          </span>
          <span className={cn(saveState === "error" ? "text-destructive" : "text-muted-foreground")} aria-live="polite">
            {statusText}
          </span>
        </div>
      </div>

      {mode === "media" ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Label>Rasmlar</Label>
            <span className={cn("text-xs", imageUrls.length > max ? "text-destructive" : "text-muted-foreground")}>
              {imageUrls.length} / {max}
            </span>
          </div>
          {imageUrls.length === 0 ? <p className="text-xs text-destructive">Rasmli rejim uchun kamida bitta rasm tanlang</p> : null}
          <ul className="flex flex-col gap-1">
            {imageUrls.map((url, idx) => (
              <li key={url} className="flex items-center gap-2 rounded-md border border-border p-1.5">
                <label className="flex items-center justify-center max-sm:min-h-11 max-sm:min-w-11">
                  <input
                    type="checkbox"
                    checked
                    onChange={() => changeImages(imageUrls.filter((u) => u !== url))}
                    aria-label={`${fileName(url)} ni olib tashlash`}
                  />
                </label>
                <Thumb url={url} />
                <span className="min-w-0 flex-1 truncate text-xs">
                  {idx + 1}. {fileName(url)}
                  {postImages.find((i) => i.url === url)?.kind === "cover" ? " (kover)" : ""}
                </span>
                <Button type="button" size="sm" variant="ghost" className="h-7 px-2 max-sm:h-11 max-sm:min-w-11" disabled={idx === 0} onClick={() => move(idx, -1)} aria-label="Yuqoriga">
                  ↑
                </Button>
                <Button type="button" size="sm" variant="ghost" className="h-7 px-2 max-sm:h-11 max-sm:min-w-11" disabled={idx === imageUrls.length - 1} onClick={() => move(idx, 1)} aria-label="Pastga">
                  ↓
                </Button>
              </li>
            ))}
          </ul>
          {unselected.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {unselected.map((img) => (
                <label
                  key={img.url}
                  className={cn("flex cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-border p-1", imageUrls.length >= max && "cursor-not-allowed opacity-50")}
                >
                  <input
                    type="checkbox"
                    checked={false}
                    disabled={imageUrls.length >= max}
                    onChange={() => changeImages([...imageUrls, img.url])}
                    aria-label={`${fileName(img.url)} ni qo'shish`}
                  />
                  <Thumb url={img.url} />
                </label>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
