import type { ChannelCheck } from "@blog/shared";
import { DistributionError } from "../errors.js";
import { asRecord, formBody, HostClient, str, type HttpResponse, type ProviderDeps } from "../http.js";
import { check, fmtBytes, isPublicHttpsUrl, textCheck } from "../checks.js";
import { codePointLength, fitParts, normalizeUzbekApostrophes, toHashtags } from "../text.js";
import { DAY_MS, getTokenStatus, type TokenPolicy } from "../token-status.js";
import type {
  AuthorizationUrlInput,
  ConnectedAccount,
  DistributionPost,
  DistributionProvider,
  ExchangeCodeInput,
  PreflightInput,
  ProviderContext,
  PublishInput,
  PublishResult,
  RenderOptions,
} from "../types.js";

/**
 * LinkedIn (shaxsiy profil). Hujjatlar 2026-11-25 da o'qilgan (Microsoft Learn, LinkedIn Marketing API).
 *
 * Manbalar (sahifa sanasi `ms.date` / `updated_at`; versiya — hujjat monikeri):
 *  - Posts API: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
 *      ms.date 2026-05-07, updated 2026-05-13; versiya `li-lms-2026-11` (default moniker) -> `Linkedin-Version: 202611`
 *  - Images API: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api
 *      ms.date 2026-06-19, updated 2026-06-24; versiya li-lms-2026-11
 *  - Rasm yuklash (PUT): https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/vector-asset-api#upload-the-image
 *      ms.date 2023-08-01, updated 2026-01-28
 *  - little matn formati (escape): .../shares/little-text-format  ms.date 2025-02-25, updated 2025-10-16
 *  - 3-legged OAuth: https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow
 *      ms.date 2025-11-10, updated 2026-05-15
 *  - OpenID userinfo: https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2
 *      ms.date 2022-12-14, updated 2024-08-08
 *  - Share on LinkedIn (scope, kunlik limit): .../consumer/integrations/self-serve/share-on-linkedin  ms.date 2021-02-05, updated 2023-12-14
 *
 * UNVERIFIED belgilari — `docs/distribution.md` jadvaliga ham kiritilgan.
 */

/** Posts API: `POST /rest/posts` (201 + `x-restli-id`), `DELETE /rest/posts/{urn}` (204). Posts API sahifasi, 2026-05-13. */
export const LINKEDIN_POSTS_URL = "https://api.linkedin.com/rest/posts";
/** Images API: `POST /rest/images?action=initializeUpload`. Images API sahifasi, 2026-06-24. */
export const LINKEDIN_IMAGES_INIT_URL = "https://api.linkedin.com/rest/images?action=initializeUpload";
/** OpenID Connect userinfo. Sahifa 2024-08-08. */
export const LINKEDIN_USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
/** 3-legged OAuth: authorize / token. Sahifa 2026-05-15. */
export const LINKEDIN_AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
export const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
/** Faqat shu hostlarga so'rov ketadi. `www.linkedin.com` — rasm yuklash (`dms-uploads`) URL'i uchun. */
export const LINKEDIN_HOSTS = ["api.linkedin.com", "www.linkedin.com"] as const;

/**
 * `Linkedin-Version` (YYYYMM). Hujjat default monikeri `li-lms-2026-11`. LinkedIn versiyalarni ~12 oydan keyin
 * to'xtatadi (Marketing 202601 -> 2027-01-15 da sunset) — shuning uchun sozlanadi (`createLinkedInProvider({version})`).
 */
export const LINKEDIN_API_VERSION = "202611";

/** `openid profile` — userinfo uchun; `w_member_social` — "Share on LinkedIn" mahsuloti. */
export const LINKEDIN_SCOPES = ["openid", "profile", "w_member_social"] as const;

/**
 * Commentary chegarasi: 3000 belgi — UNVERIFIED (Posts API sahifasi raqam keltirmaydi, faqat `FIELD_LENGTH_TOO_LONG`).
 * Hisoblash birligi (code point / UTF-16) ham UNVERIFIED — code point bo'yicha sanaymiz.
 */
