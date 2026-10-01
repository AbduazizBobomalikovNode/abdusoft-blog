import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema.js";

export const postStatusEnum = pgEnum("post_status", [
  "draft",
  "in_review",
  "changes_requested",
  "scheduled",
  "published",
  "archived",
]);

export const commentStatusEnum = pgEnum("comment_status", [
  "visible",
  "pending",
  "hidden",
  "deleted",
]);

export const commentSourceEnum = pgEnum("comment_source", ["web", "telegram"]);

export const channelMessageTypeEnum = pgEnum("channel_message_type", ["text", "photo", "album"]);

/** Kanalga yuborilgan post varianti — "Kanalga yuborish" dialogidagi uzunlik tugmalari (`xl` faqat 📝 Rasmsiz rejimda). */
export const channelVariantEnum = pgEnum("channel_variant", ["s", "m", "l", "xl"]);

/** Kanalga yuborilgan post rejimi — 🖼 Rasmli (kover/rasmlar + caption) yoki 📝 Rasmsiz (oddiy matn). Eski qatorlarda `null` (legacy — `channelMessageType`ga qarab aniqlanadi). */
export const channelModeEnum = pgEnum("channel_mode", ["media", "text"]);

export const reactionTargetEnum = pgEnum("reaction_target_type", ["post", "comment"]);
export const reactionTypeEnum = pgEnum("reaction_type", ["like", "dislike"]);

export const posts = pgTable(
  "posts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    slug: text("slug").notNull().unique(),
    title: text("title").notNull(),
    excerpt: text("excerpt"),
    contentJson: jsonb("content_json").notNull(),
    contentHtml: text("content_html").notNull(),
    contentText: text("content_text").notNull().default(""),
    toc: jsonb("toc").notNull(),
    readingTime: integer("reading_time"),
    coverUrl: text("cover_url"),
    status: postStatusEnum("status").notNull().default("draft"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    pinned: boolean("pinned").notNull().default(false),
    /** Rejalashtirilgan postning kanal rejasi: `{ mode, variant, delayMinutes, attempts? }` (`ChannelPlanSchema`). */
    channelPlan: jsonb("channel_plan"),
    /** Post chop etilgach kanalga yuboriladigan vaqt — scheduler shu ustun bo'yicha ishlaydi. */
    channelSendAt: timestamp("channel_send_at", { withTimezone: true }),
    settings: jsonb("settings").notNull().default({}),
    viewsCount: integer("views_count").notNull().default(0),
    likesCount: integer("likes_count").notNull().default(0),
    dislikesCount: integer("dislikes_count").notNull().default(0),
    commentsCount: integer("comments_count").notNull().default(0),
    /** Telegram muhokama guruhidan olingan izohlar soni — `posts.commentsCount`dan alohida hisoblanadi (faqat web izohlar u yerda). */
    tgCommentsCount: integer("tg_comments_count").notNull().default(0),
    /** Postni yaratgan foydalanuvchi (admin yoki xodim/staff) — foydalanuvchi o'chirilsa `null` (post saqlanib qoladi). */
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    /** Postni oxirgi marta o'zgartirgan foydalanuvchi. */
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
    /** Admin "Qaytarish" (`changes_requested`) bosganda qoldirgan izohi — xodimga ko'rinadi. */
    reviewNote: text("review_note"),
    /** Xodim "Ko'rib chiqishga yuborish" bosgan payt (`in_review`ga o'tganda). */
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    /** Ko'rib chiqqan (approve/request-changes) admin. */
    reviewedBy: text("reviewed_by").references(() => user.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("posts_channel_send_at_idx").on(table.channelSendAt),
    index("posts_search_idx").using(
      "gin",
      sql`to_tsvector('simple', coalesce(${table.title}, '') || ' ' || coalesce(${table.contentText}, ''))`,
    ),
  ],
);

export const tags = pgTable("tags", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  color: text("color"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const postTags = pgTable(
  "post_tags",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.postId, table.tagId] })],
);

export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => comments.id),
    path: text("path").notNull(),
    depth: integer("depth").notNull().default(0),
    authorName: text("author_name").notNull(),
    authorTokenHash: text("author_token_hash"),
    authorUserId: text("author_user_id").references(() => user.id),
    body: text("body").notNull(),
    bodyHtml: text("body_html").notNull(),
    status: commentStatusEnum("status").notNull().default("visible"),
    likesCount: integer("likes_count").notNull().default(0),
    dislikesCount: integer("dislikes_count").notNull().default(0),
    ipHash: text("ip_hash"),
    /** Izoh manbai — 'web' (sayt/panel) yoki 'telegram' (kanalga bog'langan muhokama guruhi). */
    source: commentSourceEnum("source").notNull().default("web"),
    tgChatId: bigint("tg_chat_id", { mode: "number" }),
    tgMessageId: bigint("tg_message_id", { mode: "number" }),
    tgUsername: text("tg_username"),
    /** Telegram foydalanuvchi id'si — moderatsiyada `banChatMember` chaqirish uchun SHART (schema'da alohida ustun sifatida qo'shildi, spec matnidagi "author_tg_id" shuning uchun). */
    tgUserId: bigint("tg_user_id", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("comments_post_path_idx").on(table.postId, table.path),
    uniqueIndex("comments_tg_chat_message_idx").on(table.tgChatId, table.tgMessageId),
  ],
);

