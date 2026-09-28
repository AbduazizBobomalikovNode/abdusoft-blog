import {
  AdminCommentListResponseSchema,
  AdminPostDetailSchema,
  AdminPostListResponseSchema,
  AdminPostPreviewSchema,
  AdminPostStatsSchema,
  AdminStatsOverviewSchema,
  AdminStatsSummarySchema,
  AdminUmamiStatsSchema,
  BansListResponseSchema,
  MeSchema,
  MediaListResponseSchema,
  PostDetailSchema,
  PostFeedResponseSchema,
  PostListResponseSchema,
  PostStatsSchema,
  PublicSiteSchema,
  SettingsAdminSchema,
  SiteSettingsAdminSchema,
  TagWithCountSchema,
  TelegramStatusSchema,
  type AdminCommentListResponse,
  type AdminPostDetail,
  type AdminPostListResponse,
  type AdminPostPreview,
  type AdminPostStats,
  type AdminStatsOverview,
  type AdminStatsSummary,
  type AdminUmamiStats,
  type BansListResponse,
  type Me,
  type MediaListResponse,
  type PostDetail,
  type PostFeedResponse,
  type PostListResponse,
  type PostStats,
  type PublicSite,
  type SettingsAdmin,
  type SiteSettingsAdmin,
  type StatsRange,
  type TagWithCount,
  type TelegramStatus,
} from "@blog/shared";
import { z } from "zod";
import { site } from "./site";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface ApiFetchOptions extends RequestInit {
  /** Next.js data cache hints, forwarded to fetch() as-is. */
  next?: NextFetchRequestConfig;
}

/**
 * API server ishlamay qolgan holatlarda (masalan, build paytida yoki VDS
 * vaqtincha ishlamay qolganda) sahifa qulab tushmasligi uchun tarmoq xatosini
 * 503 status sifatida "yumshoq" qaytaramiz — chaqiruvchi null natija oladi.
 */
async function apiFetch(path: string, options: ApiFetchOptions = {}): Promise<Response> {
  let res: Response;

  try {
    res = await fetch(`${site.apiUrl}${path}`, {
      ...options,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...options.headers,
      },
    });
  } catch {
    return new Response(null, { status: 503, statusText: "API unreachable" });
  }

  if (!res.ok && res.status !== 401 && res.status !== 404 && res.status !== 503) {
    throw new ApiError(res.status, `API xatosi: ${path} -> ${res.status}`);
  }

  return res;
}

async function parseJson<T>(res: Response, schema: z.ZodType<T>): Promise<T | null> {
  if (!res.ok) return null;
  const data: unknown = await res.json();
  return schema.parse(data);
}

export async function getPosts(params: {
  tag?: string;
  q?: string;
  page?: number;
  limit?: number;
}): Promise<PostListResponse | null> {
  const search = new URLSearchParams();
  if (params.tag) search.set("tag", params.tag);
  if (params.q) search.set("q", params.q);
  if (params.page) search.set("page", String(params.page));
  if (params.limit) search.set("limit", String(params.limit));

  const res = await apiFetch(`/posts?${search.toString()}`, {
    next: { revalidate: 60 },
  });

  return parseJson(res, PostListResponseSchema);
}

export async function getPost(slug: string): Promise<PostDetail | null> {
  const res = await apiFetch(`/posts/${encodeURIComponent(slug)}`, {
    next: { revalidate: 300 },
  });

  return parseJson(res, PostDetailSchema);
}

export async function getTags(): Promise<TagWithCount[]> {
  const res = await apiFetch("/tags", { next: { revalidate: 300 } });
  const data = await parseJson(res, z.array(TagWithCountSchema));
  return data ?? [];
}

export async function getFeed(): Promise<PostFeedResponse> {
  const res = await apiFetch("/posts/feed", { next: { revalidate: 300 } });
  const data = await parseJson(res, PostFeedResponseSchema);
  return data ?? { items: [] };
}