export const LINKEDIN_COMMENTARY_MAX = 3000;
/** Article sarlavhasi/tavsifi chegaralari — UNVERIFIED (hujjatda ko'rsatilmagan; konservativ qiymatlar). */
export const LINKEDIN_ARTICLE_TITLE_MAX = 400;
export const LINKEDIN_ARTICLE_DESCRIPTION_MAX = 4086;
/** Images API: "less than 36,152,320 pixels", JPG/GIF/PNG. Fayl hajmi chegarasi hujjatda YO'Q (UNVERIFIED) — 8 MB dan oshsa ogohlantiramiz. */
export const LINKEDIN_IMAGE_MAX_PIXELS = 36_152_320;
export const LINKEDIN_IMAGE_MIMES = ["image/jpeg", "image/png", "image/gif"] as const;
export const LINKEDIN_IMAGE_WARN_BYTES = 8 * 1024 * 1024;

/**
 * Token: "all access tokens are issued with a 60-day lifespan"; dasturiy refresh faqat cheklangan hamkorlar uchun
 * ("Programmatic refresh tokens are available for a limited set of partners") — oddiy ishlab chiqaruvchi uchun YO'Q.
 * Eslatma: tugashdan 10 kun oldin (birinchi), `warn` — 7 kun. (Egasi qayta ulaydi: brauzerda qayta avtorizatsiya.)
 */
export const LINKEDIN_TOKEN_POLICY: TokenPolicy = {
  refresh: "none",
  warnBeforeMs: 7 * DAY_MS,
  remindBeforeMs: 10 * DAY_MS,
  refreshLeadMs: 0,
};

/** Share on LinkedIn: "Member 150 requests/day (UTC)" — UGC (`/v2/ugcPosts`) sahifasidan; `/rest/posts` uchun UNVERIFIED. */
export const LINKEDIN_DAILY_MEMBER_LIMIT = 150;

/** little format: ajratilgan belgilar backslash bilan escape qilinadi (little-text-format, "Text" grammatikasi). */
export function escapeLittle(text: string): string {
  return text.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => `\\${c}`);
}

export interface LinkedInPostBodyInput {
  authorUrn: string;
  commentary: string;
  article?: { source: string; title: string; description: string; thumbnailUrn?: string };
}

/** Sof so'rov tanasi quruvchisi (Posts API hujjatidagi shakl). */
export function buildLinkedInPostBody(input: LinkedInPostBodyInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    author: input.authorUrn,
    commentary: escapeLittle(input.commentary),
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
  if (input.article) {
    const article: Record<string, string> = {
      source: input.article.source,
      title: input.article.title,
      description: input.article.description,
    };
    if (input.article.thumbnailUrn) article.thumbnail = input.article.thumbnailUrn;
    body.content = { article };
  }
  return body;
}

export function linkedInHeaders(token: string, version: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Linkedin-Version": version,
    "X-Restli-Protocol-Version": "2.0.0",
    ...extra,
  };
}

/** Maqola havolasi: faqat `https://www.linkedin.com/feed/update/{urn}/` (hujjatda ugcPost misoli; share uchun UNVERIFIED). */
export function linkedInPostUrl(urn: string): string {
  return `https://www.linkedin.com/feed/update/${urn}/`;
}

function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

function renderText(post: DistributionPost, opts: RenderOptions = {}, mode: "article" | "text" = "article"): string {
  const title = normalizeUzbekApostrophes(post.title.trim());
  const excerpt = post.excerpt ? normalizeUzbekApostrophes(post.excerpt.trim()) : "";
  const tags = toHashtags(post.tags, opts.maxHashtags ?? 3).join(" ");
  return fitParts(
    {
      title,
      optional: [
        { key: "excerpt", text: excerpt },
        { key: "tags", text: tags },
      ],
      required: mode === "text" ? post.url : undefined,
    },
    LINKEDIN_COMMENTARY_MAX,
    codePointLength,
  );
}

export interface LinkedInOptions {
  /** `Linkedin-Version` (YYYYMM). Standart: {@link LINKEDIN_API_VERSION}. */
  version?: string;
}

