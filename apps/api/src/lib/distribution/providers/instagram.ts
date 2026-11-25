import type { ChannelCheck } from "@blog/shared";
import { DistributionError } from "../errors.js";
import { asRecord, HostClient, str, type ProviderDeps } from "../http.js";
import { check, fmtBytes, isPublicHttpsUrl, textCheck } from "../checks.js";
import { codePointLength, findUrls, fitParts, normalizeUzbekApostrophes, toHashtags } from "../text.js";
import { getTokenStatus } from "../token-status.js";
import { DEFAULT_POLL_SCHEDULE_MS, GRAPH_TOKEN_POLICY, graphRefine, pollContainer, toGraphForm, type ContainerState } from "./graph.js";
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
 * Instagram (Instagram API with Instagram Login). Hujjatlar 2026-11-25 da developers.facebook.com dan o'qilgan;
 * sahifalarda sana ko'rsatilmagan. Graph versiyasi: hujjat misollarida `v27.0`.
 *
 *  - Biznes login: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login (sana yo'q)
 *  - Kontent chop etish: https://developers.facebook.com/docs/instagram-platform/content-publishing (sana yo'q)
 *  - /media (rasm talablari, caption): https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media (v27.0, sana yo'q)
 *  - Umumiy ko'rinish (Standard/Advanced Access): https://developers.facebook.com/docs/instagram-platform/overview (sana yo'q)
 */

export const INSTAGRAM_AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
/** Qisqa muddatli token: POST (client_id, client_secret, grant_type, redirect_uri, code) -> `{data:[{access_token,user_id,permissions}]}`. */
export const INSTAGRAM_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
export const INSTAGRAM_GRAPH_BASE = "https://graph.instagram.com";
export const INSTAGRAM_API_VERSION = "v27.0";
/** Uzoq muddatli: GET ?grant_type=ig_exchange_token&client_secret&access_token. */
export const INSTAGRAM_LONG_LIVED_URL = `${INSTAGRAM_GRAPH_BASE}/access_token`;
/** Yangilash: GET ?grant_type=ig_refresh_token&access_token. */
export const INSTAGRAM_REFRESH_URL = `${INSTAGRAM_GRAPH_BASE}/refresh_access_token`;
export const INSTAGRAM_HOSTS = ["graph.instagram.com", "api.instagram.com"] as const;

export const INSTAGRAM_SCOPES = ["instagram_business_basic", "instagram_business_content_publish"] as const;
/** Caption <= 2200 belgi, <= 30 hashtag, <= 20 @mention (media reference). Sanash birligi UNVERIFIED -> code point. */
export const INSTAGRAM_CAPTION_MAX = 2200;
export const INSTAGRAM_HASHTAG_MAX = 30;
/** Rasm: faqat JPEG, <= 8 MB, nisbat 4:5 .. 1.91:1, kenglik 320..1440 px (tashqarisi masshtablanadi), sRGB. */
export const INSTAGRAM_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const INSTAGRAM_ASPECT_MIN = 4 / 5;
export const INSTAGRAM_ASPECT_MAX = 1.91;
export const INSTAGRAM_WIDTH_MIN = 320;
export const INSTAGRAM_WIDTH_MAX = 1440;
/** 100 API-post / 24 soat (content-publishing); karusel bo'limida 50 deyiladi — hujjatda ziddiyat (UNVERIFIED). */
export const INSTAGRAM_POSTS_PER_DAY = 100;

export function instagramUrl(path: string, query?: Record<string, string>): string {
  const u = new URL(`${INSTAGRAM_GRAPH_BASE}/${INSTAGRAM_API_VERSION}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, v);
  return u.toString();
}

export function buildInstagramContainerParams(input: { imageUrl: string; caption: string; alt?: string; accessToken: string }): Record<string, string> {
  return { image_url: input.imageUrl, caption: input.caption, ...(input.alt ? { alt_text: input.alt.slice(0, 1000) } : {}), access_token: input.accessToken };
}

function renderText(post: DistributionPost, opts: RenderOptions = {}): string {
  const title = normalizeUzbekApostrophes(post.title.trim());
  const excerpt = post.excerpt ? normalizeUzbekApostrophes(post.excerpt.trim()) : "";
  const tags = toHashtags(post.tags, Math.min(opts.maxHashtags ?? 8, INSTAGRAM_HASHTAG_MAX)).join(" ");
  return fitParts(
    {
      title,
      optional: [{ key: "excerpt", text: excerpt }, { key: "tags", text: tags }],
      // URL standart qo'shilmaydi: Instagram captionida havola bosilmaydi (hujjat tasdig'i yo'q — UNVERIFIED, lekin amalda shunday).
      required: opts.includeUrl ? post.url : undefined,
    },
    INSTAGRAM_CAPTION_MAX,
    codePointLength,
  );
}

export interface InstagramOptions {
  pollScheduleMs?: readonly number[];
}

export function createInstagramProvider(options: InstagramOptions = {}): DistributionProvider {
  const schedule = options.pollScheduleMs ?? DEFAULT_POLL_SCHEDULE_MS;
  const nowOf = (deps: ProviderDeps) => deps.now?.() ?? new Date();

  async function getJson(http: HostClient, deps: ProviderDeps, url: string) {
    const res = await http.request({ method: "GET", url, mode: "read" });
    if (res.status < 200 || res.status >= 300) throw http.fail(res, "read", graphRefine(deps, "Instagram"));
    return asRecord(res.json);
  }

  function build(token: string, expiresIn: number | null, me: Record<string, unknown>, now: Date, prev?: ConnectedAccount): ConnectedAccount {
    const id = str(me.user_id) ?? str(me.id) ?? prev?.externalId;
    if (!id) throw new DistributionError({ kind: "validation_rejected", message: "Instagram /me javobida user_id yo'q" });
    return {
      provider: "instagram",
      externalId: id,
      displayName: str(me.username) ?? prev?.displayName ?? id,
      username: str(me.username) ?? prev?.username,
      accessToken: token,
      refreshToken: null,
      accessTokenExpiresAt: expiresIn === null ? null : new Date(now.getTime() + expiresIn * 1000),
      refreshTokenExpiresAt: null,
      scopes: prev?.scopes ?? [...INSTAGRAM_SCOPES],
      issuedAt: now,
      connectedAt: prev?.connectedAt ?? now,
    };
  }

  const provider: DistributionProvider = {
    id: "instagram",
    capabilities: { text: true, link: false, image: true, edit: false, delete: false, nativeScheduling: false },
    limits: { textMax: INSTAGRAM_CAPTION_MAX, textUnit: "characters", imageMaxBytes: INSTAGRAM_IMAGE_MAX_BYTES, imageMimes: ["image/jpeg"] },
    tokenPolicy: GRAPH_TOKEN_POLICY,
    auth: {
      kind: "oauth_code",
      scopes: INSTAGRAM_SCOPES,
      buildAuthorizationUrl({ creds, state }: AuthorizationUrlInput): string {
        const u = new URL(INSTAGRAM_AUTHORIZE_URL);
        u.searchParams.set("client_id", creds.clientId);
        u.searchParams.set("redirect_uri", creds.redirectUri);
        u.searchParams.set("response_type", "code");
        u.searchParams.set("scope", INSTAGRAM_SCOPES.join(","));
        u.searchParams.set("state", state);
        return u.toString();
      },
      async exchangeCode(deps: ProviderDeps, { creds, code }: ExchangeCodeInput): Promise<ConnectedAccount> {
        const now = nowOf(deps);
        const secrets = [creds.clientSecret ?? "", code];
        const http = new HostClient(deps, INSTAGRAM_HOSTS, secrets);
        const short = await http.request({
          method: "POST",
          url: INSTAGRAM_TOKEN_URL,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: toGraphForm({ client_id: creds.clientId, client_secret: creds.clientSecret, grant_type: "authorization_code", redirect_uri: creds.redirectUri, code }),
          mode: "safe_write",
        });
        if (short.status < 200 || short.status >= 300) throw http.fail(short, "safe_write", graphRefine(deps, "Instagram"));
        const sj = asRecord(short.json);
        // Javob `data` massivida o'raladi (business-login sahifasi); tekis shaklga ham bardosh beramiz.
        const first = Array.isArray(sj.data) ? asRecord(sj.data[0]) : sj;
        const shortToken = str(first.access_token);
        if (!shortToken) throw new DistributionError({ kind: "validation_rejected", message: "Instagram access_token qaytarmadi" });
        const http2 = new HostClient(deps, INSTAGRAM_HOSTS, [...secrets, shortToken]);
        const longRes = await getJson(http2, deps, `${INSTAGRAM_LONG_LIVED_URL}?${toGraphForm({ grant_type: "ig_exchange_token", client_secret: creds.clientSecret, access_token: shortToken })}`);
        const longToken = str(longRes.access_token);
        if (!longToken) throw new DistributionError({ kind: "validation_rejected", message: "Instagram uzoq muddatli token qaytarmadi" });
        const http3 = new HostClient(deps, INSTAGRAM_HOSTS, [...secrets, longToken]);
        // `fields=user_id,username` — UNVERIFIED (hujjat faqat /me ni eslatadi).
        const me = await getJson(http3, deps, instagramUrl("me", { fields: "user_id,username", access_token: longToken }));
        return build(longToken, typeof longRes.expires_in === "number" ? longRes.expires_in : null, me, now);
      },
      async refresh(deps: ProviderDeps, _creds: ClientCredentials, account: ConnectedAccount): Promise<ConnectedAccount> {
        const now = nowOf(deps);
        const http = new HostClient(deps, INSTAGRAM_HOSTS, [account.accessToken]);
        const res = await getJson(http, deps, `${INSTAGRAM_REFRESH_URL}?${toGraphForm({ grant_type: "ig_refresh_token", access_token: account.accessToken })}`);
        const token = str(res.access_token);
        if (!token) throw new DistributionError({ kind: "validation_rejected", message: "Instagram yangilangan token qaytarmadi" });
        return build(token, typeof res.expires_in === "number" ? res.expires_in : null, {}, now, account);
      },
    },

    tokenStatus: (account, now) => getTokenStatus(account, GRAPH_TOKEN_POLICY, now),
    renderDefaultText: renderText,
    measureText: codePointLength,

    preflight(input: PreflightInput): ChannelCheck[] {
      const text = input.text ?? renderText(input.post);
      const out: ChannelCheck[] = [textCheck({ text, used: codePointLength(text), limit: INSTAGRAM_CAPTION_MAX, unitLabel: "belgi" })];
      const tagCount = (text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
      out.push(check({ id: "text.hashtags", group: "text", status: tagCount > INSTAGRAM_HASHTAG_MAX ? "error" : "ok", title: "Hashtag'lar", message: tagCount > INSTAGRAM_HASHTAG_MAX ? "30 tadan ortiq hashtag — kamaytiring" : "Mos", value: String(tagCount), limit: String(INSTAGRAM_HASHTAG_MAX) }));
      const hasUrl = findUrls(text).length > 0;
      out.push(
        check({
          id: "text.links",
          group: "text",
          status: hasUrl ? "warn" : "ok",
          title: "Havola",
          message: hasUrl
            ? "Instagram captionida havolalar bosilmaydi — foydalanuvchi uni nusxalashi yoki profil havolasidan o'tishi kerak"
            : "Instagram captionida havolalar bosilmaydi; havola profil (bio) orqali beriladi",
        }),
      );
      if (!input.imageUrl && !input.image) {
        out.push(check({ id: "media.required", group: "media", status: "error", title: "Rasm", message: "Instagram posti uchun rasm majburiy", imageUrl: null }));
      }
      if (!input.imageUrl) {
        out.push(check({ id: "media.url", group: "media", status: "error", title: "Rasm URL", message: "Instagram rasmni o'zi yuklab oladi — rasm OMMAVIY https URL'da bo'lishi shart (JPEG)" }));
      } else if (!isPublicHttpsUrl(input.imageUrl)) {
        out.push(check({ id: "media.url", group: "media", status: "error", title: "Rasm URL", message: "Rasm URL ommaviy https bo'lishi shart (localhost, ichki tarmoq va http mumkin emas)", value: input.imageUrl, imageUrl: input.imageUrl }));
      } else {
        out.push(check({ id: "media.url", group: "media", status: "ok", title: "Rasm URL", message: "Ommaviy https URL", value: input.imageUrl, imageUrl: input.imageUrl }));
      }
      if (input.image) {
        const img = input.image;
        out.push(check({ id: "media.format", group: "media", status: img.mime === "image/jpeg" ? "ok" : "error", title: "Rasm formati", message: img.mime === "image/jpeg" ? "JPEG" : "Instagram faqat JPEG qabul qiladi — rasmni JPEG'ga o'tkazing (bu yerda konvertatsiya yo'q)", value: img.mime, limit: "image/jpeg" }));
        out.push(check({ id: "media.size", group: "media", status: img.sizeBytes <= INSTAGRAM_IMAGE_MAX_BYTES ? "ok" : "error", title: "Fayl hajmi", message: img.sizeBytes <= INSTAGRAM_IMAGE_MAX_BYTES ? "Mos" : "Rasm 8 MB dan katta — siqing", value: fmtBytes(img.sizeBytes), limit: "8 MB" }));
        const ratio = img.width / Math.max(1, img.height);
        const okRatio = ratio >= INSTAGRAM_ASPECT_MIN - 1e-9 && ratio <= INSTAGRAM_ASPECT_MAX + 1e-9;
        out.push(check({ id: "media.aspect", group: "media", status: okRatio ? "ok" : "error", title: "Nisbat", message: okRatio ? "Mos" : "Nisbat 4:5 dan 1.91:1 gacha bo'lishi kerak — qirqing", value: `${ratio.toFixed(2)}:1`, limit: "0.80 – 1.91" }));
        const okW = img.width >= INSTAGRAM_WIDTH_MIN && img.width <= INSTAGRAM_WIDTH_MAX;
        out.push(check({ id: "media.width", group: "media", status: okW ? "ok" : "warn", title: "Kenglik", message: okW ? "Mos" : "Kenglik 320–1440 px dan tashqarida — Instagram o'zi masshtablaydi", value: `${img.width} px`, limit: "320–1440 px" }));
      }
      return out;
    },

    async publish(ctx: ProviderContext, input: PublishInput): Promise<PublishResult> {
      const { deps, account } = ctx;
      const token = account.accessToken;
      if (!input.imageUrl) throw new DistributionError({ kind: "validation_rejected", message: "Instagram uchun ommaviy rasm URL kerak" });
      const http = new HostClient(deps, INSTAGRAM_HOSTS, [token]);
      const ref = graphRefine(deps, "Instagram");
      const form = { "Content-Type": "application/x-www-form-urlencoded" };

      const created = await http.request({
        method: "POST",
        url: instagramUrl(`${account.externalId}/media`),
        headers: form,
        body: toGraphForm(buildInstagramContainerParams({ imageUrl: input.imageUrl, caption: input.text, alt: input.image?.alt, accessToken: token })),
        mode: "safe_write",
      });
      if (created.status < 200 || created.status >= 300) throw http.fail(created, "safe_write", ref);
      const containerId = str(asRecord(created.json).id);
      if (!containerId) throw new DistributionError({ kind: "validation_rejected", message: "Instagram konteyner id qaytarmadi" });

      const state = await pollContainer(
        deps,
        async (): Promise<ContainerState> => {
          const j = await getJson(http, deps, instagramUrl(containerId, { fields: "status_code", access_token: token }));
          const code = str(j.status_code);
          if (code === "FINISHED") return "ready";
          if (code === "ERROR" || code === "EXPIRED") throw new DistributionError({ kind: "validation_rejected", message: `Instagram konteyner holati: ${code}` });
          if (code === "PUBLISHED") throw new DistributionError({ kind: "outcome_unknown", message: "Instagram konteyneri allaqachon chop etilgan — qayta urinmang" });
          return "pending";
        },
        schedule,
      );
      if (state !== "ready") throw new DistributionError({ kind: "transient", message: `Instagram konteyneri tayyor bo'lmadi (kutish tugadi); konteyner id ${containerId}` });

      const pub = await http.request({
        method: "POST",
        url: instagramUrl(`${account.externalId}/media_publish`),
        headers: form,
        body: toGraphForm({ creation_id: containerId, access_token: token }),
        mode: "create",
      });
      if (pub.status < 200 || pub.status >= 300) throw http.fail(pub, "create", ref);
      const id = str(asRecord(pub.json).id);
      if (!id) throw new DistributionError({ kind: "outcome_unknown", status: pub.status, message: "Instagram post id qaytarmadi — qayta urinmang, profilni tekshiring" });

      let url: string | null = null;
      try {
        const j = await getJson(http, deps, instagramUrl(id, { fields: "permalink", access_token: token }));
        url = str(j.permalink) ?? null; // UNVERIFIED maydon
      } catch {
        url = null;
      }
      return { externalId: id, url };
    },
  };
  return provider;
}
