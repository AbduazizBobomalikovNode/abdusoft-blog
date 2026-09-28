import { z } from "zod";
import { PostSettingsSchema } from "./post-settings.js";

export const TagSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  color: z.string().nullable(),
});
export type Tag = z.infer<typeof TagSchema>;

export const TagWithCountSchema = TagSchema.extend({
  postsCount: z.number(),
});
export type TagWithCount = z.infer<typeof TagWithCountSchema>;

export const TocItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  level: z.union([z.literal(2), z.literal(3)]),
});
export type TocItem = z.infer<typeof TocItemSchema>;

export const PostListItemSchema = z.object({
  slug: z.string(),
  title: z.string(),
  excerpt: z.string().nullable(),
  publishedAt: z.string().nullable(),
  readingTime: z.number().nullable(),
  pinned: z.boolean(),
  tags: z.array(TagSchema),
  counts: z.object({
    views: z.number(),
    likes: z.number(),
    dislikes: z.number(),
    comments: z.number(),
  }),
});
export type PostListItem = z.infer<typeof PostListItemSchema>;

export const PostListResponseSchema = z.object({
  items: z.array(PostListItemSchema),
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  hasMore: z.boolean(),
});
export type PostListResponse = z.infer<typeof PostListResponseSchema>;

export const AdjacentPostSchema = z
  .object({
    slug: z.string(),
    title: z.string(),
  })
  .nullable();
export type AdjacentPost = z.infer<typeof AdjacentPostSchema>;

export const PostDetailSchema = z.object({
  slug: z.string(),
  title: z.string(),
  excerpt: z.string().nullable(),
  html: z.string(),
  toc: z.array(TocItemSchema),
  coverUrl: z.string().nullable(),
  publishedAt: z.string().nullable(),
  readingTime: z.number().nullable(),
  pinned: z.boolean(),
  tags: z.array(TagSchema),
  settings: PostSettingsSchema,
  counts: z.object({
    views: z.number(),
    likes: z.number(),
    dislikes: z.number(),
    comments: z.number(),
    /** Kanalning muhokama guruhidan olingan (Telegram manbali) izohlar soni — `comments.telegramDisplay !== 'admin_only'` bo'lsa meta-qatorga qo'shiladi. */
    tgComments: z.number().default(0),
  }),
  adjacent: z.object({
    prev: AdjacentPostSchema,
    next: AdjacentPostSchema,
  }),
  related: z.array(PostListItemSchema),
  telegraphUrl: z.string().nullable().default(null),
});
export type PostDetail = z.infer<typeof PostDetailSchema>;

export const PostFeedItemSchema = z.object({
  slug: z.string(),
  title: z.string(),
  excerpt: z.string().nullable(),
  html: z.string(),
  publishedAt: z.string().nullable(),
  tags: z.array(TagSchema),
});
export type PostFeedItem = z.infer<typeof PostFeedItemSchema>;

export const PostFeedResponseSchema = z.object({
  items: z.array(PostFeedItemSchema),
});
export type PostFeedResponse = z.infer<typeof PostFeedResponseSchema>;

export const RoleSchema = z.union([z.literal("admin"), z.literal("staff"), z.literal("user")]);
export type Role = z.infer<typeof RoleSchema>;

export const MeSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  role: RoleSchema,
});
export type Me = z.infer<typeof MeSchema>;

// ---------------------------------------------------------------------------
// Admin: Posts
// ---------------------------------------------------------------------------

export const AdminPostStatusSchema = z.union([
  z.literal("draft"),
  z.literal("in_review"),
  z.literal("changes_requested"),
  z.literal("scheduled"),
  z.literal("published"),
  z.literal("archived"),
]);
export type AdminPostStatus = z.infer<typeof AdminPostStatusSchema>;

export const AdminPostCountsSchema = z.object({
  views: z.number(),
  likes: z.number(),
  dislikes: z.number(),
  comments: z.number(),
});

export const PostAuthorRefSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
});
export type PostAuthorRef = z.infer<typeof PostAuthorRefSchema>;

export const AdminPostListItemSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  status: AdminPostStatusSchema,
  publishedAt: z.string().nullable(),
  scheduledAt: z.string().nullable(),
  updatedAt: z.string(),
  pinned: z.boolean(),
  counts: AdminPostCountsSchema,
  tags: z.array(TagSchema),
  /** Postni yaratgan xodim/admin — faqat admin panelda ko'rinadi, ochiq saytda hech qachon. */
  createdBy: PostAuthorRefSchema.nullable().default(null),
  /** `changes_requested` holatida admin qoldirgan izoh. */
  reviewNote: z.string().nullable().default(null),
});
export type AdminPostListItem = z.infer<typeof AdminPostListItemSchema>;

