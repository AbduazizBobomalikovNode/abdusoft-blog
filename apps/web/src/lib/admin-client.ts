"use client";

import type {
  AcceptStaffInviteResponse,
  AdminCommentListResponse,
  AdminPostDetail,
  BansListResponse,
  ChannelMode,
  ChannelPlan,
  ChannelPreflightResponse,
  ChannelPreviewResponse,
  ChannelSelection,
  ChannelSendResponse,
  ChannelVariant,
  ChannelVersion,
  ChannelVersionsResponse,
  ChannelChoice,
  CreateChannelVersionBody,
  PublishChannelSendResult,
  ResolvedChannelChoice,
  UpdateChannelVersionBody,
  CreatePostResponse,
  CreateStaffInviteResponse,
  CreateTagBody,
  GenerateSecretResponse,
  Media,
  MediaListResponse,
  SettingsAdmin,
  SettingsPatch,
  SettingsSection,
  SettingsTestResult,
  SiteSettingsAdmin,
  SubmitPostResponse,
  TagWithCount,
  TelegramStatus,
  UpdatePostBody,
  UpdatePostResponse,
  UpdateSiteSettingsBody,
  UpdateTagBody,
} from "@blog/shared";
import { site } from "./site";

export class AdminApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** `PUT /admin/settings` validatsiya xatosi bo'lsa — `{"telegram.webhookSecret": "..."}` ko'rinishida. */
    public fields?: Record<string, string>,
    /** 422 (Telegram cheklovlari) javobida — tekshiruv hisoboti. */
    public preflight?: ChannelPreflightResponse,
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

interface LifecycleSummary {
  id: string;
  slug: string;
  status: "draft" | "scheduled" | "published" | "archived";
  publishedAt: string | null;
  scheduledAt: string | null;
  pinned: boolean;
  updatedAt: string;
  /** Faqat `sendToChannel: true` so'ralganda — belgilangan versiyani kanalga yuborish natijasi. */
  channelSend?: PublishChannelSendResult;
}

async function adminJson<T>(path: string, options: RequestInit = {}): Promise<T> {
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
    throw new AdminApiError(0, "Serverga ulanib bo'lmadi. Internetni tekshiring.");
  }

  const data: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    const baseMessage =
      data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : `Xatolik yuz berdi (${res.status})`;
    // 400 javoblarida `issues` (zod xato ro'yxati) bo'lsa — xabarga qo'shib
    // qo'yamiz, shunda avtosaqlash xatosi ("Xato: ...") qaysi maydon va nega
    // rad etilganini aniq ko'rsatadi (masalan "slug: Kamida 1 ta belgi").
    const issues =
      data && typeof data === "object" && "issues" in data && Array.isArray(data.issues) ? data.issues : undefined;
    const issuesText = issues
      ?.map((issue) => {
        const path =
          issue && typeof issue === "object" && "path" in issue && Array.isArray(issue.path)
            ? issue.path.join(".")
            : "";
        const msg = issue && typeof issue === "object" && "message" in issue ? String(issue.message) : "";
        return path ? `${path}: ${msg}` : msg;
      })
      .filter(Boolean)
      .join("; ");
    const message = issuesText ? `${baseMessage} (${issuesText})` : baseMessage;
    const fields =
      data && typeof data === "object" && "fields" in data && data.fields && typeof data.fields === "object"
        ? (data.fields as Record<string, string>)
        : undefined;
    const preflight =
      data && typeof data === "object" && "preflight" in data && data.preflight && typeof data.preflight === "object"
        ? (data.preflight as ChannelPreflightResponse)
        : undefined;
    throw new AdminApiError(res.status, message, fields, preflight);
  }

  return data as T;
}