export function createLinkedInProvider(options: LinkedInOptions = {}): DistributionProvider {
  const version = options.version ?? LINKEDIN_API_VERSION;

  const client = (deps: ProviderDeps, account?: { accessToken: string }, extra: string[] = []) =>
    new HostClient(deps, LINKEDIN_HOSTS, [...(account ? [account.accessToken] : []), ...extra]);

  /** LinkedIn xatolari: duplicate (422 "duplicate"), 403 ACCESS_DENIED, 429 (kunlik, UTC), 401. */
  const refine = (now: Date) => (res: HttpResponse, msg: string): DistributionError | undefined => {
    const lower = `${msg} ${res.text}`.toLowerCase();
    if ((res.status === 422 || res.status === 400 || res.status === 409) && lower.includes("duplicate")) {
      return new DistributionError({ kind: "duplicate_content", status: res.status, platformMessage: msg, message: "LinkedIn bu matnni dublikat deb rad etdi" });
    }
    if (res.status === 401) {
      return new DistributionError({ kind: "auth_expired", status: res.status, platformMessage: msg, message: "LinkedIn token muddati tugagan yoki bekor qilingan — qayta ulang" });
    }
    if (res.status === 403) {
      return new DistributionError({ kind: "permission_missing", status: res.status, platformMessage: msg, message: "LinkedIn ruxsat bermadi (w_member_social yoki mahsulot yetishmaydi)" });
    }
    if (res.status === 429) {
      const ra = res.headers.get("retry-after");
      const secs = ra ? Number(ra) : NaN;
      return new DistributionError({
        kind: "rate_limited",
        status: 429,
        platformMessage: msg,
        retryAt: Number.isFinite(secs) ? new Date(now.getTime() + secs * 1000) : nextUtcMidnight(now),
        message: "LinkedIn kunlik limiti oshdi (UTC bo'yicha yangilanadi)",
      });
    }
    return undefined;
  };

  const nowOf = (deps: ProviderDeps) => deps.now?.() ?? new Date();

  function accountFrom(tokenRes: Record<string, unknown>, profile: Record<string, unknown>, now: Date): ConnectedAccount {
    const accessToken = str(tokenRes.access_token);
    const sub = str(profile.sub);
    if (!accessToken || !sub) {
      throw new DistributionError({ kind: "validation_rejected", message: "LinkedIn javobida access_token yoki sub yo'q" });
    }
    const expiresIn = typeof tokenRes.expires_in === "number" ? tokenRes.expires_in : null;
    const refreshExpiresIn = typeof tokenRes.refresh_token_expires_in === "number" ? tokenRes.refresh_token_expires_in : null;
    const refreshToken = str(tokenRes.refresh_token) ?? null;
    return {
      provider: "linkedin",
      externalId: sub,
      displayName: str(profile.name) ?? (`${str(profile.given_name) ?? ""} ${str(profile.family_name) ?? ""}`.trim() || sub),
      accessToken,
      refreshToken,
      accessTokenExpiresAt: expiresIn === null ? null : new Date(now.getTime() + expiresIn * 1000),
      refreshTokenExpiresAt: refreshToken && refreshExpiresIn !== null ? new Date(now.getTime() + refreshExpiresIn * 1000) : null,
      scopes: (str(tokenRes.scope) ?? LINKEDIN_SCOPES.join(",")).split(/[\s,]+/).filter(Boolean),
      issuedAt: now,
      connectedAt: now,
    };
  }

  const provider: DistributionProvider = {
    id: "linkedin",
    capabilities: { text: true, link: true, image: true, edit: false, delete: true, nativeScheduling: false },
    limits: { textMax: LINKEDIN_COMMENTARY_MAX, textUnit: "characters", imageMaxBytes: null, imageMimes: LINKEDIN_IMAGE_MIMES },
    tokenPolicy: LINKEDIN_TOKEN_POLICY,
    auth: {
      kind: "oauth_code",
      scopes: LINKEDIN_SCOPES,
      buildAuthorizationUrl({ creds, state }: AuthorizationUrlInput): string {
        const u = new URL(LINKEDIN_AUTHORIZE_URL);
        u.searchParams.set("response_type", "code");
        u.searchParams.set("client_id", creds.clientId);
        u.searchParams.set("redirect_uri", creds.redirectUri);
        u.searchParams.set("state", state);
        u.searchParams.set("scope", LINKEDIN_SCOPES.join(" "));
        return u.toString();
      },
      async exchangeCode(deps: ProviderDeps, { creds, code }: ExchangeCodeInput): Promise<ConnectedAccount> {
        const secrets = [creds.clientSecret ?? "", code];
        const http = new HostClient(deps, LINKEDIN_HOSTS, secrets);
        const res = await http.request({
          method: "POST",
          url: LINKEDIN_TOKEN_URL,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: formBody({ grant_type: "authorization_code", code, client_id: creds.clientId, client_secret: creds.clientSecret, redirect_uri: creds.redirectUri }),
          mode: "safe_write",
        });
        if (res.status < 200 || res.status >= 300) {
          const e = http.fail(res, "safe_write");
          // Token almashtirishda 400/401 — kod eskirgan/yaroqsiz.
          throw res.status === 400 || res.status === 401
            ? new DistributionError({ kind: "auth_expired", status: res.status, platformMessage: e.platformMessage, message: "Avtorizatsiya kodi yaroqsiz yoki eskirgan — qayta ulang" })
            : e;
        }
        const tokenRes = asRecord(res.json);
        const accessToken = str(tokenRes.access_token);
        const http2 = new HostClient(deps, LINKEDIN_HOSTS, [...secrets, accessToken ?? ""]);
        const info = await http2.request({ method: "GET", url: LINKEDIN_USERINFO_URL, headers: { Authorization: `Bearer ${accessToken ?? ""}` }, mode: "read" });
        if (info.status < 200 || info.status >= 300) throw http2.fail(info, "read", refine(nowOf(deps)));
        return accountFrom(tokenRes, asRecord(info.json), nowOf(deps));
      },
    },

    tokenStatus: (account, now) => getTokenStatus(account, LINKEDIN_TOKEN_POLICY, now),
    renderDefaultText: (post, opts) => renderText(post, opts, "article"),
    measureText: codePointLength,

    preflight(input: PreflightInput): ChannelCheck[] {
      const mode = input.linkMode ?? "article";
      const text = input.text ?? renderText(input.post, {}, mode);
      const out: ChannelCheck[] = [];
      out.push(textCheck({ text, used: codePointLength(text), limit: LINKEDIN_COMMENTARY_MAX, unitLabel: "belgi" }));
      if (mode === "article") {
        out.push(
          check({
            id: "config.article",
            group: "config",
            status: "ok",
            title: "Maqola kartasi",
            message: "Sarlavha, tavsif va rasm qo'lda beriladi (LinkedIn havoladan avtomatik olmaydi)",
          }),
        );
        if (!input.post.title.trim()) out.push(check({ id: "config.title", group: "config", status: "error", title: "Sarlavha", message: "Maqola sarlavhasi bo'sh" }));
        if (!input.post.excerpt?.trim()) {
          out.push(check({ id: "config.description", group: "config", status: "warn", title: "Tavsif", message: "Qisqa tavsif (excerpt) yo'q — karta tavsifsiz chiqadi" }));
        }
        if (!input.image) {
          out.push(check({ id: "media.thumbnail", group: "media", status: "error", title: "Muqova rasmi", message: "Article posti uchun muqova (thumbnail) rasmi kerak — yoki 'matn + havola' variantini tanlang" }));
        }
      }
      if (input.image) out.push(...imageChecks(input.image));
      if (!isPublicHttpsUrl(input.post.url)) {
        out.push(check({ id: "config.url", group: "config", status: "error", title: "Havola", message: "Maqola havolasi ochiq https URL bo'lishi kerak", value: input.post.url }));
      }
      return out;
    },

    async publish(ctx: ProviderContext, input: PublishInput): Promise<PublishResult> {
      const { deps, account } = ctx;
      const mode = input.linkMode ?? "article";
      const http = client(deps, account);
      const ref = refine(nowOf(deps));
      const authorUrn = `urn:li:person:${account.externalId}`;
      let thumbnailUrn: string | undefined;

      if (mode === "article") {
        if (!input.image) throw new DistributionError({ kind: "validation_rejected", message: "Article posti uchun rasm kerak" });
        // 1) Yuklashni boshlash (xavfsiz — qayta urinish yetim yozuv qoldirishi mumkin, zarar yo'q).
        const init = await http.request({
          method: "POST",
          url: LINKEDIN_IMAGES_INIT_URL,
          headers: linkedInHeaders(account.accessToken, version, { "Content-Type": "application/json" }),
          body: JSON.stringify({ initializeUploadRequest: { owner: authorUrn } }),
          mode: "safe_write",
        });
        if (init.status < 200 || init.status >= 300) throw http.fail(init, "safe_write", ref);
        const value = asRecord(asRecord(init.json).value);
        const uploadUrl = str(value.uploadUrl);
        thumbnailUrn = str(value.image);
        if (!uploadUrl || !thumbnailUrn) throw new DistributionError({ kind: "validation_rejected", message: "LinkedIn yuklash URL'ini qaytarmadi" });
        // 2) Baytlarni yuklash: PUT, Authorization bilan (vector-asset-api "Upload the Image"). URL host allow-list orqali tekshiriladi.
        const up = await http.request({
          method: "PUT",
          url: uploadUrl,
          headers: { Authorization: `Bearer ${account.accessToken}`, "Content-Type": input.image.mime },
          body: input.image.bytes,
          mode: "safe_write",
        });
        if (up.status < 200 || up.status >= 300) throw http.fail(up, "safe_write", ref);
      }

      // 3) Post (create): timeout/5xx = outcome_unknown.
      const body = buildLinkedInPostBody({
        authorUrn,
        commentary: input.text,
        article:
          mode === "article"
            ? {
                source: input.post.url,
                title: input.post.title.slice(0, LINKEDIN_ARTICLE_TITLE_MAX),
                description: (input.post.excerpt ?? "").slice(0, LINKEDIN_ARTICLE_DESCRIPTION_MAX),
                thumbnailUrn,
              }
            : undefined,
      });
      const res = await http.request({
        method: "POST",
        url: LINKEDIN_POSTS_URL,
        headers: linkedInHeaders(account.accessToken, version, { "Content-Type": "application/json" }),
        body: JSON.stringify(body),
        mode: "create",
      });
      if (res.status !== 201 && !(res.status >= 200 && res.status < 300)) throw http.fail(res, "create", ref);
      const id = res.headers.get("x-restli-id") ?? str(asRecord(res.json).id);
      if (!id) {
        throw new DistributionError({ kind: "outcome_unknown", status: res.status, message: "LinkedIn post yaratdi, lekin id qaytarmadi — qayta urinmang, profilni tekshiring" });
      }
      return { externalId: id, url: linkedInPostUrl(id) };
    },

    async remove(ctx: ProviderContext, externalId: string): Promise<void> {
      const http = client(ctx.deps, ctx.account);
      const res = await http.request({
        method: "DELETE",
        url: `${LINKEDIN_POSTS_URL}/${encodeURIComponent(externalId)}`,
        headers: linkedInHeaders(ctx.account.accessToken, version, { "X-RestLi-Method": "DELETE" }),
        mode: "safe_write",
      });
      // 204 (o'chirish idempotent: oldin o'chirilganga ham 204 qaytadi — Posts API).
      if (res.status !== 204 && (res.status < 200 || res.status >= 300)) throw http.fail(res, "safe_write", refine(nowOf(ctx.deps)));
    },
  };
  return provider;
}

