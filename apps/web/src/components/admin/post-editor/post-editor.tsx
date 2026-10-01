"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { JSONContent } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { Settings2 } from "lucide-react";
import { toast } from "sonner";
import { docStats, slugify, type AdminPostDetail, type AdminPostStatus, type ChannelPlan, type DocStats, type Me, type PostSettings, type ResolvedChannelChoice, type TagWithCount, type TelegramRef } from "@blog/shared";
import { DraftBanner } from "@/components/admin/editor/draft-banner";
import { EditorToolbar } from "@/components/admin/editor/editor-toolbar";
import { OPEN_SHORTCUTS_EVENT } from "@/components/admin/editor/events";
import { ImagePicker, ImageToolbar } from "@/components/admin/editor/image-tools";
import { InsertDialog } from "@/components/admin/editor/insert-dialog";
import { InsertPlus } from "@/components/admin/editor/insert-plus";
import { createEditorExtensions } from "@/components/admin/editor/kit";
import { LinkPopover } from "@/components/admin/editor/link-popover";
import { OutlinePanel } from "@/components/admin/editor/outline-panel";
import { PublishChecklist } from "@/components/admin/editor/publish-checklist";
import { ShortcutsDialog } from "@/components/admin/editor/shortcuts-dialog";
import { StarterPanel } from "@/components/admin/editor/starter-panel";
import { StatusFooter, type FooterSaveInfo } from "@/components/admin/editor/status-footer";
import { TableToolbar } from "@/components/admin/editor/table-toolbar";
import { useCaretFollow } from "@/components/admin/editor/use-caret-follow";
import { useFocusMode } from "@/components/admin/editor/use-focus-mode";
import { ChannelSendDialog } from "./channel-send-dialog";
import { PostEditorHeader, StaffEditorHeader, type EditorMenuActions, type SaveState } from "./post-editor-header";
import { PostEditorSettings } from "./post-editor-settings";
import { PostEditorBubbleMenu } from "./post-editor-toolbar";
import { AdminReviewActions, StaffReviewBanner } from "./review-banner";
import { StaffEditorPanel } from "./staff-editor-panel";
import { useAutosave } from "./use-autosave";
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
import { buildPublishChecklist, hasBlockingIssue, type ChecklistItem, type FixTarget } from "@/lib/editor/checklist";
import { browserStorage, clearBackup, loadBackup, serverChangedSinceBackup, shouldOfferRestore, type DraftBackup } from "@/lib/editor/draft-backup";
import { extractOutline, type OutlineItem } from "@blog/shared";
import { isHintText } from "@blog/shared";
import { site } from "@/lib/site";
import { formatTime } from "@/lib/format";

function toDatetimeLocal(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof AdminApiError ? error.message : fallback;
}

const EMPTY_STATS: DocStats = { words: 0, characters: 0, readingMinutes: 1 };

function saveTone(state: SaveState): FooterSaveInfo["tone"] {
  return state;
}

