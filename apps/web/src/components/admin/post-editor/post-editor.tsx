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
import { DistributionDialog } from "./distribution-dialog";
import { ConflictBanner } from "./conflict-banner";
import { HistoryDialog } from "./history-dialog";
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
import { lastChangeText } from "@/lib/admin-labels";
import { isConflictFailure, PostSync } from "@/lib/editor/post-sync";
import { buildPublishChecklist, hasBlockingIssue, type ChecklistItem, type FixTarget } from "@blog/shared";
import { backupDiffKeys, backupFieldKeys, backupFieldLabels, backupValue, browserStorage, clearBackup, loadBackup, serverChangedSinceBackup, type DraftBackup } from "@/lib/editor/draft-backup";
import { PendingNotSavedError } from "@/lib/editor/autosave-engine";
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
  if (state === "conflict") return "Saqlanmadi — post boshqa joyda o'zgargan";
  if (state === "error") return saveError ? `Xato: ${saveError}` : "Xato — saqlanmadi";
  if (state === "saved" && lastSavedAt) return `Saqlandi ${formatTime(lastSavedAt)}`;
  return "";
}

type DraftOffer = { backup: DraftBackup; serverNewer: boolean; /** Tiklash nimalarni qaytarishi (o'zbekcha nomlar). */ fields: string[] };

/**
 * Sahifa shu komponentni ishlatadi. "Oxirgi versiyani yuklash" va "Shu versiyaga qaytarish"dan keyin tahrirlagich
 * serverdan olingan yangi nusxa bilan BUTUNLAY qayta quriladi (`key`) — eski holat (kutayotgan avtosaqlash, taymerlar,
 * tiptap hujjati) qolib, yangi matnni ustidan yozib yubora olmaydi.
 */
export function PostEditor({ post, allTags, me }: { post: AdminPostDetail; allTags: TagWithCount[]; me: Me }) {
  const [instance, setInstance] = useState<{ key: number; post: AdminPostDetail; offer: DraftOffer | null }>({ key: 0, post, offer: null });
  const reload = useCallback(
    (fresh: AdminPostDetail, offer: DraftOffer | null) => setInstance((prev) => ({ key: prev.key + 1, post: fresh, offer })),
    [],
  );
  return <PostEditorInner key={instance.key} post={instance.post} allTags={allTags} me={me} initialDraftOffer={instance.offer} onReload={reload} />;
}