function imageChecks(img: { mime: string; width: number; height: number; sizeBytes: number }): ChannelCheck[] {
  const out: ChannelCheck[] = [];
  const okMime = (LINKEDIN_IMAGE_MIMES as readonly string[]).includes(img.mime);
  out.push(
    check({
      id: "media.format",
      group: "media",
      status: okMime ? "ok" : "error",
      title: "Rasm formati",
      message: okMime ? "Format mos" : "LinkedIn faqat JPG, PNG, GIF qabul qiladi — rasmni shu formatlardan biriga o'tkazing (bu yerda konvertatsiya yo'q)",
      value: img.mime,
      limit: "image/jpeg, image/png, image/gif",
    }),
  );
  const px = img.width * img.height;
  out.push(
    check({
      id: "media.pixels",
      group: "media",
      status: px < LINKEDIN_IMAGE_MAX_PIXELS ? "ok" : "error",
      title: "Piksellar soni",
      message: px < LINKEDIN_IMAGE_MAX_PIXELS ? "Mos" : "Rasm juda katta — kichraytiring",
      value: `${img.width}×${img.height} (${px} px)`,
      limit: `< ${LINKEDIN_IMAGE_MAX_PIXELS} px`,
    }),
  );
  if (img.sizeBytes > LINKEDIN_IMAGE_WARN_BYTES) {
    out.push(check({ id: "media.size", group: "media", status: "warn", title: "Fayl hajmi", message: "Hujjatda hajm chegarasi ko'rsatilmagan (UNVERIFIED); katta fayl rad etilishi mumkin", value: fmtBytes(img.sizeBytes), limit: null }));
  }
  return out;
}