function footerText(state: SaveState, lastSavedAt: string | null, saveError: string | null): string {
  if (state === "saving") return "Saqlanmoqda…";
  if (state === "offline") return "Oflayn — mahalliy saqlandi";
  if (state === "error") return saveError ? `Xato: ${saveError}` : "Xato — saqlanmadi";
  if (state === "saved" && lastSavedAt) return `Saqlandi ${formatTime(lastSavedAt)}`;
  return "";
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
  const [submitChecklist, setSubmitChecklist] = useState<ChecklistItem[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [scheduledAtLocal, setScheduledAtLocal] = useState(toDatetimeLocal(post.scheduledAt));
  const [scheduling, setScheduling] = useState(false);
  // Faqat rejalashtirilgan postda server tomonda saqlanadi — boshqa holatda "rejalashtirish" bosilganda yuboriladi.
  const [channelPlan, setChannelPlan] = useState<ChannelPlan | null>(post.status === "scheduled" ? post.channelPlan : null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [telegram, setTelegram] = useState<TelegramRef | null>(post.telegram);
  const [telegramChannel, setTelegramChannel] = useState<string | null>(null);
  const [refreshingTelegraph, setRefreshingTelegraph] = useState(false);
  const [channelSendOpen, setChannelSendOpen] = useState(false);
  const [channelPlanBlocked, setChannelPlanBlocked] = useState(false);
  const [channelChoice, setChannelChoice] = useState<ResolvedChannelChoice | null>(post.channelChoice);
  const [starterDismissed, setStarterDismissed] = useState(false);
  const [insertOpen, setInsertOpen] = useState(false);
  const [draftOffer, setDraftOffer] = useState<{ backup: DraftBackup; serverNewer: boolean } | null>(null);
  const [snapshot, setSnapshot] = useState<{ stats: DocStats; outline: OutlineItem[] }>({ stats: EMPTY_STATS, outline: [] });

  // Xodim (staff) uchun — post ko'rib chiqishda bo'lsa butunlay o'qish uchun
  // (API ham shu holatda PATCH'ni 409 bilan rad etadi — bu shunchaki mos UI).
  const readOnly = isStaff && status === "in_review";
  const canSubmit = isStaff && (status === "draft" || status === "changes_requested");

  const titleRef = useRef<HTMLTextAreaElement>(null);
  const slugRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const { focusMode, toggle: toggleFocus } = useFocusMode(true);

  const { saveState, saveError, lastSavedAt, queueSave, flushNow, dirtyRef } = useAutosave({
    postId: post.id,
    initialUpdatedAt: post.updatedAt,
    initialTitle: post.title,
    initialContentJson: post.contentJson,
    enabled: !readOnly,
    onSlugConflict: (message) => {
      setSlugAuto(false);
      toast.warning(`${message}. Matn saqlandi — slugni o'zgartiring.`);
    },
  });

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
  }, [dirtyRef]);

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
    // Xodim (staff) `/admin/telegram/status`ga kira olmaydi (403) — kanal ma'lumoti faqat admin uchun.
    if (isStaff) return;
    adminApi
      .getTelegramStatus()
      .then((status) => {
        if (status.configured) setTelegramChannel(status.channel);
      })
      .catch(() => {
        // Telegram holatini olishda xatolik bo'lsa ham tahrirlagich ishlashda davom etadi.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sarlavha qatori balandligi — asboblar paneli shunga yopishadi (sticky).
  useLayoutEffect(() => {
    const root = rootRef.current;
    const header = root?.querySelector<HTMLElement>("[data-editor-header]");
    if (!root || !header) return;
    const apply = () => root.style.setProperty("--editor-header-h", `${header.offsetHeight}px`);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  // Sarlavha maydoni balandligi matnga qarab o'sadi (boshlang'ich uzun sarlavha ham).
  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [title]);

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

  const channelUrl =
    telegram?.channelMessageId && telegramChannel?.startsWith("@")
      ? `https://t.me/${telegramChannel.slice(1)}/${telegram.channelMessageId}`
      : null;

  const editor = useEditor({
    immediatelyRender: false,
    extensions: createEditorExtensions({ media: true }),
    content: post.contentJson as JSONContent,
    editable: !readOnly,
    editorProps: {
      attributes: { class: "tiptap prose-article" },
      // Kursor sticky sarlavha/asboblar paneli ostida qolmasin.
      scrollMargin: { top: 150, bottom: 96, left: 0, right: 0 },
      scrollThreshold: { top: 150, bottom: 96, left: 0, right: 0 },
    },
    onUpdate: ({ editor: ed }) => queueSave({ contentJson: ed.getJSON() }),
  });

  useEffect(() => {
    // emitUpdate=false: aks holda `update` hodisasi chiqib, o'qish-uchun postda 409 PATCH ketadi.
    editor?.setEditable(!readOnly, false);
  }, [editor, readOnly]);

  useCaretFollow(editor);

  // So'z/belgi/mundarija — har tuslanishda emas, kichik kechikish bilan.
  useEffect(() => {
    if (!editor) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const compute = () => {
      if (editor.isDestroyed) return;
      const json = editor.getJSON();
      setSnapshot({ stats: docStats(json), outline: extractOutline(json) });
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(compute, 250);
    };
    compute();
    editor.on("update", schedule);
    return () => {
      if (timer) clearTimeout(timer);
      editor.off("update", schedule);
    };
  }, [editor]);

  const bodyEmpty = useEditorState({ editor, selector: (ctx) => ctx.editor?.isEmpty ?? true });

  // Mahalliy zaxira: serverdagi nusxadan yangiroq saqlanmagan matn bo'lsa — bloklamaydigan xabar.
  useEffect(() => {
    if (readOnly) return;
    const storage = browserStorage();
    const backup = loadBackup(storage, post.id);
    if (!backup) return;
    const server = { updatedAt: post.updatedAt, title: post.title, contentJson: post.contentJson };
    if (!shouldOfferRestore(backup, server)) {
      clearBackup(storage, post.id);
      return;
    }
    const timer = setTimeout(() => setDraftOffer({ backup, serverNewer: serverChangedSinceBackup(backup, server) }), 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- faqat ochilganda
  }, []);

  function restoreDraft() {
    if (!draftOffer || !editor) return;
    const { backup } = draftOffer;
    setTitle(backup.title);
    queueSave({ title: backup.title });
    editor.commands.setContent(backup.contentJson as JSONContent, { emitUpdate: true });
    setDraftOffer(null);
    toast.success("Mahalliy nusxa tiklandi");
  }

  function discardDraft() {
    clearBackup(browserStorage(), post.id);
    setDraftOffer(null);
  }

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

  function handleTitleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      editor?.chain().focus("start").run();
    }
  }

  /** Joylashtirilgan yangi qatorlar bo'shliqqa aylanadi (sarlavha — bitta qator). */
  function handleTitlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const text = event.clipboardData.getData("text/plain");
    if (!/[\r\n]/.test(text)) return;
    event.preventDefault();
    const el = event.currentTarget;
    const clean = text.replace(/\s*[\r\n]+\s*/g, " ").trim();
    const start = el.selectionStart;
    const end = el.selectionEnd;
    handleTitleChange(title.slice(0, start) + clean + title.slice(end));
    const caret = start + clean.length;
    requestAnimationFrame(() => el.setSelectionRange(caret, caret));
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

  async function handlePublish(opts?: { sendToChannel?: boolean }) {
    try {
      const result = await adminApi.publishPost(post.id, opts);
      setStatus(result.status);
      const send = result.channelSend;
      if (send?.state === "sent") toast.success("Post chop etildi va kanalga yuborildi");
      else if (send?.state === "failed") toast.error(`Post chop etildi, lekin kanalga yuborilmadi: ${send.error ?? "noma'lum xato"}`);
      else if (send?.state === "pending") toast.success("Post chop etildi — kanalga yuborilmoqda, natija admin chatiga keladi");
      else toast.success("Post chop etildi");
    } catch (error) {
      toast.error(errorMessage(error, "Chop etishda xatolik"));
    }
  }

  async function handleUnpublish() {
    try {
      const result = await adminApi.unpublishPost(post.id);
      setStatus(result.status);
      setChannelPlan(null); // server ham rejani tozalaydi
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
      const result = await adminApi.schedulePost(post.id, iso, channelPlan);
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
    postId: post.id,
    channelPlan,
    channelPlanBlocked,
    onChannelPlanBlockingChange: setChannelPlanBlocked,
    onChannelPlanChange: (plan: ChannelPlan | null) => {
      setChannelPlan(plan);
      // Allaqachon rejalashtirilgan postda o'zgarish avtosaqlash orqali serverga boradi (faqat admin).
      if (status === "scheduled") queueSave({ channelPlan: plan });
    },
    onCancelSchedule: () => void handleUnpublish(),
    telegram,
    channelUrl,
    onRefreshTelegraph: () => void handleRefreshTelegraph(),
    refreshingTelegraph,
    onOpenChannelSend: () => setChannelSendOpen(true),
    channelChoice,
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
    channelChoice,
    onOpenChannelVersion: () => setChannelSendOpen(true),
  };

  // ---------------------------------------------------------------- chop etishdan oldingi tekshiruv

  const getChecklist = useCallback(
    (): ChecklistItem[] =>
      buildPublishChecklist({
        title,
        slug,
        doc: editor && !editor.isDestroyed ? editor.getJSON() : post.contentJson as JSONContent,
        coverUrl,
        excerpt,
        tagCount: tagSlugs.length,
      }),
    [title, slug, editor, coverUrl, excerpt, tagSlugs.length, post.contentJson],
  );

  const handleFix = useCallback(
    (target: FixTarget) => {
      // Dialog yopilgach fokus qaytishi bilan to'qnashmaslik uchun kichik kechikish.
      window.setTimeout(() => {
        if (target === "title") {
          titleRef.current?.focus();
          titleRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
          return;
        }
        if (target === "slug") {
          slugRef.current?.focus();
          slugRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
          return;
        }
        if (target === "cover" || target === "excerpt" || target === "tags") {
          const find = () => document.querySelector<HTMLElement>(`[data-editor-field="${target}"]`);
          const desktop = window.matchMedia("(min-width: 1024px)").matches;
          if (!desktop) setSettingsOpen(true);
          window.setTimeout(() => {
            const el = Array.from(document.querySelectorAll<HTMLElement>(`[data-editor-field="${target}"]`)).find((n) => n.offsetParent !== null) ?? find();
            el?.scrollIntoView({ block: "center", behavior: "smooth" });
            el?.querySelector<HTMLElement>("textarea, input, button")?.focus({ preventScroll: true });
          }, desktop ? 0 : 350);
          return;
        }
        if (!editor) return;
        if (target === "body") {
          editor.chain().focus("end").run();
          return;
        }
        const { doc } = editor.state;
        let found: { pos: number; kind: "image" | "heading" | "hint"; size: number } | null = null;
        doc.descendants((node, pos) => {
          if (found) return false;
          if (target === "imageAlt" && node.type.name === "image" && !String(node.attrs.alt ?? "").trim()) found = { pos, kind: "image", size: node.nodeSize };
          else if (target === "emptyHeading" && node.type.name === "heading" && node.content.size === 0) found = { pos, kind: "heading", size: node.nodeSize };
          else if (target === "hints" && node.type.name === "paragraph" && node.content.size > 0 && isHintText(node.textContent)) found = { pos, kind: "hint", size: node.nodeSize };
          return !node.isTextblock;
        });
        const hit = found as { pos: number; kind: "image" | "heading" | "hint"; size: number } | null;
        if (!hit) return;
        const sel = hit.kind === "image" ? NodeSelection.create(doc, hit.pos) : hit.kind === "heading" ? TextSelection.create(doc, hit.pos + 1) : TextSelection.create(doc, hit.pos + 1, hit.pos + hit.size - 1);
        editor.view.dispatch(editor.state.tr.setSelection(sel).scrollIntoView());
        editor.commands.focus();
      }, 150);
    },
    [editor],
  );

  const editorActions: EditorMenuActions | undefined = readOnly
    ? undefined
    : {
        onOpenInsert: () => setInsertOpen(true),
        onToggleFocus: toggleFocus,
        onOpenShortcuts: () => window.dispatchEvent(new CustomEvent(OPEN_SHORTCUTS_EVENT)),
      };

  const submitBlocked = hasBlockingIssue(submitChecklist);
  const showStarter = !readOnly && !!editor && bodyEmpty && !starterDismissed;
  const footerSave: FooterSaveInfo = { text: footerText(saveState, lastSavedAt, saveError), tone: saveTone(saveState) };

  return (
    <div ref={rootRef} className="flex flex-col gap-4">
      {isStaff ? (
        <StaffEditorHeader
          postId={post.id}
          status={status}
          saveState={saveState}
          saveError={saveError}
          lastSavedAt={lastSavedAt}
          canSubmit={canSubmit}
          onSubmit={() => {
            setSubmitChecklist(getChecklist());
            setSubmitOpen(true);
          }}
          onOpenChannelVersion={() => setChannelSendOpen(true)}
          editorActions={editorActions}
        />
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
          onOpenChannelSend={() => setChannelSendOpen(true)}
          channelChoice={channelChoice}
          getChecklist={getChecklist}
          onFix={handleFix}
          editorActions={editorActions}
        />
      )}

      {editor && !readOnly ? <EditorToolbar editor={editor} onToggleFocus={toggleFocus} focusMode={focusMode} /> : null}

      <ChannelSendDialog
        postId={post.id}
        open={channelSendOpen}
        onOpenChange={setChannelSendOpen}
        mode={isStaff ? "suggest" : status === "published" ? "send" : "prepare"}
        readOnly={isStaff && status !== "draft" && status !== "changes_requested"}
        onChoiceChange={setChannelChoice}
      />

      {isStaff ? <StaffReviewBanner status={status} reviewNote={reviewNote} /> : null}
      {!isStaff && status === "in_review" ? (
        <AdminReviewActions
          postId={post.id}
          authorName={post.createdBy?.name ?? "Xodim"}
          channelChoice={channelChoice}
          onApproved={(next) => setStatus(next)}
          onChangesRequested={(next) => {
            setStatus(next);
            setReviewNote(null);
          }}
        />
      ) : null}

      <div className="editor-grid grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
        <div className="flex min-w-0 flex-col gap-3" data-editor-column>
          {draftOffer ? <DraftBanner serverNewer={draftOffer.serverNewer} onRestore={restoreDraft} onDiscard={discardDraft} /> : null}

          <textarea
            ref={titleRef}
            value={title}
            onChange={(event) => handleTitleChange(event.target.value)}
            onKeyDown={handleTitleKeyDown}
            onPaste={handleTitlePaste}
            placeholder="Sarlavha"
            rows={1}
            disabled={readOnly}
            aria-label="Sarlavha"
            className="post-editor-title"
          />

          <div className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground md:flex-wrap">
            <span className="max-w-full truncate max-md:max-w-[38%] max-md:shrink-0">{site.url}/</span>
            <input
              ref={slugRef}
              value={slug}
              onChange={(event) => handleSlugChange(event.target.value)}
              disabled={readOnly}
              aria-label="Slug"
              className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 py-0.5 hover:border-border focus:border-border focus:outline-none max-md:min-h-11 max-md:truncate"
            />
            {!readOnly ? (
              <button
                type="button"
                onClick={() => setSlugAuto((v) => !v)}
                aria-pressed={slugAuto}
                title={slugAuto ? "Slug sarlavhadan avtomatik yangilanadi" : "Slug qulflangan"}
                className="shrink-0 rounded-md px-1.5 py-0.5 hover:bg-muted max-md:min-h-11 max-md:min-w-11"
              >
                {slugAuto ? "🔓" : "🔒"}
              </button>
            ) : null}
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit max-lg:h-11 max-lg:px-4 lg:hidden"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 className="size-4" />
            {isStaff ? "Qo'shimcha" : "Sozlamalar"}
          </Button>

          {editor && showStarter ? (
            <StarterPanel
              editor={editor}
              onBlank={() => {
                setStarterDismissed(true);
                editor.commands.focus("start");
              }}
              onImportMarkdown={() => setInsertOpen(true)}
            />
          ) : null}

          {editor ? (
            <>
              <PostEditorBubbleMenu editor={editor} />
              <LinkPopover editor={editor} />
              <ImageToolbar editor={editor} />
              <TableToolbar editor={editor} />
              <InsertPlus editor={editor} />
              <ImagePicker editor={editor} />
            </>
          ) : null}

          <div className="tiptap-editor-content">
            <EditorContent editor={editor} />
          </div>
        </div>

        <aside className="hidden lg:block" data-editor-focus-hide>
          <div className="sticky top-[calc(var(--editor-header-h,3.5rem)+3.5rem)] flex max-h-[calc(100svh-var(--editor-header-h,3.5rem)-6rem)] flex-col gap-4 overflow-y-auto pb-2">
            {editor && !readOnly ? <OutlinePanel editor={editor} items={snapshot.outline} /> : null}
            {isStaff ? <StaffEditorPanel {...staffPanelProps} /> : <PostEditorSettings {...settingsProps} />}
          </div>
        </aside>
      </div>

      {editor ? <ShortcutsDialog /> : null}
      {editor && !readOnly ? (
        <InsertDialog
          editor={editor}
          open={insertOpen}
          onOpenChange={setInsertOpen}
          setTitle={
            title.trim() === "" || title.trim() === "Nomsiz post"
              ? (value) => {
                  handleTitleChange(value);
                }
              : null
          }
        />
      ) : null}

      <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
        <SheetContent side="right" className="overflow-y-auto p-4 max-sm:data-[side=right]:w-full">
          <SheetHeader className="p-0">
            <SheetTitle>{isStaff ? "Qo'shimcha" : "Sozlamalar"}</SheetTitle>
          </SheetHeader>
          {isStaff ? <StaffEditorPanel {...staffPanelProps} /> : <PostEditorSettings {...settingsProps} />}
        </SheetContent>
      </Sheet>

      <AlertDialog open={submitOpen} onOpenChange={setSubmitOpen}>
        <AlertDialogContent className="max-h-[90svh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>Ko&apos;rib chiqishga yuborish</AlertDialogTitle>
            <AlertDialogDescription>
              Post admin tomonidan tasdiqlanmaguncha tahrirlab bo&apos;lmaydi. Admin tasdiqlagach, post saytda va
              Telegram kanalida avtomatik chop etiladi.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {submitChecklist.length > 0 ? (
            <PublishChecklist
              items={submitChecklist}
              onFix={(target) => {
                setSubmitOpen(false);
                handleFix(target);
              }}
            />
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
            <AlertDialogAction disabled={submitting || submitBlocked} onClick={() => void handleSubmit()}>
              Yuborish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {editor && !readOnly ? <StatusFooter stats={snapshot.stats} save={footerSave} /> : null}
    </div>
  );
}
