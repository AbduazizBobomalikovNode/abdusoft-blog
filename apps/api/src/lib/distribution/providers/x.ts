import type { ChannelCheck } from "@blog/shared";
import { DistributionError } from "../errors.js";
import { asRecord, formBody, HostClient, realSleep, str, type HttpResponse, type ProviderDeps } from "../http.js";
import { check, fmtBytes, textCheck } from "../checks.js";
import { findUrls, fitParts, normalizeUzbekApostrophes, toHashtags, xWeightedLength } from "../text.js";
import { DAY_MS, getTokenStatus, type TokenPolicy } from "../token-status.js";
import type {
  AuthorizationUrlInput,
  ClientCredentials,
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
 * X (Twitter). Hujjatlar 2026-11-25 da docs.x.com dan o'qilgan. Aksar sahifalarda SANA/VERSIYA KO'RSATILMAGAN
 * (quyida "sana yo'q" deb belgilangan).
 *
 *  - OAuth 2.0 PKCE: https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/user-access-token (sana yo'q)
 *  - Post yaratish: https://docs.x.com/x-api/posts/creation-of-a-post (sana yo'q)
 *  - Post o'chirish: https://docs.x.com/x-api/posts/delete-post (sana yo'q)
 *  - /2/users/me: https://docs.x.com/x-api/users/get-my-user (sana yo'q)
 *  - Media yuklash v2: https://docs.x.com/x-api/media/upload-media , .../media/quickstart/media-upload-chunked (sana yo'q)
 *  - Belgilarni sanash: https://docs.x.com/fundamentals/counting-characters (sana yo'q)
 *  - Narx: https://docs.x.com/x-api/getting-started/pricing (sana yo'q; narxlar o'zgarishi mumkin deb yozilgan)
 *  - Xatolar: https://docs.x.com/x-api/fundamentals/response-codes-and-errors (sana yo'q)
 */

/** Authorize: GET (brauzer). docs.x.com ... /user-access-token. */
export const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
/** Token almashtirish va refresh: POST form-urlencoded. */
export const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";
/** Post yaratish (201) — `POST /2/tweets`. */
export const X_TWEETS_URL = "https://api.x.com/2/tweets";
/** `GET /2/users/me` — id, name, username. */
export const X_ME_URL = "https://api.x.com/2/users/me";
/** Bir martalik rasm yuklash: `POST /2/media/upload` (JSON: media=base64, media_category=tweet_image). */
export const X_MEDIA_UPLOAD_URL = "https://api.x.com/2/media/upload";
export const X_HOSTS = ["api.x.com"] as const;

export const X_SCOPES = ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"] as const;
/** 280 "vazn birligi" (X sanash qoidasi); Premium hisoblarda uzunroq (bu yerda hisobga olinmaydi). */
export const X_TEXT_MAX = 280;
/** tweet_image: JPG/PNG/GIF/WEBP, 5 MB gacha (upload-media sahifasi). */
export const X_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const X_IMAGE_MIMES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
/** Narx (pricing sahifasi, sana yo'q — UNVERIFIED, o'zgarishi mumkin): oddiy post $0.015, URL'li post $0.200. */
export const X_PRICE_POST_USD = 0.015;
export const X_PRICE_POST_WITH_URL_USD = 0.2;

/**
 * Access token ~2 soat ("two hours", `expires_in` qiymati hujjatda ko'rsatilmagan -> javobdan o'qiladi, bo'lmasa 7200: UNVERIFIED).
 * Refresh token `offline.access` bilan beriladi; muddati "until you revoke access" (UNVERIFIED). Har refresh YANGI refresh token
 * qaytarishi mumkin (rotatsiya UNVERIFIED) — har doim oxirgisini saqlash shart.
 */
export const X_TOKEN_POLICY: TokenPolicy = {
  refresh: "rotating_refresh_token",
  warnBeforeMs: 7 * DAY_MS,
  remindBeforeMs: 14 * DAY_MS,
  refreshLeadMs: 10 * 60_000,
};
export const X_DEFAULT_ACCESS_TTL_S = 2 * 3600;

export function xBasicAuth(creds: ClientCredentials): string | undefined {
  return creds.clientSecret ? `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64")}` : undefined;
}

/** Sof: token so'rovi (code almashtirish yoki refresh). Konfidensial mijoz — Basic header; public — client_id tanada. */
export function buildXTokenRequest(creds: ClientCredentials, params: Record<string, string>): { headers: Record<string, string>; body: string } {
  const basic = xBasicAuth(creds);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (basic) headers.Authorization = basic;
  return { headers, body: formBody({ ...params, ...(basic ? {} : { client_id: creds.clientId }) }) };
}

export function buildXTweetBody(text: string, mediaId?: string): Record<string, unknown> {
  return mediaId ? { text, media: { media_ids: [mediaId] } } : { text };
}

export function buildXMediaUploadBody(bytes: Uint8Array): Record<string, unknown> {
  return { media: Buffer.from(bytes).toString("base64"), media_category: "tweet_image" };
}

function renderText(post: DistributionPost, opts: RenderOptions = {}): string {
  const title = normalizeUzbekApostrophes(post.title.trim());
  const excerpt = post.excerpt ? normalizeUzbekApostrophes(post.excerpt.trim()) : "";
  const tags = toHashtags(post.tags, opts.maxHashtags ?? 2).join(" ");
  return fitParts(
    { title, optional: [{ key: "excerpt", text: excerpt }, { key: "tags", text: tags }], required: post.url },
    X_TEXT_MAX,
    xWeightedLength,
  );
}

export function createXProvider(): DistributionProvider {
  const nowOf = (deps: ProviderDeps) => deps.now?.() ?? new Date();

  const refine = () => (res: HttpResponse, msg: string): DistributionError | undefined => {
    const j = asRecord(res.json);
    const type = str(j.type) ?? "";
    const lower = `${msg} ${res.text}`.toLowerCase();
    if (res.status === 402) return new DistributionError({ kind: "payment_required", status: 402, platformMessage: msg, message: "X: kredit tugagan yoki to'lov kerak" });
    if (res.status === 429) {
      if (type.includes("usage-capped") || lower.includes("usage cap") || lower.includes("credits")) {
        return new DistributionError({ kind: "payment_required", status: 429, platformMessage: msg, message: "X: foydalanish chegarasi/kredit tugadi (usage-capped)" });
      }
      const reset = Number(res.headers.get("x-rate-limit-reset"));
      return new DistributionError({
        kind: "rate_limited",
        status: 429,
        platformMessage: msg,
        retryAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : undefined,
        message: "X so'rovlar limiti oshdi",
      });
    }
    if (res.status === 403 && lower.includes("duplicate")) {
      return new DistributionError({ kind: "duplicate_content", status: 403, platformMessage: msg, message: "X bu matnni dublikat deb rad etdi" });
    }
    if (res.status === 403 && lower.includes("credit")) {
      return new DistributionError({ kind: "payment_required", status: 403, platformMessage: msg, message: "X: kredit tugagan" });
    }
    return undefined;
  };

  async function tokenCall(deps: ProviderDeps, creds: ClientCredentials, params: Record<string, string>, secrets: string[]) {
    const http = new HostClient(deps, X_HOSTS, [creds.clientSecret ?? "", ...secrets]);
    const { headers, body } = buildXTokenRequest(creds, params);
    const res = await http.request({ method: "POST", url: X_TOKEN_URL, headers, body, mode: "safe_write" });
    if (res.status < 200 || res.status >= 300) {
      const e = http.fail(res, "safe_write");
      // Token so'rovida 400 (invalid_grant) — kod/refresh token yaroqsiz.
      throw res.status === 400 || res.status === 401
        ? new DistributionError({ kind: "auth_expired", status: res.status, platformMessage: e.platformMessage, message: "X tokeni yaroqsiz yoki bekor qilingan — qayta ulang" })
        : e;
    }
    return asRecord(res.json);
  }

  function applyTokens(tokenRes: Record<string, unknown>, prev: ConnectedAccount | null, now: Date): Pick<ConnectedAccount, "accessToken" | "refreshToken" | "accessTokenExpiresAt" | "refreshTokenExpiresAt" | "scopes" | "issuedAt"> {
    const accessToken = str(tokenRes.access_token);
    if (!accessToken) throw new DistributionError({ kind: "validation_rejected", message: "X javobida access_token yo'q" });
    const ttl = typeof tokenRes.expires_in === "number" ? tokenRes.expires_in : X_DEFAULT_ACCESS_TTL_S;
    return {
      accessToken,
      // Rotatsiya: yangi refresh token kelsa — u eskisini almashtiradi. Kelmasa eskisi qoladi.
      refreshToken: str(tokenRes.refresh_token) ?? prev?.refreshToken ?? null,
      accessTokenExpiresAt: new Date(now.getTime() + ttl * 1000),
      refreshTokenExpiresAt: prev?.refreshTokenExpiresAt ?? null,
      scopes: str(tokenRes.scope) ? (str(tokenRes.scope) as string).split(/[\s,]+/).filter(Boolean) : (prev?.scopes ?? [...X_SCOPES]),
      issuedAt: now,
    };
  }

  const provider: DistributionProvider = {
    id: "x",
    capabilities: { text: true, link: true, image: true, edit: false, delete: true, nativeScheduling: false },
    limits: { textMax: X_TEXT_MAX, textUnit: "weighted", imageMaxBytes: X_IMAGE_MAX_BYTES, imageMimes: X_IMAGE_MIMES },
    tokenPolicy: X_TOKEN_POLICY,
    auth: {
      kind: "oauth_pkce",
      scopes: X_SCOPES,
      buildAuthorizationUrl({ creds, state, codeChallenge }: AuthorizationUrlInput): string {
        if (!codeChallenge) throw new DistributionError({ kind: "validation_rejected", message: "X uchun PKCE code_challenge kerak" });
        const u = new URL(X_AUTHORIZE_URL);
        u.searchParams.set("response_type", "code");
        u.searchParams.set("client_id", creds.clientId);
        u.searchParams.set("redirect_uri", creds.redirectUri);
        u.searchParams.set("scope", X_SCOPES.join(" "));
        u.searchParams.set("state", state);
        u.searchParams.set("code_challenge", codeChallenge);
        u.searchParams.set("code_challenge_method", "S256");
        return u.toString();
      },
      async exchangeCode(deps: ProviderDeps, { creds, code, codeVerifier }: ExchangeCodeInput): Promise<ConnectedAccount> {
        if (!codeVerifier) throw new DistributionError({ kind: "validation_rejected", message: "X uchun code_verifier kerak" });
        const now = nowOf(deps);
        const tokenRes = await tokenCall(deps, creds, { grant_type: "authorization_code", code, redirect_uri: creds.redirectUri, code_verifier: codeVerifier }, [code, codeVerifier]);
        const tokens = applyTokens(tokenRes, null, now);
        const http = new HostClient(deps, X_HOSTS, [tokens.accessToken, tokens.refreshToken ?? "", creds.clientSecret ?? ""]);
        const me = await http.request({ method: "GET", url: X_ME_URL, headers: { Authorization: `Bearer ${tokens.accessToken}` }, mode: "read" });
        if (me.status < 200 || me.status >= 300) throw http.fail(me, "read", refine());
        const data = asRecord(asRecord(me.json).data);
        const id = str(data.id);
        if (!id) throw new DistributionError({ kind: "validation_rejected", message: "X /users/me javobida id yo'q" });
        return {
          provider: "x",
          externalId: id,
          displayName: str(data.name) ?? str(data.username) ?? id,
          username: str(data.username),
          ...tokens,
          connectedAt: now,
        };
      },
      async refresh(deps: ProviderDeps, creds: ClientCredentials, account: ConnectedAccount): Promise<ConnectedAccount> {
        if (!account.refreshToken) throw new DistributionError({ kind: "auth_expired", message: "X refresh token yo'q — qayta ulang" });
        const now = nowOf(deps);
        const tokenRes = await tokenCall(deps, creds, { grant_type: "refresh_token", refresh_token: account.refreshToken }, [account.refreshToken, account.accessToken]);
        // MUHIM: qaytgan YANGI refresh token chaqiruvchi tomonidan darhol saqlanishi shart (eskisi bekor bo'ladi).
        return { ...account, ...applyTokens(tokenRes, account, now) };
      },
    },

    tokenStatus: (account, now) => getTokenStatus(account, X_TOKEN_POLICY, now),
    renderDefaultText: renderText,
    measureText: xWeightedLength,

    preflight(input: PreflightInput): ChannelCheck[] {
      const text = input.text ?? renderText(input.post);
      const out: ChannelCheck[] = [textCheck({ text, used: xWeightedLength(text), limit: X_TEXT_MAX, unitLabel: "birlik" })];
      if (findUrls(text).length > 0) {
        out.push(
          check({
            id: "config.cost",
            group: "config",
            status: "warn",
            title: "Narx",
            message: `URL'li post qimmatroq: $${X_PRICE_POST_WITH_URL_USD.toFixed(3)} (oddiy post $${X_PRICE_POST_USD.toFixed(3)}) — narx sahifasi bo'yicha, sana ko'rsatilmagan (UNVERIFIED)`,
            value: `$${X_PRICE_POST_WITH_URL_USD.toFixed(3)}`,
            limit: null,
          }),
        );
      }
      if (input.image) {
        const img = input.image;
        const okMime = (X_IMAGE_MIMES as readonly string[]).includes(img.mime);
        out.push(check({ id: "media.format", group: "media", status: okMime ? "ok" : "error", title: "Rasm formati", message: okMime ? "Format mos" : "X: JPG, PNG, GIF yoki WEBP kerak — rasmni o'tkazing (bu yerda konvertatsiya yo'q)", value: img.mime, limit: "jpeg, png, gif, webp" }));
        out.push(check({ id: "media.size", group: "media", status: img.sizeBytes <= X_IMAGE_MAX_BYTES ? "ok" : "error", title: "Fayl hajmi", message: img.sizeBytes <= X_IMAGE_MAX_BYTES ? "Mos" : "Rasm 5 MB dan katta — siqing", value: fmtBytes(img.sizeBytes), limit: fmtBytes(X_IMAGE_MAX_BYTES) }));
      }
      return out;
    },

    async publish(ctx: ProviderContext, input: PublishInput): Promise<PublishResult> {
      const { deps, account } = ctx;
      const http = new HostClient(deps, X_HOSTS, [account.accessToken, account.refreshToken ?? ""]);
      const ref = refine();
      const auth = { Authorization: `Bearer ${account.accessToken}` };
      let mediaId: string | undefined;

      if (input.image) {
        const up = await http.request({
          method: "POST",
          url: X_MEDIA_UPLOAD_URL,
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify(buildXMediaUploadBody(input.image.bytes)),
          mode: "safe_write",
        });
        if (up.status < 200 || up.status >= 300) throw http.fail(up, "safe_write", ref);
        const data = asRecord(asRecord(up.json).data);
        mediaId = str(data.id);
        if (!mediaId) throw new DistributionError({ kind: "validation_rejected", message: "X media id qaytarmadi" });
        // processing_info faqat javobda bo'lsa (UNVERIFIED: rasm uchun uchraydimi) — chegaralangan kutish.
        let info = asRecord(data.processing_info);
        const sleep = deps.sleep ?? realSleep;
        for (let i = 0; i < 5 && (info.state === "pending" || info.state === "in_progress"); i++) {
          const wait = typeof info.check_after_secs === "number" ? Math.min(info.check_after_secs, 10) : 2;
          await sleep(wait * 1000);
          const st = await http.request({ method: "GET", url: `${X_MEDIA_UPLOAD_URL}?command=STATUS&media_id=${encodeURIComponent(mediaId)}`, headers: auth, mode: "read" });
          if (st.status < 200 || st.status >= 300) throw http.fail(st, "read", ref);
          info = asRecord(asRecord(asRecord(st.json).data).processing_info);
        }
        if (info.state === "failed") throw new DistributionError({ kind: "validation_rejected", message: "X rasmni qayta ishlay olmadi" });
        if (info.state === "pending" || info.state === "in_progress") throw new DistributionError({ kind: "transient", message: "X rasm qayta ishlashi tugamadi — keyinroq urining" });
      }

      const res = await http.request({
        method: "POST",
        url: X_TWEETS_URL,
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify(buildXTweetBody(input.text, mediaId)),
        mode: "create",
      });
      if (res.status < 200 || res.status >= 300) throw http.fail(res, "create", ref);
      const id = str(asRecord(asRecord(res.json).data).id);
      if (!id) throw new DistributionError({ kind: "outcome_unknown", status: res.status, message: "X post id qaytarmadi — qayta urinmang, profilni tekshiring" });
      return { externalId: id, url: `https://x.com/${account.username ?? "i"}/status/${id}` };
    },

    async remove(ctx: ProviderContext, externalId: string): Promise<void> {
      const http = new HostClient(ctx.deps, X_HOSTS, [ctx.account.accessToken]);
      const res = await http.request({ method: "DELETE", url: `${X_TWEETS_URL}/${encodeURIComponent(externalId)}`, headers: { Authorization: `Bearer ${ctx.account.accessToken}` }, mode: "safe_write" });
      if (res.status < 200 || res.status >= 300) throw http.fail(res, "safe_write", refine());
      if (asRecord(asRecord(res.json).data).deleted === false) throw new DistributionError({ kind: "validation_rejected", message: "X postni o'chirmadi (deleted=false)" });
    },
  };
  return provider;
}