export const AdminPostTotalsSchema = z.object({
  all: z.number(),
  draft: z.number(),
  in_review: z.number(),
  changes_requested: z.number(),
  scheduled: z.number(),
  published: z.number(),
  archived: z.number(),
});
export type AdminPostTotals = z.infer<typeof AdminPostTotalsSchema>;

export const AdminPostListResponseSchema = z.object({
  items: z.array(AdminPostListItemSchema),
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  hasMore: z.boolean(),
  totals: AdminPostTotalsSchema,
});
export type AdminPostListResponse = z.infer<typeof AdminPostListResponseSchema>;

export const CreatePostBodySchema = z.object({
  title: z.string().min(1).optional(),
});
export type CreatePostBody = z.infer<typeof CreatePostBodySchema>;

export const CreatePostResponseSchema = z.object({
  id: z.string(),
  slug: z.string(),
});
export type CreatePostResponse = z.infer<typeof CreatePostResponseSchema>;

export const TelegramRefSchema = z.object({
  telegraphUrl: z.string().nullable(),
  telegraphPath: z.string().nullable(),
  channelMessageId: z.number().nullable(),
});
export type TelegramRef = z.infer<typeof TelegramRefSchema>;

export const AdminPostDetailSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  excerpt: z.string().nullable(),
  contentJson: z.unknown(),
  coverUrl: z.string().nullable(),
  status: AdminPostStatusSchema,
  publishedAt: z.string().nullable(),
  scheduledAt: z.string().nullable(),
  pinned: z.boolean(),
  settings: PostSettingsSchema,
  tags: z.array(TagSchema),
  readingTime: z.number().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  counts: AdminPostCountsSchema,
  telegram: TelegramRefSchema.nullable().default(null),
  createdBy: PostAuthorRefSchema.nullable().default(null),
  updatedBy: PostAuthorRefSchema.nullable().default(null),
  reviewNote: z.string().nullable().default(null),
  submittedAt: z.string().nullable().default(null),
  reviewedBy: PostAuthorRefSchema.nullable().default(null),
  reviewedAt: z.string().nullable().default(null),
});
export type AdminPostDetail = z.infer<typeof AdminPostDetailSchema>;

export const UpdatePostBodySchema = z.object({
  title: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  excerpt: z.string().nullable().optional(),
  contentJson: z.unknown().optional(),
  coverUrl: z.string().nullable().optional(),
  tagSlugs: z.array(z.string()).optional(),
  settings: PostSettingsSchema.partial().optional(),
  pinned: z.boolean().optional(),
  scheduledAt: z.string().nullable().optional(),
});
export type UpdatePostBody = z.infer<typeof UpdatePostBodySchema>;

/** Fields a `staff` role account is allowed to touch via `PATCH /admin/posts/:id`. */
export const STAFF_EDITABLE_POST_FIELDS = ["title", "slug", "excerpt", "contentJson", "coverUrl", "tagSlugs"] as const;

export const SubmitPostResponseSchema = z.object({
  id: z.string(),
  status: AdminPostStatusSchema,
  submittedAt: z.string().nullable(),
});
export type SubmitPostResponse = z.infer<typeof SubmitPostResponseSchema>;

export const RequestChangesBodySchema = z.object({
  note: z.string().trim().min(1).max(2000),
});
export type RequestChangesBody = z.infer<typeof RequestChangesBodySchema>;

export const StaffPostsSummarySchema = z.object({
  counts: z.object({
    draft: z.number(),
    in_review: z.number(),
    changes_requested: z.number(),
    published: z.number(),
    archived: z.number(),
  }),
  recent: z.array(AdminPostListItemSchema),
});
export type StaffPostsSummary = z.infer<typeof StaffPostsSummarySchema>;

export const UpdatePostResponseSchema = z.object({
  updatedAt: z.string(),
});
export type UpdatePostResponse = z.infer<typeof UpdatePostResponseSchema>;

export const SchedulePostBodySchema = z.object({
  scheduledAt: z.string(),
});
export type SchedulePostBody = z.infer<typeof SchedulePostBodySchema>;

export const AdminPostPreviewSchema = PostDetailSchema.omit({ publishedAt: true }).extend({
  status: AdminPostStatusSchema,
  publishedAt: z.string().nullable(),
});
export type AdminPostPreview = z.infer<typeof AdminPostPreviewSchema>;

// ---------------------------------------------------------------------------
// Admin: Media
// ---------------------------------------------------------------------------

export const MediaSchema = z.object({
  id: z.string(),
  key: z.string(),
  url: z.string(),
  mime: z.string(),
  size: z.number(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  alt: z.string().nullable(),
  createdAt: z.string(),
});
export type Media = z.infer<typeof MediaSchema>;

export const MediaListResponseSchema = z.object({
  items: z.array(MediaSchema),
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  hasMore: z.boolean(),
});
export type MediaListResponse = z.infer<typeof MediaListResponseSchema>;

// ---------------------------------------------------------------------------
// Admin: Tags
// ---------------------------------------------------------------------------

export const CreateTagBodySchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
});
export type CreateTagBody = z.infer<typeof CreateTagBodySchema>;

