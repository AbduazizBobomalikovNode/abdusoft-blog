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
    settings: jsonb("settings").notNull().default({}),
    viewsCount: integer("views_count").notNull().default(0),
    likesCount: integer("likes_count").notNull().default(0),
    dislikesCount: integer("dislikes_count").notNull().default(0),
    commentsCount: integer("comments_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [index("comments_post_path_idx").on(table.postId, table.path)],
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const telegramRefs = pgTable("telegram_refs", {
  postId: uuid("post_id")
    .primaryKey()
    .references(() => posts.id, { onDelete: "cascade" }),
  telegraphPath: text("telegraph_path"),
  telegraphUrl: text("telegraph_url"),
  channelMessageId: bigint("channel_message_id", { mode: "number" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const siteSettings = pgTable("site_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
});