export const reactions = pgTable(
  "reactions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    targetType: reactionTargetEnum("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    deviceHash: text("device_hash").notNull(),
    type: reactionTypeEnum("type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("reactions_target_device_idx").on(
      table.targetType,
      table.targetId,
      table.deviceHash,
    ),
  ],
);

export const bannedDevices = pgTable(
  "banned_devices",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    deviceHash: text("device_hash"),
    ipHash: text("ip_hash"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("banned_devices_device_idx").on(table.deviceHash),
    index("banned_devices_ip_idx").on(table.ipHash),
  ],
);

export const postViewsDaily = pgTable(
  "post_views_daily",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    views: integer("views").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.postId, table.day] })],
);

export const postViewDedupe = pgTable(
  "post_view_dedupe",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    deviceHash: text("device_hash").notNull(),
    day: date("day").notNull(),
  },
  (table) => [primaryKey({ columns: [table.postId, table.deviceHash, table.day] })],
);

export const media = pgTable("media", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  key: text("key").notNull(),
  url: text("url").notNull(),
  mime: text("mime").notNull(),
  size: integer("size").notNull(),
  width: integer("width"),
  height: integer("height"),
  alt: text("alt"),
  /** Yuklagan foydalanuvchi — xodim (staff) faqat o'z media fayllarini ko'radi/o'chiradi. */
  createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Bir martalik xodim (staff) taklif havolalari — `/admin/xodimlar` sahifasi
 * yaratadi, `/taklif/[token]` sahifasi GitHub orqali kirgandan keyin
 * qabul qiladi. Xom `token` HECH QAYERDA saqlanmaydi — faqat sha256 hash.
 */
export const staffInvites = pgTable(
  "staff_invites",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tokenHash: text("token_hash").notNull().unique(),
    note: text("note"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    usedBy: text("used_by").references(() => user.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("staff_invites_token_hash_idx").on(table.tokenHash)],
);

/**
 * "Kanalga yuborish" uchun maxsus (custom) post versiyalari — avtomatik
 * variantlardan tashqari, admin qo'lda tahrirlagan matn + tanlangan rasmlar.
 * Manba post keyin o'zgarsa ham versiya AVTOMATIK o'zgarmaydi.
 */
export const channelPostVersions = pgTable(
  "channel_post_versions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mode: channelModeEnum("mode").notNull(),
    /** Cheklangan Tiptap hujjati. */
    contentJson: jsonb("content_json").notNull(),
    /** `contentJson`dan hosil qilingan Telegram HTML. */
    textHtml: text("text_html").notNull().default(""),
    visibleLength: integer("visible_length").notNull().default(0),
    /** Tanlangan rasmlar (tartib bilan); `text` rejimida bo'sh. */
    imageUrls: jsonb("image_urls").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** Qaysi avtomatik variantdan nusxa olingan (bo'lsa). */
    baseVariant: channelVariantEnum("base_variant"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("channel_post_versions_post_idx").on(table.postId)],
);

export const telegramRefs = pgTable("telegram_refs", {
  postId: uuid("post_id")
    .primaryKey()
    .references(() => posts.id, { onDelete: "cascade" }),
  telegraphPath: text("telegraph_path"),
  telegraphUrl: text("telegraph_url"),
  /** Bosh (captioned/birinchi) kanal xabari — orqaga moslik uchun saqlanadi (album bo'lsa ham birinchi element). */
  channelMessageId: bigint("channel_message_id", { mode: "number" }),
  /** Kanal xabari qanday yuborilgani — 'text' (sendMessage/editMessageText), 'photo' (sendPhoto/editMessageCaption) yoki 'album' (sendMediaGroup, faqat caption tahrirlanadi). Eski qatorlarda `null` (legacy — coverUrl bor-yo'qligiga qarab aniqlanadi). */
  channelMessageType: channelMessageTypeEnum("channel_message_type"),
  /** "Kanalga yuborish" dialogida tanlangan variant (qisqa/o'rtacha/batafsil/maksimal) — tahrirlashda caption/matn shu variant bilan qayta quriladi. */
  channelVariant: channelVariantEnum("channel_variant"),
  /** "Kanalga yuborish" dialogida tanlangan rejim (rasmli/rasmsiz) — resync shu rejim bilan qayta quradi. Eski qatorlarda `null`. */
  channelMode: channelModeEnum("channel_mode"),
  /** Kanalga maxsus versiyadan yuborilgan bo'lsa — shu versiya (`channelVariant` bu holda `null`); `post.updated`da caption qayta sinxronlanmaydi. */
  channelVersionId: uuid("channel_version_id").references(() => channelPostVersions.id, { onDelete: "set null" }),
  /** Kanalga yuborilgan BARCHA xabar id'lari (album bo'lsa bir nechta) — hujjat tartibida, `channelMessageId` shularning birinchisi. */
  channelMessageIds: jsonb("channel_message_ids").$type<number[]>(),
  /** "Kanalga yuborish" bosilgan payt — `null` bo'lsa hali qo'lda yuborilmagan. */
  channelSentAt: timestamp("channel_sent_at", { withTimezone: true }),
  /** Kanalga bog'langan muhokama guruhi va shu postning o'sha guruhga avtomatik forward qilingan xabari — Telegram izohlarini shu postga bog'lash uchun. */
  discussionChatId: bigint("discussion_chat_id", { mode: "number" }),
  discussionMessageId: bigint("discussion_message_id", { mode: "number" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const siteSettings = pgTable("site_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
});