export const UpdateTagBodySchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
});
export type UpdateTagBody = z.infer<typeof UpdateTagBodySchema>;

// ---------------------------------------------------------------------------
// Site settings
// ---------------------------------------------------------------------------

export const SocialLinksSchema = z.object({
  telegram: z.string().nullable().default(null),
  github: z.string().nullable().default(null),
  x: z.string().nullable().default(null),
  email: z.string().nullable().default(null),
});
export type SocialLinks = z.infer<typeof SocialLinksSchema>;

export const DEFAULT_SOCIAL_LINKS: SocialLinks = {
  telegram: null,
  github: null,
  x: null,
  email: null,
};

export const AboutContentSchema = z.object({
  json: z.unknown().nullable(),
  html: z.string(),
});
export type AboutContent = z.infer<typeof AboutContentSchema>;

/** Telegram izohlari sahifada qayerda ko'rinishi — admin panelda /admin/sozlamalar orqali boshqariladi. */
export const TelegramDisplayModeSchema = z.union([
  z.literal("admin_only"),
  z.literal("separate"),
  z.literal("mixed"),
]);
export type TelegramDisplayMode = z.infer<typeof TelegramDisplayModeSchema>;

export const TelegramSettingsSchema = z.object({
  notifyComments: z.boolean().default(true),
  digestEnabled: z.boolean().default(false),
  /** Bot aniqlagan muhokama guruhi id'si — faqat o'qish uchun (admin panelda ko'rsatiladi), avtomatik to'ldiriladi. */
  discussionGroupId: z.number().nullable().default(null),
  /** Telegram'dan kelgan izohlar sahifada qanday ko'rsatilishi — standart: faqat admin panelda. */
  telegramDisplay: TelegramDisplayModeSchema.default("admin_only"),
});
export type TelegramSettings = z.infer<typeof TelegramSettingsSchema>;

export const DEFAULT_TELEGRAM_SETTINGS: TelegramSettings = {
  notifyComments: true,
  digestEnabled: false,
  discussionGroupId: null,
  telegramDisplay: "admin_only",
};

export const SiteSettingsAdminSchema = z.object({
  about: AboutContentSchema,
  social: SocialLinksSchema,
  defaultPostSettings: PostSettingsSchema,
  telegram: TelegramSettingsSchema,
});
export type SiteSettingsAdmin = z.infer<typeof SiteSettingsAdminSchema>;

export const UpdateSiteSettingsBodySchema = z.object({
  about: z.object({ json: z.unknown() }).optional(),
  social: SocialLinksSchema.partial().optional(),
  defaultPostSettings: PostSettingsSchema.partial().optional(),
  telegram: TelegramSettingsSchema.partial().optional(),
});
export type UpdateSiteSettingsBody = z.infer<typeof UpdateSiteSettingsBodySchema>;

// ---------------------------------------------------------------------------
// Admin: Telegram (Phase 6)
// ---------------------------------------------------------------------------

export const TelegramStatusSchema = z.union([
  z.object({ configured: z.literal(false) }),
  z.object({
    configured: z.literal(true),
    me: z.object({ id: z.number(), username: z.string().nullable(), firstName: z.string() }).nullable(),
    webhook: z
      .object({
        url: z.string(),
        hasCustomCertificate: z.boolean().optional(),
        pendingUpdateCount: z.number().optional(),
        lastErrorDate: z.number().optional(),
        lastErrorMessage: z.string().optional(),
      })
      .nullable(),
    channel: z.string().nullable(),
    adminChat: z.string().nullable(),
  }),
]);
export type TelegramStatus = z.infer<typeof TelegramStatusSchema>;

export const PublicSiteConfigSchema = z.object({
  siteName: z.string(),
  siteDescription: z.string(),
  turnstileSiteKey: z.string(),
  umamiScriptUrl: z.string(),
  umamiWebsiteId: z.string(),
  githubLoginEnabled: z.boolean(),
  // `githubLoginEnabled` sharhlovchi (commenter) toggle'iga bog'liq — xodimlar
  // uchun "GitHub bilan kirish" tugmasi shu bayroqdan MUSTAQIL, faqat
  // clientId/clientSecret sozlanganiga qarab ko'rsatiladi.
  githubConfigured: z.boolean().default(false),
  // Default — eski API versiyasi bu maydonni qaytarmasa ham web ishlasin (deploy tartibi).
  telegramDisplay: TelegramDisplayModeSchema.default("admin_only"),
});
export type PublicSiteConfig = z.infer<typeof PublicSiteConfigSchema>;

export const PublicSiteSchema = z.object({
  about: z.object({ html: z.string() }),
  social: SocialLinksSchema,
  config: PublicSiteConfigSchema,
});
export type PublicSite = z.infer<typeof PublicSiteSchema>;

