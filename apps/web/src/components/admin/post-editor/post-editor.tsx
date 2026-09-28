"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { JSONContent } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Image } from "@tiptap/extension-image";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Settings2 } from "lucide-react";
import { toast } from "sonner";
import { slugify, type AdminPostDetail, type AdminPostStatus, type Me, type PostSettings, type TagWithCount, type TelegramRef, type UpdatePostBody } from "@blog/shared";
import { PostEditorHeader, type SaveState } from "./post-editor-header";
import { PostEditorSettings } from "./post-editor-settings";
import { PostStatusBadge } from "@/components/admin/post-status-badge";
import { CodeBlockLanguageMenu, PostEditorBubbleMenu } from "./post-editor-toolbar";
import { AdminReviewActions, StaffReviewBanner } from "./review-banner";
import { SlashCommand } from "./slash-command";
import { StaffEditorPanel } from "./staff-editor-panel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { AdminApiError, adminApi } from "@/lib/admin-client";
import { formatTime } from "@/lib/format";
import { site } from "@/lib/site";

const AUTOSAVE_DELAY_MS = 1500;

function toDatetimeLocal(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof AdminApiError ? error.message : fallback;
}

export function PostEditor({ post, allTags, me }: { post: AdminPostDetail; allTags: TagWithCount[]; me: Me }) {
  const router = useRouter();
  const isStaff = me.role === "staff";
  const [title, setTitle] = useState(post.title);
  const [slug, setSlug] = useState(post.slug);
  const [slugAuto, setSlugAuto] = useState(true);
  const [excerpt, setExcerpt] = useState(post.excerpt ?? "");
  const [coverUrl, setCoverUrl] = useState<string | null>(post.coverUrl);
  const [tagSlugs, setTagSlugs] = useState<string[]>(post.tags.map((t) => t.slug));
  const [settings, setSettings] = useState<PostSettings>(post.settings);
  const [pinned, setPinned] = useState(post.pinned);
  const [status, setStatus] = useState<AdminPostStatus>(post.status);
  const [reviewNote, setReviewNote] = useState<string | null>(post.reviewNote);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [scheduledAtLocal, setScheduledAtLocal] = useState(toDatetimeLocal(post.scheduledAt));
  const [scheduling, setScheduling] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(post.updatedAt);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [telegram, setTelegram] = useState<TelegramRef | null>(post.telegram);
  const [telegramChannel, setTelegramChannel] = useState<string | null>(null);
  const [refreshingTelegraph, setRefreshingTelegraph] = useState(false);
  const [repostingTelegram, setRepostingTelegram] = useState(false);

  // Xodim (staff) uchun — post ko'rib chiqishda bo'lsa butunlay o'qish uchun
  // (API ham shu holatda PATCH'ni 409 bilan rad etadi — bu shunchaki mos UI).
  const readOnly = isStaff && status === "in_review";
  const canSubmit = isStaff && (status === "draft" || status === "changes_requested");

  const pendingRef = useRef<UpdatePostBody>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirtyRef = useRef(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const flush = useCallback(async () => {
    const payload = pendingRef.current;
    if (Object.keys(payload).length === 0) return;
    pendingRef.current = {};
    setSaveState("saving");
    try {
      const result = await adminApi.updatePost(post.id, payload);
      setSaveState("saved");
      setSaveError(null);
      setLastSavedAt(result.updatedAt);
      dirtyRef.current = false;
    } catch (error) {
      setSaveState("error");
      setSaveError(errorMessage(error, "Saqlashda xatolik"));
      toast.error(errorMessage(error, "Saqlashda xatolik"));
      pendingRef.current = { ...payload, ...pendingRef.current };
    }
  }, [post.id]);

  const flushNow = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    void flush();
  }, [flush]);

  const queueSave = useCallback(
    (patch: Partial<UpdatePostBody>) => {
      pendingRef.current = { ...pendingRef.current, ...patch };
      dirtyRef.current = true;
      setSaveState("idle");
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void flush(), AUTOSAVE_DELAY_MS);
    },
    [flush],
  );

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        flushNow();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [flushNow]);

  useEffect(() => {
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      if (!dirtyRef.current) return;
      event.preventDefault();
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    // Yangi post ("Nomsiz post" — /admin-posts.ts POST / dagi fallback nomi)
    // ochilganda sarlavhaga avtomatik fokus beramiz, xuddi Notion/Ghost'dagidek.
    if (post.title === "Nomsiz post") {
      titleRef.current?.focus();
      titleRef.current?.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    adminApi
      .getTelegramStatus()
      .then((status) => {
        if (status.configured) setTelegramChannel(status.channel);
      })
      .catch(() => {
        // Telegram holatini olishda xatolik bo'lsa ham tahrirlagich ishlashda davom etadi.
      });
  }, []);

  async function handleRefreshTelegraph() {
    setRefreshingTelegraph(true);
    try {
      const result = await adminApi.refreshTelegraph(post.id);
      setTelegram((prev) => ({ ...(prev ?? { telegraphPath: null, channelMessageId: null }), telegraphUrl: result.telegraphUrl }));
      toast.success("Telegraph nusxa yangilandi");
    } catch (error) {
      toast.error(errorMessage(error, "Telegraph'ni yangilab bo'lmadi"));
    } finally {
      setRefreshingTelegraph(false);
    }
  }

  async function handleRepostTelegram() {
    setRepostingTelegram(true);
    try {
      const result = await adminApi.repostTelegram(post.id);
      setTelegram((prev) => ({
        ...(prev ?? { telegraphPath: null, telegraphUrl: null }),
        channelMessageId: result.channelMessageId,
      }));
      toast.success("Kanalga yuborildi");
    } catch (error) {
      toast.error(errorMessage(error, "Kanalga yuborib bo'lmadi"));
    } finally {
      setRepostingTelegram(false);
    }
  }

  const channelUrl =
    telegram?.channelMessageId && telegramChannel?.startsWith("@")
      ? `https://t.me/${telegramChannel.slice(1)}/${telegram.channelMessageId}`
      : null;

  async function uploadAndInsertImage(file: File) {
    const toastId = toast.loading("Rasm yuklanmoqda…");
    try {
      const media = await adminApi.uploadMedia(file);
      editor?.chain().focus().setImage({ src: media.url, alt: media.alt ?? "" }).run();
      toast.success("Rasm qo'shildi", { id: toastId });
    } catch (error) {
      toast.error(errorMessage(error, "Rasm yuklanmadi"), { id: toastId });
    }
  }

  useEffect(() => {
    function handleInsertImageRequest() {
      fileInputRef.current?.click();
    }
    window.addEventListener("post-editor:insert-image", handleInsertImageRequest);
    return () => window.removeEventListener("post-editor:insert-image", handleInsertImageRequest);
  }, []);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      Image,
      Table,
      TableRow,
      TableHeader,
      TableCell,
      Placeholder.configure({
        placeholder: "Yozishni boshlang… \"/\" buyruqlar menyusi",
        showOnlyCurrent: false,
      }),
      SlashCommand,
    ],
    content: post.contentJson as JSONContent,
    editable: !readOnly,
    editorProps: {
      attributes: { class: "tiptap prose-article" },
      handlePaste: (view, event) => {
        if (readOnly) return false;
        const file = event.clipboardData?.files?.[0];
        if (!file || !file.type.startsWith("image/")) return false;
        event.preventDefault();
        void (async () => {
          try {
            const media = await adminApi.uploadMedia(file);
            const node = view.state.schema.nodes.image?.create({ src: media.url, alt: media.alt ?? "" });
            if (!node) return;
            view.dispatch(view.state.tr.replaceSelectionWith(node));
          } catch (error) {
            toast.error(errorMessage(error, "Rasm yuklanmadi"));
          }
        })();
        return true;
      },
      handleDrop: (view, event, _slice, moved) => {
        if (readOnly || moved) return false;
        const file = event.dataTransfer?.files?.[0];
        if (!file || !file.type.startsWith("image/")) return false;
        event.preventDefault();
        const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
        void (async () => {
          try {
            const media = await adminApi.uploadMedia(file);
            const node = view.state.schema.nodes.image?.create({ src: media.url, alt: media.alt ?? "" });
            if (!node) return;
            const pos = coords?.pos ?? view.state.selection.from;
            view.dispatch(view.state.tr.insert(pos, node));
          } catch (error) {
            toast.error(errorMessage(error, "Rasm yuklanmadi"));
          }
        })();
        return true;
      },
    },
    onUpdate: ({ editor: ed }) => queueSave({ contentJson: ed.getJSON() }),
  });

  useEffect(() => {
    editor?.setEditable(!readOnly);
  }, [editor, readOnly]);

  async function handleSubmit() {
    setSubmitting(true);
    try {
      const result = await adminApi.submitPost(post.id);
      setStatus(result.status);
      toast.success("Ko'rib chiqishga yuborildi");
      setSubmitOpen(false);
    } catch (error) {
      toast.error(errorMessage(error, "Yuborishda xatolik"));
    } finally {
      setSubmitting(false);
    }
  }

  function handleTitleChange(value: string) {
    setTitle(value);
    queueSave({ title: value.trim().length > 0 ? value : "Nomsiz post" });

    if (slugAuto) {
      const nextSlug = slugify(value);
      if (nextSlug) {
        setSlug(nextSlug);
        queueSave({ slug: nextSlug });
      }
    }
  }

  function handleTitleInput(event: React.FormEvent<HTMLTextAreaElement>) {
    const el = event.currentTarget;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  function handleTitleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      editor?.chain().focus("start").run();
    }
  }

  function handleSlugChange(value: string) {
    setSlug(value);
    setSlugAuto(false);
    // Bo'sh slug API tomonidan rad etiladi (`min(1)`) — foydalanuvchi maydonni
    // vaqtincha tozalab qo'ysa (masalan hammasini o'chirib qayta yozayotganda),
    // avtosaqlash so'rovini shu holatda yubormaymiz, faqat matn bo'lganda saqlaymiz.
    if (value.trim().length > 0) {
      queueSave({ slug: value });
    }
  }

  async function handlePublish() {
    try {
      const result = await adminApi.publishPost(post.id);
      setStatus(result.status);
      toast.success("Post chop etildi");
    } catch (error) {
      toast.error(errorMessage(error, "Chop etishda xatolik"));
    }
  }

  async function handleUnpublish() {
    try {
      const result = await adminApi.unpublishPost(post.id);
      setStatus(result.status);
      toast.success("Post qoralamaga qaytarildi");
    } catch (error) {
      toast.error(errorMessage(error, "Amalni bajarib bo'lmadi"));
    }
  }

  async function handleArchive() {
    try {
      const result = await adminApi.archivePost(post.id);
      setStatus(result.status);
      toast.success("Post arxivlandi");
    } catch (error) {
      toast.error(errorMessage(error, "Amalni bajarib bo'lmadi"));
    }
  }

  async function handleDelete() {
    try {
      await adminApi.deletePost(post.id);
      toast.success("Post o'chirildi");
      router.push("/admin/postlar");
    } catch (error) {
      toast.error(errorMessage(error, "O'chirib bo'lmadi"));
    }
  }

  async function handleSchedule() {
    if (!scheduledAtLocal) return;
    setScheduling(true);
    try {
      const iso = new Date(scheduledAtLocal).toISOString();
      const result = await adminApi.schedulePost(post.id, iso);
      setStatus(result.status);
      toast.success("Post rejalashtirildi");
    } catch (error) {
      toast.error(errorMessage(error, "Rejalashtirib bo'lmadi"));
    } finally {
      setScheduling(false);
    }
  }

  async function handleExcerptAuto() {
    try {
      await adminApi.updatePost(post.id, { excerpt: null });
      const fresh = await adminApi.getPost(post.id);
      setExcerpt(fresh.excerpt ?? "");
      toast.success("Avtomatik tavsif qo'llandi");
    } catch (error) {
      toast.error(errorMessage(error, "Amalni bajarib bo'lmadi"));
    }
  }

  const settingsProps = {
    status,
    publishedAt: post.publishedAt,
    updatedAt: lastSavedAt ?? post.updatedAt,
    allTags,
    selectedTagSlugs: tagSlugs,
    onTagsChange: (slugs: string[]) => {
      setTagSlugs(slugs);
      queueSave({ tagSlugs: slugs });
    },
    settings,
    onSettingsChange: (patch: Partial<PostSettings>) => {
      setSettings((prev) => {
        const next = { ...prev, ...patch };
        queueSave({ settings: next });
        return next;
      });
    },
    pinned,
    onPinnedChange: (value: boolean) => {
      setPinned(value);
      queueSave({ pinned: value });
    },
    excerpt,
    onExcerptChange: (value: string) => {
      setExcerpt(value);
      queueSave({ excerpt: value });
    },
    onExcerptAuto: () => void handleExcerptAuto(),
    coverUrl,
    onCoverChange: (url: string | null) => {
      setCoverUrl(url);
      queueSave({ coverUrl: url });
    },
    scheduledAtLocal,
    onScheduledAtLocalChange: setScheduledAtLocal,
    onSchedule: () => void handleSchedule(),
    scheduling,
    telegram,
    channelUrl,
    onRefreshTelegraph: () => void handleRefreshTelegraph(),
    refreshingTelegraph,
    onRepostTelegram: () => void handleRepostTelegram(),
    repostingTelegram,
  };

  const staffPanelProps = {
    allTags,
    selectedTagSlugs: tagSlugs,
    onTagsChange: settingsProps.onTagsChange,
    excerpt,
    onExcerptChange: settingsProps.onExcerptChange,
    onExcerptAuto: settingsProps.onExcerptAuto,
    coverUrl,
    onCoverChange: settingsProps.onCoverChange,
    readOnly,
  };

  return (
    <div className="flex flex-col gap-4">
      {isStaff ? (
        <div className="sticky top-0 z-30 -mx-4 flex flex-wrap items-center justify-between gap-2 border-b border-border bg-background/95 px-4 py-2.5 backdrop-blur-sm md:-mx-8 md:px-8">
          <div className="flex items-center gap-2.5">
            <PostStatusBadge status={status} />
            <span className="text-xs text-muted-foreground">
              {saveState === "saving"
                ? "Saqlanmoqda…"
                : saveState === "error"
                  ? `Xato: ${saveError ?? "saqlanmadi"}`
                  : saveState === "saved" && lastSavedAt
                    ? `Saqlandi ${formatTime(lastSavedAt)}`
                    : ""}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/admin/postlar/${post.id}/preview`} target="_blank">
                Ko&apos;rish
              </Link>
            </Button>
            {canSubmit ? (
              <Button size="sm" onClick={() => setSubmitOpen(true)}>
                Ko&apos;rib chiqishga yuborish
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <PostEditorHeader
          postId={post.id}
          status={status}
          saveState={saveState}
          saveError={saveError}
          lastSavedAt={lastSavedAt}
          onPublish={handlePublish}
          onUnpublish={handleUnpublish}
          onArchive={handleArchive}
          onDelete={handleDelete}
          onRefreshTelegraph={() => void handleRefreshTelegraph()}
          onRepostTelegram={() => void handleRepostTelegram()}
        />
      )}

      {isStaff ? <StaffReviewBanner status={status} reviewNote={reviewNote} /> : null}
      {!isStaff && status === "in_review" ? (
        <AdminReviewActions
          postId={post.id}
          authorName={post.createdBy?.name ?? "Xodim"}
          onApproved={(next) => setStatus(next)}
          onChangesRequested={(next) => {
            setStatus(next);
            setReviewNote(null);
          }}
        />
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
        <div className="flex min-w-0 flex-col gap-3">
          <textarea
            ref={titleRef}
            value={title}
            onChange={(event) => handleTitleChange(event.target.value)}
            onInput={handleTitleInput}
            onKeyDown={handleTitleKeyDown}
            placeholder="Sarlavha"
            rows={1}
            disabled={readOnly}
            className="post-editor-title"
          />

          <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs text-muted-foreground">
            <span className="truncate">{site.url}/</span>
            <input
              value={slug}
              onChange={(event) => handleSlugChange(event.target.value)}
              disabled={readOnly}
              className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 py-0.5 hover:border-border focus:border-border focus:outline-none"
            />
            {!readOnly ? (
              <button
                type="button"
                onClick={() => setSlugAuto((v) => !v)}
                aria-pressed={slugAuto}
                title={slugAuto ? "Slug sarlavhadan avtomatik yangilanadi" : "Slug qulflangan"}
                className="rounded-md px-1.5 py-0.5 hover:bg-muted"
              >
                {slugAuto ? "🔓" : "🔒"}
              </button>
            ) : null}
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit lg:hidden"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 className="size-4" />
            {isStaff ? "Qo'shimcha" : "Sozlamalar"}
          </Button>

          {editor ? (
            <>
              <PostEditorBubbleMenu editor={editor} />
              <CodeBlockLanguageMenu editor={editor} />
            </>
          ) : null}

          <div className="tiptap-editor-content">
            <EditorContent editor={editor} />
          </div>
        </div>

        <aside className="hidden lg:block">
          {isStaff ? <StaffEditorPanel {...staffPanelProps} /> : <PostEditorSettings {...settingsProps} />}
        </aside>
      </div>

      <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
        <SheetContent side="right" className="overflow-y-auto p-4">
          <SheetHeader className="p-0">
            <SheetTitle>{isStaff ? "Qo'shimcha" : "Sozlamalar"}</SheetTitle>
          </SheetHeader>
          {isStaff ? <StaffEditorPanel {...staffPanelProps} /> : <PostEditorSettings {...settingsProps} />}
        </SheetContent>
      </Sheet>

      <AlertDialog open={submitOpen} onOpenChange={setSubmitOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Ko&apos;rib chiqishga yuborish</AlertDialogTitle>
            <AlertDialogDescription>
              Post admin tomonidan tasdiqlanmaguncha tahrirlab bo&apos;lmaydi. Admin tasdiqlagach, post saytda va
              Telegram kanalida avtomatik chop etiladi.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
            <AlertDialogAction disabled={submitting} onClick={() => void handleSubmit()}>
              Yuborish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void uploadAndInsertImage(file);
          event.target.value = "";
        }}
      />
    </div>
  );
}