function jsonBody(body: unknown): RequestInit {
  return { headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export const adminApi = {
  createPost: (title?: string) =>
    adminJson<CreatePostResponse>("/admin/posts", { method: "POST", ...jsonBody({ title }) }),

  updatePost: (id: string, body: UpdatePostBody) =>
    adminJson<UpdatePostResponse>(`/admin/posts/${id}`, { method: "PATCH", ...jsonBody(body) }),

  publishPost: (id: string, opts?: { sendToChannel?: boolean }) =>
    adminJson<LifecycleSummary>(
      `/admin/posts/${id}/publish`,
      opts?.sendToChannel ? { method: "POST", ...jsonBody({ sendToChannel: true }) } : { method: "POST" },
    ),

  unpublishPost: (id: string) =>
    adminJson<LifecycleSummary>(`/admin/posts/${id}/unpublish`, { method: "POST" }),

  archivePost: (id: string) =>
    adminJson<LifecycleSummary>(`/admin/posts/${id}/archive`, { method: "POST" }),

  schedulePost: (id: string, scheduledAt: string, channelPlan?: ChannelPlan | null) =>
    adminJson<LifecycleSummary>(`/admin/posts/${id}/schedule`, {
      method: "POST",
      ...jsonBody({ scheduledAt, channelPlan: channelPlan ?? null }),
    }),

  deletePost: (id: string) => adminJson<{ ok: true }>(`/admin/posts/${id}`, { method: "DELETE" }),

  getPost: (id: string) => adminJson<AdminPostDetail>(`/admin/posts/${id}`),

  listMedia: (params: { page?: number; limit?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.page) search.set("page", String(params.page));
    if (params.limit) search.set("limit", String(params.limit));
    return adminJson<MediaListResponse>(`/admin/media?${search.toString()}`);
  },

  uploadMedia: (file: File, alt?: string) => {
    const formData = new FormData();
    formData.append("file", file);
    if (alt) formData.append("alt", alt);
    return adminJson<Media>("/admin/media", { method: "POST", body: formData });
  },

  /** `uploadMedia` bilan bir xil, lekin yuklash jarayoni (0–100) haqida xabar beradi (XHR). */
  uploadMediaWithProgress: (file: File, onProgress?: (percent: number) => void) =>
    new Promise<Media>((resolve, reject) => {
      const formData = new FormData();
      formData.append("file", file);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${site.apiUrl}/admin/media`);
      xhr.withCredentials = true;
      xhr.setRequestHeader("Accept", "application/json");
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) onProgress(Math.round((event.loaded / event.total) * 100));
      };
      xhr.onerror = () => reject(new AdminApiError(0, "Serverga ulanib bo'lmadi. Internetni tekshiring."));
      xhr.onload = () => {
        let data: unknown = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          data = null;
        }
        if (xhr.status >= 200 && xhr.status < 300 && data) {
          resolve(data as Media);
          return;
        }
        const message =
          data && typeof data === "object" && "error" in data && typeof data.error === "string"
            ? data.error
            : `Xatolik yuz berdi (${xhr.status})`;
        reject(new AdminApiError(xhr.status, message));
      };
      xhr.send(formData);
    }),

  updateMediaAlt: (id: string, alt: string | null) =>
    adminJson<Media>(`/admin/media/${id}`, { method: "PATCH", ...jsonBody({ alt }) }),

  deleteMedia: (id: string) => adminJson<{ ok: true }>(`/admin/media/${id}`, { method: "DELETE" }),

  createTag: (body: CreateTagBody) =>
    adminJson<TagWithCount>("/admin/tags", { method: "POST", ...jsonBody(body) }),

  updateTag: (id: string, body: UpdateTagBody) =>
    adminJson<TagWithCount>(`/admin/tags/${id}`, { method: "PATCH", ...jsonBody(body) }),

  deleteTag: (id: string, force?: boolean) =>
    adminJson<{ ok: true }>(`/admin/tags/${id}${force ? "?force=1" : ""}`, { method: "DELETE" }),

  updateSiteSettings: (body: UpdateSiteSettingsBody) =>
    adminJson<SiteSettingsAdmin>("/admin/site", { method: "PUT", ...jsonBody(body) }),

  getSettings: () => adminJson<SettingsAdmin>("/admin/settings"),

  updateSettings: (patch: SettingsPatch) =>
    adminJson<SettingsAdmin>("/admin/settings", { method: "PUT", ...jsonBody(patch) }),

  generateSettingsSecret: () => adminJson<GenerateSecretResponse>("/admin/settings/generate-secret", { method: "POST" }),

  testSettingsSection: (section: SettingsSection) =>
    adminJson<SettingsTestResult>(`/admin/settings/test/${section}`, { method: "POST" }),

  listComments: (
    params: { status?: string; postId?: string; q?: string; page?: number; limit?: number } = {},
  ) => {
    const search = new URLSearchParams();
    if (params.status) search.set("status", params.status);
    if (params.postId) search.set("postId", params.postId);
    if (params.q) search.set("q", params.q);
    if (params.page) search.set("page", String(params.page));
    if (params.limit) search.set("limit", String(params.limit));
    return adminJson<AdminCommentListResponse>(`/admin/comments?${search.toString()}`);
  },

  updateCommentStatus: (id: string, status: "visible" | "hidden" | "deleted") =>
    adminJson<{ ok: true }>(`/admin/comments/${id}`, { method: "PATCH", ...jsonBody({ status }) }),

  bulkUpdateComments: (ids: string[], status: "visible" | "hidden" | "deleted") =>
    adminJson<{ ok: true; updated: number }>("/admin/comments/bulk", {
      method: "POST",
      ...jsonBody({ ids, status }),
    }),

  replyToComment: (id: string, body: string) =>
    adminJson<{ id: string }>(`/admin/comments/${id}/reply`, { method: "POST", ...jsonBody({ body }) }),

  sendCommentToTelegram: (id: string) =>
    adminJson<{ ok: true; id: string }>(`/admin/comments/${id}/send-to-telegram`, { method: "POST" }),

  deleteComment: (id: string) =>
    adminJson<{ ok: true }>(`/admin/comments/${id}`, { method: "DELETE" }),

  banCommentDevice: (id: string, reason?: string) =>
    adminJson<{ ok: true }>(`/admin/comments/${id}/ban`, { method: "POST", ...jsonBody({ reason }) }),

  listBans: () => adminJson<BansListResponse>("/admin/bans"),

  unban: (id: string) => adminJson<{ ok: true }>(`/admin/bans/${id}`, { method: "DELETE" }),

  getTelegramStatus: () => adminJson<TelegramStatus>("/admin/telegram/status"),

  sendTelegramTest: () => adminJson<{ ok: true }>("/admin/telegram/test", { method: "POST" }),

  refreshTelegraph: (postId: string) =>
    adminJson<{ telegraphUrl: string | null }>(`/admin/posts/${postId}/telegram/telegraph`, { method: "POST" }),

  /** Eski imzo (`mode, variant`) ham, yangi (`{ versionId }` yoki `{ mode, variant }`) ham ishlaydi. */
  channelPreview: (postId: string, selectionOrMode: ChannelSelection | ChannelMode, variant?: ChannelVariant) =>
    adminJson<ChannelPreviewResponse>(`/admin/posts/${postId}/channel/preview`, {
      method: "POST",
      ...jsonBody(typeof selectionOrMode === "string" ? { mode: selectionOrMode, variant } : selectionOrMode),
    }),

  /** `forPlan: true` — rejalashtirish tekshiruvi (post chop etilgan bo'lishi shart emas). */
  channelPreflight: (postId: string, selection: ChannelSelection, forPlan?: boolean) =>
    adminJson<ChannelPreflightResponse>(`/admin/posts/${postId}/channel/preflight`, {
      method: "POST",
      ...jsonBody(forPlan ? { ...selection, forPlan: true } : selection),
    }),

  channelSend: (postId: string, selection: ChannelSelection, replaceExisting?: boolean) =>
    adminJson<ChannelSendResponse>(`/admin/posts/${postId}/channel/send`, {
      method: "POST",
      ...jsonBody({ ...selection, replaceExisting }),
    }),

  listChannelVersions: (postId: string) =>
    adminJson<ChannelVersionsResponse>(`/admin/posts/${postId}/channel/versions`),

  createChannelVersion: (postId: string, body: CreateChannelVersionBody) =>
    adminJson<ChannelVersion>(`/admin/posts/${postId}/channel/versions`, { method: "POST", ...jsonBody(body) }),

  updateChannelVersion: (postId: string, versionId: string, body: UpdateChannelVersionBody) =>
    adminJson<ChannelVersion>(`/admin/posts/${postId}/channel/versions/${versionId}`, {
      method: "PATCH",
      ...jsonBody(body),
    }),

  deleteChannelVersion: (postId: string, versionId: string) =>
    adminJson<{ ok: true; clearedChoice: boolean }>(`/admin/posts/${postId}/channel/versions/${versionId}`, { method: "DELETE" }),

  /** Postning bitta belgilangan (asosiy) kanal versiyasini o'rnatadi (xodim uchun — taklif). */
  setChannelChoice: (postId: string, choice: ChannelChoice) =>
    adminJson<{ choice: ResolvedChannelChoice | null }>(`/admin/posts/${postId}/channel/choice`, {
      method: "PUT",
      ...jsonBody(choice),
    }),

  clearChannelChoice: (postId: string) =>
    adminJson<{ ok: true }>(`/admin/posts/${postId}/channel/choice`, { method: "DELETE" }),

  channelResyncCaption: (postId: string) =>
    adminJson<{ ok: true }>(`/admin/posts/${postId}/channel/resync-caption`, { method: "POST" }),

  // --- Xodim (staff) va ko'rib chiqish (review) ---

  submitPost: (id: string) => adminJson<SubmitPostResponse>(`/admin/posts/${id}/submit`, { method: "POST" }),

  approvePost: (id: string, opts?: { sendToChannel?: boolean }) =>
    adminJson<LifecycleSummary>(
      `/admin/posts/${id}/approve`,
      opts?.sendToChannel ? { method: "POST", ...jsonBody({ sendToChannel: true }) } : { method: "POST" },
    ),

  requestPostChanges: (id: string, note: string) =>
    adminJson<LifecycleSummary>(`/admin/posts/${id}/request-changes`, { method: "POST", ...jsonBody({ note }) }),

  createStaffInvite: (note?: string) =>
    adminJson<CreateStaffInviteResponse>("/admin/staff/invites", { method: "POST", ...jsonBody({ note }) }),

  revokeStaffInvite: (id: string) =>
    adminJson<{ ok: true }>(`/admin/staff/invites/${id}/revoke`, { method: "POST" }),

  removeStaffMember: (userId: string) => adminJson<{ ok: true }>(`/admin/staff/${userId}`, { method: "DELETE" }),

  acceptStaffInvite: (token: string) =>
    adminJson<AcceptStaffInviteResponse>(`/staff/invites/${token}/accept`, { method: "POST" }),
};