// ---------------------------------------------------------------------------
// Admin: Integration settings (Phase 8 — admin-managed, env-or-db precedence)
// ---------------------------------------------------------------------------

export const SettingSourceSchema = z.union([z.literal("env"), z.literal("db"), z.literal("none")]);
export type SettingSource = z.infer<typeof SettingSourceSchema>;

/** Har bir maydon uchun: joriy qiymat (parol bo'lsa maskalangan), qayerdan kelgani va sozlanganmi. */
function adminField<T extends z.ZodTypeAny>(value: T) {
  return z.object({
    value,
    source: SettingSourceSchema,
    isSet: z.boolean(),
    envVar: z.string().nullable(),
  });
}
export interface AdminField<T> {
  value: T;
  source: SettingSource;
  isSet: boolean;
  envVar: string | null;
}

/** Parol maydonlari o'zgarmagan holda qayta yuborilsa (mask ko'rinishi), server buni "o'zgartirmaslik" belgisi deb qabul qiladi. */
export const SECRET_KEEP_PREFIX = "••••";

export const TelegramSettingsAdminSchema = z.object({
  botToken: adminField(z.string()),
  webhookSecret: adminField(z.string()),
  adminChatId: adminField(z.string()),
  adminUserIds: adminField(z.string()),
  channelId: adminField(z.string()),
  apiRoot: adminField(z.string()),
  notifyComments: adminField(z.boolean()),
  digestEnabled: adminField(z.boolean()),
  telegramDisplay: adminField(TelegramDisplayModeSchema),
  /** Faqat o'qish uchun — bot avtomatik aniqlaydi (muhokama guruhida forward xabarini ko'rgach), UI'da patch qilinmaydi. */
  discussionGroupId: z.number().nullable(),
  enabled: z.boolean(),
  disabledReason: z.string().nullable(),
});
export type TelegramSettingsAdmin = z.infer<typeof TelegramSettingsAdminSchema>;

export const TelegraphSettingsAdminSchema = z.object({
  enabled: adminField(z.boolean()),
  accessToken: adminField(z.string()),
});
export type TelegraphSettingsAdmin = z.infer<typeof TelegraphSettingsAdminSchema>;

export const TurnstileSettingsAdminSchema = z.object({
  siteKey: adminField(z.string()),
  secretKey: adminField(z.string()),
  required: adminField(z.boolean()),
});
export type TurnstileSettingsAdmin = z.infer<typeof TurnstileSettingsAdminSchema>;

export const R2SettingsAdminSchema = z.object({
  accountId: adminField(z.string()),
  accessKeyId: adminField(z.string()),
  secretAccessKey: adminField(z.string()),
  bucket: adminField(z.string()),
  publicUrl: adminField(z.string()),
});
export type R2SettingsAdmin = z.infer<typeof R2SettingsAdminSchema>;

export const UmamiSettingsAdminSchema = z.object({
  apiUrl: adminField(z.string()),
  websiteId: adminField(z.string()),
  scriptUrl: adminField(z.string()),
  apiKey: adminField(z.string()),
  username: adminField(z.string()),
  password: adminField(z.string()),
});
export type UmamiSettingsAdmin = z.infer<typeof UmamiSettingsAdminSchema>;

export const GithubSettingsAdminSchema = z.object({
  clientId: adminField(z.string()),
  clientSecret: adminField(z.string()),
  loginEnabled: adminField(z.boolean()),
  restartRequired: z.boolean(),
  callbackUrl: z.string(),
});
export type GithubSettingsAdmin = z.infer<typeof GithubSettingsAdminSchema>;

export const GeneralSettingsAdminSchema = z.object({
  siteName: adminField(z.string()),
  siteDescription: adminField(z.string()),
});
export type GeneralSettingsAdmin = z.infer<typeof GeneralSettingsAdminSchema>;

export const SettingsAdminSchema = z.object({
  telegram: TelegramSettingsAdminSchema,
  telegraph: TelegraphSettingsAdminSchema,
  turnstile: TurnstileSettingsAdminSchema,
  r2: R2SettingsAdminSchema,
  umami: UmamiSettingsAdminSchema,
  github: GithubSettingsAdminSchema,
  general: GeneralSettingsAdminSchema,
});
export type SettingsAdmin = z.infer<typeof SettingsAdminSchema>;

export const TelegramSettingsPatchSchema = z.object({
  botToken: z.string().optional(),
  webhookSecret: z.string().optional(),
  adminChatId: z.string().optional(),
  adminUserIds: z.string().optional(),
  channelId: z.string().optional(),
  apiRoot: z.string().optional(),
  notifyComments: z.boolean().optional(),
  digestEnabled: z.boolean().optional(),
  telegramDisplay: TelegramDisplayModeSchema.optional(),
});
export type TelegramSettingsPatch = z.infer<typeof TelegramSettingsPatchSchema>;

