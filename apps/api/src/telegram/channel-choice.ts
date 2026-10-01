import { eq } from "drizzle-orm";
import {
  CHANNEL_CAPTION_HARD_LIMIT,
  CHANNEL_TEXT_HARD_LIMIT,
  ChannelChoiceSchema,
  type ChannelChoice,
  type ChannelMode,
  type ChannelSelection,
  type ChannelVariant,
  type ResolvedChannelChoice,
} from "@blog/shared";
import { db } from "../db/index.js";
import { user } from "../db/auth-schema.js";
import { posts } from "../db/schema.js";
import { computeChannelPreflight } from "./channel-preflight.js";
import { collectPostImages, loadVersion } from "./channel-versions.js";

type PostRow = typeof posts.$inferSelect;

const VARIANT_LABELS: Record<ChannelVariant, string> = { s: "Qisqa", m: "O'rtacha", l: "Batafsil", xl: "Maksimal" };
const MODE_LABELS: Record<ChannelMode, string> = { media: "Rasmli", text: "Rasmsiz" };

/** "Rasmli · O'rtacha" — avtomatik variant yorlig'i (emoji'siz). */
export function autoChoiceLabel(mode: ChannelMode, variant: ChannelVariant): string {
  return `${MODE_LABELS[mode]} · ${VARIANT_LABELS[variant]}`;
}

/** DB'dagi `channel_choice` jsonb'ni tekshiradi (buzilgan qiymat -> `null`). */
export function parseStoredChoice(value: unknown): ChannelChoice | null {
  if (value == null) return null;
  const parsed = ChannelChoiceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function choiceToSelection(choice: ChannelChoice): ChannelSelection {
  return choice.kind === "version" ? { versionId: choice.versionId } : { mode: choice.mode, variant: choice.variant };
}

/** Tanlovni kanalga yuborish yo'li: belgi yo'q bo'lsa postdagi rasmga qarab standart (`media/m` yoki `text/m`). */
export function defaultSelectionFor(post: Pick<PostRow, "coverUrl" | "contentJson">): ChannelSelection {
  return collectPostImages(post).length > 0 ? { mode: "media", variant: "m" } : { mode: "text", variant: "m" };
}

export type ChoiceForSend = { selection: ChannelSelection; fallback: boolean };

/**
 * Yuborish VAQTIDA postning JORIY belgisini hal qiladi (rejadagi `useChoice`).
 * Belgi yo'q (yoki buzilgan / versiyasi yo'qolgan) bo'lsa — standart tanlov va `fallback: true`.
 */
export async function resolveChoiceForSend(postId: string): Promise<ChoiceForSend | null> {
  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post) return null;
  const stored = parseStoredChoice(post.channelChoice);
  if (stored) {
    if (stored.kind === "auto") return { selection: choiceToSelection(stored), fallback: false };
    if (await loadVersion(postId, stored.versionId)) return { selection: choiceToSelection(stored), fallback: false };
  }
  return { selection: defaultSelectionFor(post), fallback: true };
}

/** Belgi + hisoblangan ma'lumotlar (yorliq, uzunlik, preflight, kim belgilagan). Belgi yo'q yoki versiyasi yo'q bo'lsa `null`. */
export async function resolveChannelChoice(post: PostRow): Promise<ResolvedChannelChoice | null> {
  const stored = parseStoredChoice(post.channelChoice);
  if (!stored) return null;

  const preflight = await computeChannelPreflight(post.id, choiceToSelection(stored), {
    requirePublished: false,
    planFallback: stored.kind === "auto",
  });
  if (!preflight.ok) return null; // masalan versiya o'chirilgan (odatda belgi o'sha zahoti tozalanadi)

  let label: string;
  let mode: ChannelMode;
  if (stored.kind === "version") {
    const version = await loadVersion(post.id, stored.versionId);
    if (!version) return null;
    label = version.name;
    mode = version.mode;
  } else {
    label = autoChoiceLabel(stored.mode, stored.variant);
    mode = stored.mode;
  }

  let setBy: ResolvedChannelChoice["setBy"] = null;
  let suggestedByStaff = false;
  if (post.channelChoiceBy) {
    const [row] = await db
      .select({ id: user.id, name: user.name, email: user.email, role: user.role })
      .from(user)
      .where(eq(user.id, post.channelChoiceBy))
      .limit(1);
    if (row) {
      setBy = { id: row.id, name: row.name || row.email };
      suggestedByStaff = row.role === "staff";
    }
  }

  return {
    choice: stored,
    label,
    mode,
    visibleLength: preflight.preflight.text.visibleLength,
    limit: mode === "media" ? CHANNEL_CAPTION_HARD_LIMIT : CHANNEL_TEXT_HARD_LIMIT,
    passes: preflight.preflight.canSend,
    setBy,
    setAt: post.channelChoiceAt?.toISOString() ?? null,
    suggestedByStaff,
  };
}

export type SetChoiceResult = { ok: true } | { ok: false; status: 404; error: string };

/** Belgini o'rnatadi (versiya shu postga tegishli bo'lishi shart). `userId` — kim belgilagani (xodim taklifi ham shunday saqlanadi). */
export async function setChannelChoice(postId: string, choice: ChannelChoice, userId: string): Promise<SetChoiceResult> {
  if (choice.kind === "version" && !(await loadVersion(postId, choice.versionId))) {
    return { ok: false, status: 404, error: "Versiya topilmadi" };
  }
  await db
    .update(posts)
    .set({ channelChoice: choice, channelChoiceBy: userId, channelChoiceAt: new Date() })
    .where(eq(posts.id, postId));
  return { ok: true };
}

export async function clearChannelChoice(postId: string): Promise<void> {
  await db.update(posts).set({ channelChoice: null, channelChoiceBy: null, channelChoiceAt: null }).where(eq(posts.id, postId));
}

/** Berilgan versiya belgilangan bo'lsa — belgini tozalaydi va `true` qaytaradi. */
export async function clearChoiceIfVersion(post: Pick<PostRow, "id" | "channelChoice">, versionId: string): Promise<boolean> {
  const stored = parseStoredChoice(post.channelChoice);
  if (stored?.kind !== "version" || stored.versionId !== versionId) return false;
  await clearChannelChoice(post.id);
  return true;
}