/**
 * Server-side only: forward the incoming request's cookies to the API.
 * 403 (tizimga kirilgan, lekin admin emas — masalan GitHub bilan kirgan oddiy
 * izohlovchi) ham `401` kabi "yumshoq" — `null` qaytariladi, chaqiruvchi
 * (`admin/layout.tsx`) login sahifasiga yo'naltiradi. Boshqa `apiFetch`
 * chaqiruvlarining xatti-harakati o'zgarmaydi.
 */
export async function getMe(cookieHeader: string | null): Promise<Me | null> {
  try {
    const res = await apiFetch("/admin/me", {
      cache: "no-store",
      headers: cookieHeader ? { cookie: cookieHeader } : undefined,
    });

    return await parseJson(res, MeSchema);
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Admin (server-side reads) — barchasi cookie forward qiladi va cache qilmaydi.
// ---------------------------------------------------------------------------

function authHeaders(cookieHeader: string | null): HeadersInit | undefined {
  return cookieHeader ? { cookie: cookieHeader } : undefined;
}

export async function getAdminPosts(
  params: { status?: string; q?: string; page?: number; limit?: number },
  cookieHeader: string | null,
): Promise<AdminPostListResponse | null> {
  const search = new URLSearchParams();
  if (params.status) search.set("status", params.status);
  if (params.q) search.set("q", params.q);
  if (params.page) search.set("page", String(params.page));
  if (params.limit) search.set("limit", String(params.limit));

  const res = await apiFetch(`/admin/posts?${search.toString()}`, {
    cache: "no-store",
    headers: authHeaders(cookieHeader),
  });

  return parseJson(res, AdminPostListResponseSchema);
}

export async function getAdminPost(
  id: string,
  cookieHeader: string | null,
): Promise<AdminPostDetail | null> {
  const res = await apiFetch(`/admin/posts/${encodeURIComponent(id)}`, {
    cache: "no-store",
    headers: authHeaders(cookieHeader),
  });

  return parseJson(res, AdminPostDetailSchema);
}

export async function getAdminPostPreview(
  id: string,
  cookieHeader: string | null,
): Promise<AdminPostPreview | null> {
  const res = await apiFetch(`/admin/posts/${encodeURIComponent(id)}/preview`, {
    cache: "no-store",
    headers: authHeaders(cookieHeader),
  });

  return parseJson(res, AdminPostPreviewSchema);
}

export async function getAdminMedia(
  params: { page?: number; limit?: number },
  cookieHeader: string | null,
): Promise<MediaListResponse | null> {
  const search = new URLSearchParams();
  if (params.page) search.set("page", String(params.page));
  if (params.limit) search.set("limit", String(params.limit));

  const res = await apiFetch(`/admin/media?${search.toString()}`, {
    cache: "no-store",
    headers: authHeaders(cookieHeader),
  });

  return parseJson(res, MediaListResponseSchema);
}

export async function getAdminTags(cookieHeader: string | null): Promise<TagWithCount[]> {
  const res = await apiFetch("/admin/tags", {
    cache: "no-store",
    headers: authHeaders(cookieHeader),
  });

  const data = await parseJson(res, z.array(TagWithCountSchema));
  return data ?? [];
}

export async function getAdminSiteSettings(
  cookieHeader: string | null,
): Promise<SiteSettingsAdmin | null> {
  const res = await apiFetch("/admin/site", {
    cache: "no-store",
    headers: authHeaders(cookieHeader),
  });

  return parseJson(res, SiteSettingsAdminSchema);
}

/** Integratsiya sozlamalari (Telegram/Telegraph/Turnstile/R2/Umami/GitHub/Umumiy) — maskalangan + manba ma'lumotlari bilan. */
export async function getAdminSettings(cookieHeader: string | null): Promise<SettingsAdmin | null> {
  const res = await apiFetch("/admin/settings", {
    cache: "no-store",
    headers: authHeaders(cookieHeader),
  });

  return parseJson(res, SettingsAdminSchema);
}

/** `(site)` layout har so'rovda shu funksiyani chaqiradi (`revalidate: 60`) — runtime Turnstile/Umami/GitHub-login sozlamalari shu yerdan keladi. */
export async function getSite(): Promise<PublicSite | null> {
  const res = await apiFetch("/site", { next: { revalidate: 60 } });
  return parseJson(res, PublicSiteSchema);
}

/** Post sahifasidagi meta qator uchun — client-side chaqiriladi, shuning uchun cache qilinmaydi. */
export async function getPostStats(slug: string): Promise<PostStats | null> {
  const res = await apiFetch(`/posts/${encodeURIComponent(slug)}/stats`, { cache: "no-store" });
  return parseJson(res, PostStatsSchema);
}

export async function getAdminComments(
  params: { status?: string; postId?: string; q?: string; page?: number; limit?: number },
  cookieHeader: string | null,
): Promise<AdminCommentListResponse | null> {
  const search = new URLSearchParams();
  if (params.status) search.set("status", params.status);
  if (params.postId) search.set("postId", params.postId);
  if (params.q) search.set("q", params.q);
  if (params.page) search.set("page", String(params.page));
  if (params.limit) search.set("limit", String(params.limit));

  const res = await apiFetch(`/admin/comments?${search.toString()}`, {
    cache: "no-store",
    headers: authHeaders(cookieHeader),
  });

  return parseJson(res, AdminCommentListResponseSchema);
}

/** Admin sidebar'dagi "Fikrlar" belgisi uchun — faqat `pending` sonini o'qiydi. */
export async function getAdminCommentPendingCount(cookieHeader: string | null): Promise<number> {
  const res = await apiFetch("/admin/comments?status=pending&limit=1", {
    cache: "no-store",
    headers: authHeaders(cookieHeader),
  });

  const data = await parseJson(res, AdminCommentListResponseSchema);
  return data?.counts.pending ?? 0;
}

export async function getAdminBans(cookieHeader: string | null): Promise<BansListResponse | null> {
  const res = await apiFetch("/admin/bans", {
    cache: "no-store",
    headers: authHeaders(cookieHeader),
  });

  return parseJson(res, BansListResponseSchema);
}

export async function getAdminStatsOverview(
  range: StatsRange,
  cookieHeader: string | null,
): Promise<AdminStatsOverview | null> {
  const res = await apiFetch(`/admin/stats/overview?range=${range}`, {
    cache: "no-store",
    headers: authHeaders(cookieHeader),
  });

  return parseJson(res, AdminStatsOverviewSchema);
}

export async function getAdminPostStats(
  id: string,
  range: StatsRange,
  cookieHeader: string | null,
): Promise<AdminPostStats | null> {
  const res = await apiFetch(`/admin/stats/posts/${encodeURIComponent(id)}?range=${range}`, {
    cache: "no-store",
    headers: authHeaders(cookieHeader),
  });

  return parseJson(res, AdminPostStatsSchema);
}

export async function getAdminStatsSummary(cookieHeader: string | null): Promise<AdminStatsSummary | null> {
  const res = await apiFetch("/admin/stats/summary", {
    cache: "no-store",
    headers: authHeaders(cookieHeader),
  });

  return parseJson(res, AdminStatsSummarySchema);
}

export async function getAdminTelegramStatus(cookieHeader: string | null): Promise<TelegramStatus | null> {
  const res = await apiFetch("/admin/telegram/status", {
    cache: "no-store",
    headers: authHeaders(cookieHeader),
  });

  return parseJson(res, TelegramStatusSchema);
}

export async function getAdminUmamiStats(
  range: StatsRange,
  cookieHeader: string | null,
): Promise<AdminUmamiStats | null> {
  const res = await apiFetch(`/admin/stats/umami?range=${range}`, {
    cache: "no-store",
    headers: authHeaders(cookieHeader),
  });

  return parseJson(res, AdminUmamiStatsSchema);
}

/** Server-side draft yaratish — `/admin/postlar/yangi` sahifasidan chaqiriladi. */
export async function createAdminPostServer(
  cookieHeader: string | null,
): Promise<{ id: string; slug: string } | null> {
  const res = await apiFetch("/admin/posts", {
    method: "POST",
    cache: "no-store",
    headers: {
      "content-type": "application/json",
      ...authHeaders(cookieHeader),
    },
    body: JSON.stringify({}),
  });

  return parseJson(res, z.object({ id: z.string(), slug: z.string() }));
}