export const TelegraphSettingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  accessToken: z.string().optional(),
});
export type TelegraphSettingsPatch = z.infer<typeof TelegraphSettingsPatchSchema>;

export const TurnstileSettingsPatchSchema = z.object({
  siteKey: z.string().optional(),
  secretKey: z.string().optional(),
  required: z.boolean().optional(),
});
export type TurnstileSettingsPatch = z.infer<typeof TurnstileSettingsPatchSchema>;

export const R2SettingsPatchSchema = z.object({
  accountId: z.string().optional(),
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().optional(),
  bucket: z.string().optional(),
  publicUrl: z.string().optional(),
});
export type R2SettingsPatch = z.infer<typeof R2SettingsPatchSchema>;

export const UmamiSettingsPatchSchema = z.object({
  apiUrl: z.string().optional(),
  websiteId: z.string().optional(),
  scriptUrl: z.string().optional(),
  apiKey: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
});
export type UmamiSettingsPatch = z.infer<typeof UmamiSettingsPatchSchema>;

export const GithubSettingsPatchSchema = z.object({
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  loginEnabled: z.boolean().optional(),
});
export type GithubSettingsPatch = z.infer<typeof GithubSettingsPatchSchema>;

export const GeneralSettingsPatchSchema = z.object({
  siteName: z.string().optional(),
  siteDescription: z.string().optional(),
});
export type GeneralSettingsPatch = z.infer<typeof GeneralSettingsPatchSchema>;

export const SettingsPatchSchema = z.object({
  telegram: TelegramSettingsPatchSchema.optional(),
  telegraph: TelegraphSettingsPatchSchema.optional(),
  turnstile: TurnstileSettingsPatchSchema.optional(),
  r2: R2SettingsPatchSchema.optional(),
  umami: UmamiSettingsPatchSchema.optional(),
  github: GithubSettingsPatchSchema.optional(),
  general: GeneralSettingsPatchSchema.optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export const SettingsSectionSchema = z.union([
  z.literal("telegram"),
  z.literal("telegraph"),
  z.literal("turnstile"),
  z.literal("r2"),
  z.literal("umami"),
  z.literal("github"),
]);
export type SettingsSection = z.infer<typeof SettingsSectionSchema>;

export const SettingsTestResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type SettingsTestResult = z.infer<typeof SettingsTestResultSchema>;

export const GenerateSecretResponseSchema = z.object({ secret: z.string() });
export type GenerateSecretResponse = z.infer<typeof GenerateSecretResponseSchema>;

// ---------------------------------------------------------------------------
// Device identity (Phase 4)
// ---------------------------------------------------------------------------

export const DeviceMeUserSchema = z.object({
  name: z.string().nullable(),
  image: z.string().nullable(),
  role: z.union([z.literal("admin"), z.literal("user")]),
});
export type DeviceMeUser = z.infer<typeof DeviceMeUserSchema>;

export const DeviceMeSchema = z.object({
  device: z.boolean(),
  user: DeviceMeUserSchema.nullable(),
});
export type DeviceMe = z.infer<typeof DeviceMeSchema>;

// ---------------------------------------------------------------------------
// Comments & reactions (Phase 4)
// ---------------------------------------------------------------------------

export const CommentSortSchema = z.union([z.literal("new"), z.literal("top")]);
export type CommentSort = z.infer<typeof CommentSortSchema>;

export const ReactionTypeSchema = z.union([z.literal("like"), z.literal("dislike")]);
export type ReactionType = z.infer<typeof ReactionTypeSchema>;

export const CommentSourceSchema = z.union([z.literal("web"), z.literal("telegram")]);
export type CommentSourceValue = z.infer<typeof CommentSourceSchema>;

export interface CommentNode {
  id: string;
  parentId: string | null;
  depth: number;
  authorName: string;
  authorImage: string | null;
  authorIsAdmin: boolean;
  authorVerified: boolean;
  isMine: boolean;
  editableUntil: string | null;
  body: string;
  bodyHtml: string;
  pending: boolean;
  deleted: boolean;
  createdAt: string;
  editedAt: string | null;
  likes: number;
  dislikes: number;
  replies: CommentNode[];
  /** 'web' — sayt/panel orqali yozilgan; 'telegram' — kanalning muhokama guruhidan olingan. */
  source: CommentSourceValue;
  /** `source === 'telegram'` bo'lsa Telegram username (bo'lsa) — badge uchun. */
  tgUsername: string | null;
}

export const CommentNodeSchema: z.ZodType<CommentNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    parentId: z.string().nullable(),
    depth: z.number(),
    authorName: z.string(),
    authorImage: z.string().nullable(),
    authorIsAdmin: z.boolean(),
    authorVerified: z.boolean(),
    isMine: z.boolean(),
    editableUntil: z.string().nullable(),
    body: z.string(),
    bodyHtml: z.string(),
    pending: z.boolean(),
    deleted: z.boolean(),
    createdAt: z.string(),
    editedAt: z.string().nullable(),
    likes: z.number(),
    dislikes: z.number(),
    replies: z.array(CommentNodeSchema),
    source: CommentSourceSchema,
    tgUsername: z.string().nullable(),
  }),
);