function PostEditorInner({
  post,
  allTags,
  me,
  initialDraftOffer = null,
  onReload,
}: {
  post: AdminPostDetail;
  allTags: TagWithCount[];
  me: Me;
  initialDraftOffer?: DraftOffer | null;
  onReload: (fresh: AdminPostDetail, offer: DraftOffer | null) => void;
}) {
  const router = useRouter();
  // Postga yozuvchi BARCHA so'rovlar (avtosaqlash, holat o'tishlari, versiyaga qaytarish) shu navbat orqali ketadi.
  const [sync] = useState(() => new PostSync(post.updatedAt));
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
  // "Tarqatish" kirish nuqtasi: API'da DISTRIBUTION_ENABLED o'chiq bo'lsa marshrut 404 -> hech narsa ko'rsatilmaydi.
  const [distributionOn, setDistributionOn] = useState(false);
  const [distributionOpen, setDistributionOpen] = useState(false);
  useEffect(() => {
    if (isStaff) return;
    let alive = true;
    adminApi
      .distributionChannels()
      .then(() => alive && setDistributionOn(true))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [isStaff]);
  const [channelPlanBlocked, setChannelPlanBlocked] = useState(false);
  const [channelChoice, setChannelChoice] = useState<ResolvedChannelChoice | null>(post.channelChoice);
  const [starterDismissed, setStarterDismissed] = useState(false);
  const [insertOpen, setInsertOpen] = useState(false);
  const [draftOffer, setDraftOffer] = useState<DraftOffer | null>(initialDraftOffer);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conflictBusy, setConflictBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<{ stats: DocStats; outline: OutlineItem[] }>({ stats: EMPTY_STATS, outline: [] });

  // Xodim (staff) uchun — post ko'rib chiqishda bo'lsa butunlay o'qish uchun
  // (API ham shu holatda PATCH'ni 409 bilan rad etadi — bu shunchaki mos UI).
  const readOnly = isStaff && status === "in_review";
  const canSubmit = isStaff && (status === "draft" || status === "changes_requested");

  const titleRef = useRef<HTMLTextAreaElement>(null);
  const slugRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const { focusMode, toggle: toggleFocus } = useFocusMode(true);

  const { engine, saveState, saveError, lastSavedAt, conflict, queueSave, flushNow, cancelTimers } = useAutosave({
    postId: post.id,
    initialUpdatedAt: post.updatedAt,
    // Muharrir ushlab turgan TO'LIQ holat (rolga mos): "almashtirish" va jimgina tenglashtirish shunga tayanadi.
    initialLocal: {
      title: post.title,
      slug: post.slug,
      excerpt: post.excerpt ?? "",
      coverUrl: post.coverUrl,
      tagSlugs: post.tags.map((t) => t.slug),
      contentJson: post.contentJson,
      ...(isStaff ? {} : { settings: post.settings, pinned: post.pinned }),
      ...(!isStaff && post.status === "scheduled" ? { channelPlan: post.channelPlan } : {}),
    },
    initialManaged: { status: post.status, scheduledAt: post.scheduledAt, publishedAt: post.publishedAt },
    onStale: () => void handleLoadLatest({ quiet: true }),
    enabled: !readOnly,
    sync,
    meId: me.id,
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
      if (!engine.dirty) return;
      event.preventDefault();
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [engine]);

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
    // Konfliktdan keyin yoki versiyaga qaytarishdan keyin qayta qurilganda: taklif tayyor (yoki ataylab yo'q) — zaxiraga tegmaymiz.
    if (initialDraftOffer) return;
    const storage = browserStorage();
    const backup = loadBackup(storage, post.id);
    if (!backup) return;
    const server = { updatedAt: post.updatedAt, title: post.title, contentJson: post.contentJson };
    const keys = backupDiffKeys(backup, post);
    if (backup.savedAt <= Date.parse(post.updatedAt) || keys.length === 0) {
      clearBackup(storage, post.id);
      return;
    }
    const timer = setTimeout(
      () => setDraftOffer({ backup, serverNewer: serverChangedSinceBackup(backup, server), fields: backupFieldLabels(keys) }),
      0,
    );
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- faqat ochilganda
  }, []);

  /** Mahalliy nusxani tiklash: zaxiradagi HAMMA saqlanmagan maydonlar (yoki eski zaxirada — sarlavha va matn) qaytariladi. */
  function restoreDraft() {
    if (!draftOffer || !editor) return;
    const { backup } = draftOffer;
    for (const key of backupFieldKeys(backup)) {
      const value = backupValue(backup, key);
      if (key === "title") {
        setTitle(backup.title);
        queueSave({ title: backup.title });
      } else if (key === "contentJson") {
        editor.commands.setContent(backup.contentJson as JSONContent, { emitUpdate: true });
      } else if (key === "slug" && typeof value === "string") {
        setSlug(value);
        setSlugAuto(false);
        queueSave({ slug: value });
      } else if (key === "excerpt" && typeof value === "string") {
        setExcerpt(value);
        queueSave({ excerpt: value });
      } else if (key === "coverUrl") {
        setCoverUrl((value as string | null) ?? null);
        queueSave({ coverUrl: (value as string | null) ?? null });
      } else if (key === "tagSlugs" && Array.isArray(value)) {
        setTagSlugs(value as string[]);
        queueSave({ tagSlugs: value as string[] });
      } else if (key === "settings" && value && typeof value === "object") {
        const next = { ...settings, ...(value as Partial<PostSettings>) };
        setSettings(next);
        queueSave({ settings: next });
      } else if (key === "pinned" && typeof value === "boolean") {
        setPinned(value);
        queueSave({ pinned: value });
      } else if (key === "channelPlan") {
        setChannelPlan((value as ChannelPlan | null) ?? null);
        queueSave({ channelPlan: (value as ChannelPlan | null) ?? null });
      }
    }
    setDraftOffer(null);
    toast.success("Mahalliy nusxa tiklandi");
  }

  function discardDraft() {
    clearBackup(browserStorage(), post.id);
    setDraftOffer(null);
  }

  /**
   * Konfliktdan kelib chiqqan xatoni jim o'tkazadi (banner o'zi ko'rsatadi). Matn saqlanmagani uchun to'xtagan o'tishda
   * sababini aytadi (matn yo'qolmagan). Boshqa xatolar uchun `false` — chaqiruvchi o'z toast'ini ko'rsatadi.
   */
  function handledAsConflict(error: unknown): boolean {
    if (error instanceof PendingNotSavedError) {
      toast.error(error.message);
      return true;
    }
    return isConflictFailure(error);
  }

  async function handleSubmit() {
    setSubmitting(true);
    try {
      const result = await engine.runTransition(async (token) => {
        const res = await adminApi.submitPost(post.id, { expectedUpdatedAt: token });
        // Eski API `updatedAt` qaytarmasa — tokenni serverdan olamiz (yolg'on konflikt bo'lmasin).
        if (!res.updatedAt) return { ...res, updatedAt: (await adminApi.getPost(post.id)).updatedAt };
        return res;
      });
      setStatus(result.status);
      toast.success("Ko'rib chiqishga yuborildi");
      setSubmitOpen(false);
    } catch (error) {
      if (handledAsConflict(error)) setSubmitOpen(false);
      else toast.error(errorMessage(error, "Yuborishda xatolik"));
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
      const result = await engine.runTransition((token) => adminApi.publishPost(post.id, { ...opts, expectedUpdatedAt: token }));
      setStatus(result.status);
      const send = result.channelSend;
      if (send?.state === "sent") toast.success("Post chop etildi va kanalga yuborildi");
      else if (send?.state === "failed") toast.error(`Post chop etildi, lekin kanalga yuborilmadi: ${send.error ?? "noma'lum xato"}`);
      else if (send?.state === "pending") toast.success("Post chop etildi — kanalga yuborilmoqda, natija admin chatiga keladi");
      else toast.success("Post chop etildi");
    } catch (error) {
      if (!handledAsConflict(error)) toast.error(errorMessage(error, "Chop etishda xatolik"));
    }
  }

  async function handleUnpublish() {
    try {
      const result = await engine.runTransition((token) => adminApi.unpublishPost(post.id, { expectedUpdatedAt: token }));
      setStatus(result.status);
      setChannelPlan(null); // server ham rejani tozalaydi
      toast.success("Post qoralamaga qaytarildi");
    } catch (error) {
      if (!handledAsConflict(error)) toast.error(errorMessage(error, "Amalni bajarib bo'lmadi"));
    }
  }

  async function handleArchive() {
    try {
      const result = await engine.runTransition((token) => adminApi.archivePost(post.id, { expectedUpdatedAt: token }));
      setStatus(result.status);
      toast.success("Post arxivlandi");
    } catch (error) {
      if (!handledAsConflict(error)) toast.error(errorMessage(error, "Amalni bajarib bo'lmadi"));
    }
  }

  async function handleDelete() {
    try {
      await engine.runTransition(async (token) => {
        await adminApi.deletePost(post.id, { expectedUpdatedAt: token });
        return {};
      });
      // Post savatda — saqlanmagan mahalliy nusxa endi keraksiz (savatdan tiklansa, serverdagi matn qaytadi).
      engine.discardPending();
      clearBackup(browserStorage(), post.id);
      toast.success("Post savatga ko'chirildi — uni Postlar > Savat bo'limidan tiklash mumkin");
      router.push("/admin/postlar");
    } catch (error) {
      if (!handledAsConflict(error)) toast.error(errorMessage(error, "O'chirib bo'lmadi"));
    }
  }

  async function handleSchedule() {
    if (!scheduledAtLocal) return;
    setScheduling(true);
    try {
      const iso = new Date(scheduledAtLocal).toISOString();
      const result = await engine.runTransition((token) => adminApi.schedulePost(post.id, iso, channelPlan, { expectedUpdatedAt: token }));
      setStatus(result.status);
      toast.success("Post rejalashtirildi");
    } catch (error) {
      if (!handledAsConflict(error)) toast.error(errorMessage(error, "Rejalashtirib bo'lmadi"));
    } finally {
      setScheduling(false);
    }
  }

  async function handleExcerptAuto() {
    try {
      await engine.runTransition((token) => adminApi.updatePost(post.id, token ? { excerpt: null, expectedUpdatedAt: token } : { excerpt: null }));
      const fresh = await adminApi.getPost(post.id);
      setExcerpt(fresh.excerpt ?? "");
      toast.success("Avtomatik tavsif qo'llandi");
    } catch (error) {
      if (!handledAsConflict(error)) toast.error(errorMessage(error, "Amalni bajarib bo'lmadi"));
    }
  }

  // ---------------------------------------------------------------- konflikt va tarix

  /**
   * "Oxirgi versiyani yuklash": HAMMA saqlanmagan maydonlar (sarlavha, matn, tavsif, teglar, muqova, havola, sozlamalar, ...)
   * zaxiraga yoziladi, serverdagi nusxa yuklanadi, zaxira esa "Tiklash" taklifi bilan (qaysi maydonlar qaytishi ko'rsatilib) qoladi.
   */
  async function handleLoadLatest(opts: { quiet?: boolean } = {}) {
    setConflictBusy(true);
    try {
      cancelTimers();
      const { fresh, offer, fields } = await engine.loadLatest();
      onReload(fresh, offer ? { backup: offer, serverNewer: true, fields: backupFieldLabels(fields) } : null);
      toast.success(offer ? "Oxirgi versiya yuklandi — sizning o'zgarishlaringiz tiklash uchun saqlab qo'yildi" : opts.quiet ? "Tahrirlagich serverdagi oxirgi versiya bilan yangilandi" : "Oxirgi versiya yuklandi");
    } catch (error) {
      toast.error(errorMessage(error, "Oxirgi versiyani yuklab bo'lmadi"));
    } finally {
      setConflictBusy(false);
    }
  }

  /**
   * "Meniki bilan almashtirish" (tasdiqdan keyin): muharrirning TO'LIQ holati bir marta tokensiz yoziladi; serverdagi nusxa
   * Tarixda qoladi. Saqlanmagan o'zgarish yo'q bo'lsa (konflikt holat o'tishidan kelgan) — forma eskirgan, shuning uchun
   * "oxirgi versiyani yuklash" yo'li bilan serverdan qayta quramiz.
   */
  async function handleOverwrite() {
    if (!conflict) return;
    if (!engine.dirty) {
      await handleLoadLatest({ quiet: true });
      return;
    }
    setConflictBusy(true);
    try {
      cancelTimers();
      const ok = await engine.overwrite();
      if (ok) toast.success("Sizning versiyangiz saqlandi. Oldingisi Tarixda");
      else toast.error("Saqlab bo'lmadi — o'zgarishlaringiz saqlab qo'yildi, qayta urinib ko'ring");
    } finally {
      setConflictBusy(false);
    }
  }

  /**
   * "Shu versiyaga qaytarish": avval yo'ldagi saqlash tugaydi va kutayotgan matn to'liq saqlanadi (saqlanmasa — to'xtaymiz,
   * matn yo'qolmaydi), so'ng tokenli so'rov. So'rov davomida yana yozilgan bo'lsa, u tashlanmaydi — tiklash taklifi bo'lib qoladi.
   */
  async function handleRestoreRevision(revisionId: string, opts: { restoreSlug: boolean }): Promise<boolean> {
    if (sync.conflict) {
      toast.warning("Avval post boshqa joyda o'zgargani haqidagi xabarni hal qiling");
      return false;
    }
    try {
      const mark = engine.editCount;
      const result = await engine.runTransition((token) =>
        adminApi.restoreRevision(post.id, revisionId, { expectedUpdatedAt: token, ...(opts.restoreSlug ? { restoreSlug: true } : {}) }),
      );
      cancelTimers();
      const fresh = await adminApi.getPost(post.id);
      const typedMeanwhile = engine.takeOver(mark);
      engine.adoptServer(fresh);
      onReload(
        fresh,
        typedMeanwhile ? { backup: typedMeanwhile, serverNewer: true, fields: backupFieldLabels(backupDiffKeys(typedMeanwhile, fresh)) } : null,
      );
      if (result.slug !== post.slug) toast.success(`Versiya tiklandi. Havola o'zgardi: /${result.slug}`);
      else if (!result.slugRestored && (status === "published" || status === "scheduled")) toast.success("Versiya tiklandi. Havola o'zgarmadi (joriy URL saqlandi)");
      else toast.success("Versiya tiklandi. Oldingi holat Tarixda saqlandi");
      return true;
    } catch (error) {
      if (!handledAsConflict(error)) toast.error(errorMessage(error, "Versiyaga qaytarib bo'lmadi"));
      return false;
    }
  }

  const canRestoreRevision = !readOnly && (!isStaff || status === "draft" || status === "changes_requested");

  const settingsProps = {
    status,
    publishedAt: post.publishedAt,
    updatedAt: lastSavedAt ?? post.updatedAt,
    lastChangeBy: lastChangeText(
      lastSavedAt && lastSavedAt !== post.updatedAt ? { name: me.name } : post.updatedBy,
      lastSavedAt && lastSavedAt !== post.updatedAt ? "web" : post.updatedVia,
    ),
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
          onOpenHistory={() => setHistoryOpen(true)}
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
          onOpenDistribution={distributionOn ? () => setDistributionOpen(true) : undefined}
          onOpenHistory={() => setHistoryOpen(true)}
          journalHref={`/admin/jurnal?entityType=post&entityId=${post.id}`}
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

      {distributionOn ? <DistributionDialog postId={post.id} open={distributionOpen} onOpenChange={setDistributionOpen} /> : null}

      {conflict ? (
        <ConflictBanner
          conflict={conflict}
          meId={me.id}
          busy={conflictBusy}
          onLoadLatest={() => void handleLoadLatest()}
          onOverwrite={() => void handleOverwrite()}
          onOpenHistory={() => setHistoryOpen(true)}
        />
      ) : null}

      <HistoryDialog
        postId={post.id}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        postStatus={status}
        canRestore={canRestoreRevision}
        showJournalLink={!isStaff}
        onRestore={handleRestoreRevision}
      />

      {isStaff ? <StaffReviewBanner status={status} reviewNote={reviewNote} /> : null}
      {!isStaff && status === "in_review" ? (
        <AdminReviewActions
          postId={post.id}
          authorName={post.createdBy?.name ?? "Xodim"}
          channelChoice={channelChoice}
          run={(op) => engine.runTransition(op)}
          onApproved={(next) => setStatus(next)}
          onChangesRequested={(next) => {
            setStatus(next);
            setReviewNote(null);
          }}
        />
      ) : null}

      <div className="editor-grid grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
        <div className="flex min-w-0 flex-col gap-3" data-editor-column>
          {draftOffer ? <DraftBanner serverNewer={draftOffer.serverNewer} fields={draftOffer.fields} onRestore={restoreDraft} onDiscard={discardDraft} /> : null}

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