export const CommentsMeSchema = z.object({
  deviceOk: z.boolean(),
  reactions: z.record(z.string(), ReactionTypeSchema),
  postReaction: ReactionTypeSchema.nullable(),
  ownIds: z.array(z.string()),
});
export type CommentsMe = z.infer<typeof CommentsMeSchema>;

export const CommentsListResponseSchema = z.object({
  items: z.array(CommentNodeSchema),
  nextCursor: z.string().nullable(),
  total: z.number(),
  me: CommentsMeSchema,
  /** `comments.telegramDisplay === 'separate'` bo'lsagina to'ldiriladi — Telegram daraxti web daraxtdan alohida. */
  telegram: z.array(CommentNodeSchema).optional(),
  telegramTotal: z.number().optional(),
  /** Telegram muhokama guruhidagi post xabariga to'g'ridan-to'g'ri havola (izohlar ochiladi) — aniqlanmasa `null`. */
  telegramThreadUrl: z.string().nullable().optional(),
});
export type CommentsListResponse = z.infer<typeof CommentsListResponseSchema>;

export const CreateCommentBodySchema = z.object({
  parentId: z.string().nullable().optional(),
  authorName: z.string().trim().min(2).max(40).optional(),
  body: z.string().min(1).max(4000),
  turnstileToken: z.string().optional(),
  website: z.string().optional(),
});
export type CreateCommentBody = z.infer<typeof CreateCommentBodySchema>;

export const CreateCommentResponseSchema = z.object({
  comment: CommentNodeSchema,
});
export type CreateCommentResponse = z.infer<typeof CreateCommentResponseSchema>;

export const UpdateCommentBodySchema = z.object({
  body: z.string().min(1).max(4000),
});
export type UpdateCommentBody = z.infer<typeof UpdateCommentBodySchema>;

export const ReactionBodySchema = z.object({
  type: ReactionTypeSchema.nullable(),
});
export type ReactionBody = z.infer<typeof ReactionBodySchema>;

export const ReactionResponseSchema = z.object({
  likes: z.number(),
  dislikes: z.number(),
  mine: ReactionTypeSchema.nullable(),
});
export type ReactionResponse = z.infer<typeof ReactionResponseSchema>;

export const ReactionMeResponseSchema = z.object({
  mine: ReactionTypeSchema.nullable(),
});
export type ReactionMeResponse = z.infer<typeof ReactionMeResponseSchema>;

// ---------------------------------------------------------------------------
// Admin: comments & bans
// ---------------------------------------------------------------------------

export const AdminCommentStatusSchema = z.union([
  z.literal("visible"),
  z.literal("pending"),
  z.literal("hidden"),
  z.literal("deleted"),
]);
export type AdminCommentStatus = z.infer<typeof AdminCommentStatusSchema>;

export const AdminCommentItemSchema = z.object({
  id: z.string(),
  postId: z.string(),
  postSlug: z.string(),
  postTitle: z.string(),
  parentId: z.string().nullable(),
  authorName: z.string(),
  authorUserId: z.string().nullable(),
  authorIsAdmin: z.boolean(),
  authorImage: z.string().nullable(),
  body: z.string(),
  bodyHtml: z.string(),
  status: AdminCommentStatusSchema,
  likes: z.number(),
  dislikes: z.number(),
  ipHashShort: z.string().nullable(),
  createdAt: z.string(),
  editedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  source: CommentSourceSchema,
  tgUsername: z.string().nullable(),
  /** Telegram guruhidagi ushbu izoh xabariga ochish havolasi ("Telegram'da ochish") — faqat `source==='telegram'` va aniqlansa. */
  tgThreadUrl: z.string().nullable(),
});
export type AdminCommentItem = z.infer<typeof AdminCommentItemSchema>;

export const AdminCommentCountsSchema = z.object({
  all: z.number(),
  pending: z.number(),
  visible: z.number(),
  hidden: z.number(),
  deleted: z.number(),
});
export type AdminCommentCounts = z.infer<typeof AdminCommentCountsSchema>;

export const AdminCommentSourceCountsSchema = z.object({
  all: z.number(),
  web: z.number(),
  telegram: z.number(),
});
export type AdminCommentSourceCounts = z.infer<typeof AdminCommentSourceCountsSchema>;

export const AdminCommentSourceFilterSchema = z.union([
  z.literal("all"),
  z.literal("web"),
  z.literal("telegram"),
]);
export type AdminCommentSourceFilter = z.infer<typeof AdminCommentSourceFilterSchema>;

export const AdminCommentListResponseSchema = z.object({
  items: z.array(AdminCommentItemSchema),
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  hasMore: z.boolean(),
  counts: AdminCommentCountsSchema,
  sourceCounts: AdminCommentSourceCountsSchema,
});
export type AdminCommentListResponse = z.infer<typeof AdminCommentListResponseSchema>;

export const AdminCommentUpdateBodySchema = z.object({
  status: z.union([z.literal("visible"), z.literal("hidden"), z.literal("deleted")]),
});
export type AdminCommentUpdateBody = z.infer<typeof AdminCommentUpdateBodySchema>;

export const AdminCommentBulkBodySchema = z.object({
  ids: z.array(z.string()).min(1),
  status: z.union([z.literal("visible"), z.literal("hidden"), z.literal("deleted")]),
});
export type AdminCommentBulkBody = z.infer<typeof AdminCommentBulkBodySchema>;

export const AdminCommentReplyBodySchema = z.object({
  body: z.string().min(1).max(4000),
});
export type AdminCommentReplyBody = z.infer<typeof AdminCommentReplyBodySchema>;

export const AdminCommentBanBodySchema = z.object({
  reason: z.string().max(500).optional(),
});
export type AdminCommentBanBody = z.infer<typeof AdminCommentBanBodySchema>;

export const BannedDeviceSchema = z.object({
  id: z.string(),
  deviceHash: z.string().nullable(),
  ipHash: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: z.string(),
});
export type BannedDevice = z.infer<typeof BannedDeviceSchema>;

export const BansListResponseSchema = z.object({
  items: z.array(BannedDeviceSchema),
});
export type BansListResponse = z.infer<typeof BansListResponseSchema>;

// ---------------------------------------------------------------------------
// View counting & public stats (Phase 5)
// ---------------------------------------------------------------------------

/** `POST /posts/:slug/view` javobi — `counted` shu so'rov yangi ko'rish sifatida hisoblanganini bildiradi. */
export const PostViewResponseSchema = z.object({
  counted: z.boolean(),
  views: z.number(),
});
export type PostViewResponse = z.infer<typeof PostViewResponseSchema>;

/** `GET /posts/:slug/stats` — client-side meta qator uchun DB'dan yangi hisoblar. */
export const PostStatsSchema = z.object({
  views: z.number(),
  likes: z.number(),
  dislikes: z.number(),
  comments: z.number(),
  tgComments: z.number().default(0),
});
export type PostStats = z.infer<typeof PostStatsSchema>;

// ---------------------------------------------------------------------------
// Admin: statistika (Phase 5)
// ---------------------------------------------------------------------------

export const StatsRangeSchema = z.union([
  z.literal("7d"),
  z.literal("30d"),
  z.literal("90d"),
  z.literal("all"),
]);
export type StatsRange = z.infer<typeof StatsRangeSchema>;

export const StatsTotalsSchema = z.object({
  views: z.number(),
  likes: z.number(),
  dislikes: z.number(),
  comments: z.number(),
});
export type StatsTotals = z.infer<typeof StatsTotalsSchema>;

export const StatsSeriesPointSchema = z.object({
  day: z.string(),
  views: z.number(),
  likes: z.number(),
  dislikes: z.number(),
  comments: z.number(),
});
export type StatsSeriesPoint = z.infer<typeof StatsSeriesPointSchema>;

export const StatsTopPostSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  views: z.number(),
  likes: z.number(),
  dislikes: z.number(),
  comments: z.number(),
});
export type StatsTopPost = z.infer<typeof StatsTopPostSchema>;

export const StatsRecentCommentSchema = z.object({
  id: z.string(),
  postId: z.string(),
  postSlug: z.string(),
  postTitle: z.string(),
  authorName: z.string(),
  body: z.string(),
  status: AdminCommentStatusSchema,
  createdAt: z.string(),
  source: CommentSourceSchema,
});
export type StatsRecentComment = z.infer<typeof StatsRecentCommentSchema>;

export const AdminStatsOverviewSchema = z.object({
  range: StatsRangeSchema,
  totals: StatsTotalsSchema.extend({ publishedPosts: z.number() }),
  previousTotals: StatsTotalsSchema.nullable(),
  series: z.array(StatsSeriesPointSchema),
  topPosts: z.array(StatsTopPostSchema),
  recentComments: z.array(StatsRecentCommentSchema),
  pendingComments: z.number(),
});
export type AdminStatsOverview = z.infer<typeof AdminStatsOverviewSchema>;

export const AdminPostStatsSchema = z.object({
  range: StatsRangeSchema,
  post: z.object({
    id: z.string(),
    slug: z.string(),
    title: z.string(),
    status: AdminPostStatusSchema,
  }),
  totals: StatsTotalsSchema,
  previousTotals: StatsTotalsSchema.nullable(),
  series: z.array(StatsSeriesPointSchema),
  allTime: StatsTotalsSchema,
  reactionsSplit: z.object({ likes: z.number(), dislikes: z.number() }),
  recentComments: z.array(StatsRecentCommentSchema),
});
export type AdminPostStats = z.infer<typeof AdminPostStatsSchema>;

export const AdminStatsSummarySchema = z.object({
  today: z.object({ views: z.number() }),
  last7d: StatsTotalsSchema,
  last30d: StatsTotalsSchema,
  pendingComments: z.number(),
  topPosts: z.array(z.object({ slug: z.string(), title: z.string(), views: z.number() })),
});
export type AdminStatsSummary = z.infer<typeof AdminStatsSummarySchema>;

// ---------------------------------------------------------------------------
// Admin: Umami proxy (Phase 5)
// ---------------------------------------------------------------------------

export const UmamiStatsSchema = z.object({
  pageviews: z.number(),
  visitors: z.number(),
  visits: z.number(),
  bounces: z.number(),
  totaltime: z.number(),
});
export type UmamiStats = z.infer<typeof UmamiStatsSchema>;

export const UmamiSeriesPointSchema = z.object({ t: z.string(), y: z.number() });
export type UmamiSeriesPoint = z.infer<typeof UmamiSeriesPointSchema>;

export const UmamiMetricRowSchema = z.object({ label: z.string(), count: z.number() });
export type UmamiMetricRow = z.infer<typeof UmamiMetricRowSchema>;

export const AdminUmamiStatsSchema = z.union([
  z.object({ configured: z.literal(false) }),
  z.object({
    configured: z.literal(true),
    error: z.string().optional(),
    stats: UmamiStatsSchema.optional(),
    previous: UmamiStatsSchema.optional(),
    pageviewsSeries: z.array(UmamiSeriesPointSchema).optional(),
    referrers: z.array(UmamiMetricRowSchema).optional(),
    countries: z.array(UmamiMetricRowSchema).optional(),
    browsers: z.array(UmamiMetricRowSchema).optional(),
    devices: z.array(UmamiMetricRowSchema).optional(),
    pages: z.array(UmamiMetricRowSchema).optional(),
  }),
]);
export type AdminUmamiStats = z.infer<typeof AdminUmamiStatsSchema>;

// ---------------------------------------------------------------------------
// Admin: Xodimlar (staff) & taklif (invite) — helper-staff review workflow
// ---------------------------------------------------------------------------

export const StaffMemberSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string(),
  image: z.string().nullable(),
  addedAt: z.string(),
  postsCount: z.number(),
});
export type StaffMember = z.infer<typeof StaffMemberSchema>;

export const StaffInviteStatusSchema = z.union([
  z.literal("active"),
  z.literal("used"),
  z.literal("expired"),
  z.literal("revoked"),
]);
export type StaffInviteStatus = z.infer<typeof StaffInviteStatusSchema>;

export const StaffInviteSchema = z.object({
  id: z.string(),
  note: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  usedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  status: StaffInviteStatusSchema,
});
export type StaffInvite = z.infer<typeof StaffInviteSchema>;

export const StaffListResponseSchema = z.object({
  staff: z.array(StaffMemberSchema),
  invites: z.array(StaffInviteSchema),
});
export type StaffListResponse = z.infer<typeof StaffListResponseSchema>;

export const CreateStaffInviteBodySchema = z.object({
  note: z.string().trim().max(200).optional(),
});
export type CreateStaffInviteBody = z.infer<typeof CreateStaffInviteBodySchema>;

/** `token` faqat SHU javobda bir marta qaytadi — keyinroq hech qayerdan qayta o'qib bo'lmaydi. */
export const CreateStaffInviteResponseSchema = z.object({
  invite: StaffInviteSchema,
  token: z.string(),
  url: z.string(),
});
export type CreateStaffInviteResponse = z.infer<typeof CreateStaffInviteResponseSchema>;

export const StaffInvitePublicStatusSchema = z.union([
  z.literal("valid"),
  z.literal("expired"),
  z.literal("used"),
  z.literal("revoked"),
  z.literal("not_found"),
]);
export type StaffInvitePublicStatus = z.infer<typeof StaffInvitePublicStatusSchema>;

/** `GET /staff/invites/:token` — token'ning o'zi ekspozitsiya qilinmaydi, faqat holat + note. */
export const StaffInvitePublicSchema = z.object({
  status: StaffInvitePublicStatusSchema,
  note: z.string().nullable(),
});
export type StaffInvitePublic = z.infer<typeof StaffInvitePublicSchema>;

export const AcceptStaffInviteResponseSchema = z.object({
  ok: z.literal(true),
  role: RoleSchema,
});
export type AcceptStaffInviteResponse = z.infer<typeof AcceptStaffInviteResponseSchema>;
