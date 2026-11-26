import type { ChannelCheck } from "@blog/shared";
import { DistributionError, notSupported } from "../errors.js";
import { asRecord, HostClient, str, type ProviderDeps } from "../http.js";
import { assertPublicHttpsUrl, check, fmtBytes, isPublicHttpsUrl, textCheck } from "../checks.js";
import { codePointLength, findUrls, fitParts, normalizeUzbekApostrophes, toHashtags } from "../text.js";
import { DAY_MS, getTokenStatus, type TokenPolicy } from "../token-status.js";
import { DEFAULT_POLL_SCHEDULE_MS, graphRefine, pollContainer, toGraphForm, type ContainerState } from "./graph.js";
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
 * Instagram (Instagram API with Unified Login — Facebook Login for Business). Hujjatlar 2026-11-26 da developers.facebook.com dan o'qilgan
 * (sahifalarda sana ko'rsatilmagan). Graph versiyasi: hujjat misollarida `v27.0` — BITTA sozlama (`INSTAGRAM_DEFAULT_GRAPH_VERSION`,
 * env `DISTRIBUTION_INSTAGRAM_GRAPH_VERSION`).
 *
 *  - get-started: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/get-started
 *    (login URL parametrlari, kod -> token, `assigned_instagram_accounts`, `client_business_id`, ruxsatlar)
 *  - authentication: .../instagram-api-with-unified-login/authentication (token turi, muddat konfiguratsiyaga bog'liq, qayta ulash qoidasi)
 *  - migration: .../instagram-api-with-unified-login/migration (host `graph.facebook.com`, Instagram akkaunt id bilan so'rovlar)
 *  - Kontent chop etish: https://developers.facebook.com/documentation/instagram-platform/content-publishing (konteyner, status_code, media_publish)
 *  - Facebook Login for Business: .../facebook-login/facebook-login-for-business (BISU token "Defaults to never expire")
 *  - Qo'lda login oqimi: https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow (`state` qaytadi, bekor qilishda `error=access_denied`)
 *
 * Eski "Instagram API with Instagram Login" (`instagram.com/oauth/authorize`, `instagram_business_*`, `graph.instagram.com`) yangi ilovalarga berilmaydi.
 */

export const INSTAGRAM_DIALOG_URL = "https://www.facebook.com/dialog/oauth";
export const INSTAGRAM_GRAPH_HOST = "graph.facebook.com";
export const INSTAGRAM_GRAPH_BASE = `https://${INSTAGRAM_GRAPH_HOST}`;
/** Graph versiyasining yagona standart qiymati (env: `DISTRIBUTION_INSTAGRAM_GRAPH_VERSION`). */
export const INSTAGRAM_DEFAULT_GRAPH_VERSION = "v27.0";
export const INSTAGRAM_HOSTS = [INSTAGRAM_GRAPH_HOST] as const;

/** Ruxsatlar KONFIGURATSIYA ichida (login URL'da `scope` YO'Q). Majburiy: basic + manage_messages; chop etish uchun content_publish. */
export const INSTAGRAM_SCOPES = ["instagram_basic", "instagram_manage_messages", "instagram_content_publish"] as const;
export const INSTAGRAM_REASON = {
  noAccount: "no_instagram_account",
  configInvalid: "config_invalid",
  accountLookupFailed: "account_lookup_failed",
  multipleAccounts: "multiple_instagram_accounts",
} as const;

/** Meta id'lari URL yo'liga qo'yiladi: faqat raqamlar, chegaralangan uzunlik (yo'l/so'rov belgilari kirib kelmasin). */
export const GRAPH_ID_RE = /^\d{1,32}$/;
export const isGraphId = (v: unknown): v is string => typeof v === "string" && GRAPH_ID_RE.test(v);
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

export function instagramUrl(path: string, query?: Record<string, string>, version: string = INSTAGRAM_DEFAULT_GRAPH_VERSION): string {
  const u = new URL(`${INSTAGRAM_GRAPH_BASE}/${version}/${path.replace(/^\//, "")}`);
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
  /** Graph versiyasi (standart `v27.0`). Shakli `v<son>.<son>`; noto'g'ri bo'lsa standart ishlatiladi. */
  graphVersion?: string;
  /** Kod almashtirishda `redirect_uri` yuboriladimi. Standart true (qo'lda login hujjati: majburiy; Unified Login hujjati: ro'yxatda yo'q). */
  exchangeRedirectUri?: boolean;
}

/** Unified Login tizim foydalanuvchisi tokeni: muddat konfiguratsiyaga bog'liq; javobda `expires_in` bo'lmasa — tugamaydi (null). */
export const INSTAGRAM_TOKEN_POLICY: TokenPolicy = {
  refresh: "none",
  warnBeforeMs: 7 * DAY_MS,
  remindBeforeMs: 10 * DAY_MS,
  refreshLeadMs: 0,
  nonExpiringWhenNoExpiry: true,
};

const GRAPH_VERSION_RE = /^v\d{1,3}\.\d{1,2}$/;

export function createInstagramProvider(options: InstagramOptions = {}): DistributionProvider {
  const schedule = options.pollScheduleMs ?? DEFAULT_POLL_SCHEDULE_MS;
  const version = options.graphVersion && GRAPH_VERSION_RE.test(options.graphVersion) ? options.graphVersion : INSTAGRAM_DEFAULT_GRAPH_VERSION;
  const sendRedirectUri = options.exchangeRedirectUri ?? true;
  const graphUrl = (path: string, query?: Record<string, string>) => instagramUrl(path, query, version);
  const nowOf = (deps: ProviderDeps) => deps.now?.() ?? new Date();

  async function getJson(http: HostClient, deps: ProviderDeps, target: string) {
    const res = await http.request({ method: "GET", url: target, mode: "read" });
    if (res.status < 200 || res.status >= 300) throw http.fail(res, "read", graphRefine(deps, "Instagram"));
    return asRecord(res.json);
  }

  /** Meta xabari konfiguratsiyaga ishora qilsa (noto'g'ri/o'chirilgan `config_id`) — alohida sabab kodi. Matn bo'yicha taxmin: UNVERIFIED. */
  function withConfigReason(e: DistributionError): DistributionError {
    return /config/i.test(`${e.platformMessage ?? ""}`) ? new DistributionError({ kind: e.kind, message: e.message, status: e.status, platformMessage: e.platformMessage, reason: INSTAGRAM_REASON.configInvalid }) : e;
  }

  const provider: DistributionProvider = {
    id: "instagram",
    capabilities: { text: true, link: false, image: true, edit: false, delete: false, nativeScheduling: false, notes: { delete: "Instagram Graph API postni o'chirishni qo'llamaydi (hujjatda o'chirish yo'q — UNVERIFIED)", edit: "Postni tahrirlash API'da yo'q" } },
    limits: { textMax: INSTAGRAM_CAPTION_MAX, textUnit: "characters", imageMaxBytes: INSTAGRAM_IMAGE_MAX_BYTES, imageMimes: ["image/jpeg"] },
    tokenPolicy: INSTAGRAM_TOKEN_POLICY,
    auth: {
      kind: "oauth_code",
      scopes: INSTAGRAM_SCOPES,
      buildAuthorizationUrl({ creds, state }: AuthorizationUrlInput): string {
        if (!creds.configId) throw new DistributionError({ kind: "validation_rejected", message: "Instagram: Config ID kiritilmagan", reason: INSTAGRAM_REASON.configInvalid });
        const u = new URL(INSTAGRAM_DIALOG_URL);
        u.searchParams.set("client_id", creds.clientId);
        u.searchParams.set("config_id", creds.configId);
        u.searchParams.set("redirect_uri", creds.redirectUri);
        u.searchParams.set("response_type", "code");
        // `scope` YO'Q: ruxsatlar konfiguratsiyada. `state` — o'z CSRF himoyamiz (Facebook uni o'zgarishsiz qaytaradi).
        u.searchParams.set("state", state);
        return u.toString();
      },
      async exchangeCode(deps: ProviderDeps, { creds, code }: ExchangeCodeInput): Promise<ConnectedAccount> {
        const now = nowOf(deps);
        const secrets = [creds.clientSecret ?? "", code];
        const http = new HostClient(deps, INSTAGRAM_HOSTS, secrets);
        const res = await http.request({
          method: "GET",
          url: graphUrl("oauth/access_token", {
            client_id: creds.clientId,
            client_secret: creds.clientSecret ?? "",
            code,
            ...(sendRedirectUri ? { redirect_uri: creds.redirectUri } : {}),
          }),
          mode: "safe_write",
        });
        if (res.status < 200 || res.status >= 300) throw withConfigReason(http.fail(res, "safe_write", graphRefine(deps, "Instagram")));
        const tj = asRecord(res.json);
        const token = str(tj.access_token);
        if (!token) throw new DistributionError({ kind: "validation_rejected", message: "Instagram access_token qaytarmadi" });
        // `expires_in` bo'lmasa token tugamaydi (null) — hujjat: "Never" (standart konfiguratsiya); bor bo'lsa muddat saqlanadi.
        const expiresIn = typeof tj.expires_in === "number" && tj.expires_in > 0 ? tj.expires_in : null;
        const http2 = new HostClient(deps, INSTAGRAM_HOSTS, [...secrets, token]);
        let list: Record<string, unknown>;
        try {
          list = await getJson(http2, deps, graphUrl("me/assigned_instagram_accounts", { fields: "id,username", access_token: token }));
        } catch (e) {
          throw e instanceof DistributionError ? new DistributionError({ kind: e.kind, message: e.message, status: e.status, platformMessage: e.platformMessage, reason: INSTAGRAM_REASON.accountLookupFailed }) : e;
        }
        const accounts = (Array.isArray(list.data) ? list.data : []).map(asRecord).filter((a) => a.id !== undefined && a.id !== null && a.id !== "");
        const first = accounts[0];
        if (!first) throw new DistributionError({ kind: "validation_rejected", message: "Instagram: tizim foydalanuvchisiga biriktirilgan Instagram akkaunt topilmadi", reason: INSTAGRAM_REASON.noAccount });
        // Bir nechta akkaunt: jim birinchisini olmaymiz — ulanish rad etiladi (foydalanuvchi nomlari faqat xavfsiz xabarda/auditda).
        if (accounts.length > 1) {
          const names = accounts.slice(0, 5).map((a) => `@${str(a.username) ?? "?"}`).join(", ");
          throw new DistributionError({ kind: "validation_rejected", message: `Instagram: konfiguratsiya bir nechta akkauntga ruxsat beradi (${names}) — bittasini tanlang`, reason: INSTAGRAM_REASON.multipleAccounts });
        }
        if (!isGraphId(first.id)) throw new DistributionError({ kind: "validation_rejected", message: "Instagram akkaunt id'si noto'g'ri shaklda (faqat raqamlar kutilgan) — so'rov yuborilmadi", reason: INSTAGRAM_REASON.accountLookupFailed });
        const id = first.id;
        // client_business_id: token boshqaruvi API'si uchun kerak; chop etish unga bog'liq emas -> olinmasa ulanish to'xtamaydi.
        let clientBusinessId: string | undefined;
        try {
          clientBusinessId = str((await getJson(http2, deps, graphUrl("me", { fields: "client_business_id", access_token: token }))).client_business_id);
        } catch {
          clientBusinessId = undefined;
        }
        const username = str(first.username);
        return {
          provider: "instagram",
          externalId: id,
          displayName: username ?? id,
          username,
          accessToken: token,
          refreshToken: null,
          accessTokenExpiresAt: expiresIn === null ? null : new Date(now.getTime() + expiresIn * 1000),
          refreshTokenExpiresAt: null,
          scopes: [...INSTAGRAM_SCOPES],
          issuedAt: now,
          connectedAt: now,
          meta: { ...(clientBusinessId ? { clientBusinessId } : {}) },
        };
      },
    },

    tokenStatus: (account, now) => getTokenStatus(account, INSTAGRAM_TOKEN_POLICY, now),
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
      assertPublicHttpsUrl(input.post.url, "Maqola havolasi");
      const resumeId = input.resume?.containerId;
      if (resumeId !== undefined && !isGraphId(resumeId)) throw new DistributionError({ kind: "validation_rejected", step: "container", message: "Instagram konteyner id'si noto'g'ri shaklda — so'rov yuborilmadi" });
      if (!input.imageUrl && !resumeId) throw new DistributionError({ kind: "validation_rejected", message: "Instagram uchun ommaviy rasm URL kerak" });
      const imageUrl = input.imageUrl ? assertPublicHttpsUrl(input.imageUrl, "Rasm URL") : undefined;
      const http = new HostClient(deps, INSTAGRAM_HOSTS, [token]);
      const ref = graphRefine(deps, "Instagram");
      const form = { "Content-Type": "application/x-www-form-urlencoded" };

      let containerId = resumeId;
      if (!containerId) {
        const created = await http.request({
          method: "POST",
          url: graphUrl(`${account.externalId}/media`),
          headers: form,
          body: toGraphForm(buildInstagramContainerParams({ imageUrl: imageUrl as string, caption: input.text, alt: input.image?.alt, accessToken: token })),
          mode: "safe_write",
        });
        if (created.status < 200 || created.status >= 300) throw http.fail(created, "safe_write", ref).with({ step: "container" });
        const rawId = asRecord(created.json).id;
        if (rawId === undefined || rawId === null || rawId === "") throw new DistributionError({ kind: "validation_rejected", step: "container", message: "Instagram konteyner id qaytarmadi" });
        // Konteyner YARATILGAN bo'lishi mumkin, lekin id'si yaroqsiz — keyingi so'rovlar yo'liga qo'yilmaydi.
        if (!isGraphId(rawId)) throw new DistributionError({ kind: "validation_rejected", step: "container", message: "Instagram konteyner id'si noto'g'ri shaklda (faqat raqamlar kutilgan) — keyingi so'rov yuborilmadi" });
        containerId = rawId;
      }
      const partial = { containerId };
      const cid = containerId;

      const state = await pollContainer(
        deps,
        async (): Promise<ContainerState> => {
          const j = await getJson(http, deps, graphUrl(cid, { fields: "status_code", access_token: token }));
          const code = str(j.status_code);
          if (code === "FINISHED") return "ready";
          if (code === "ERROR" || code === "EXPIRED") throw new DistributionError({ kind: "validation_rejected", message: `Instagram konteyner holati: ${code}` });
          if (code === "PUBLISHED") throw new DistributionError({ kind: "outcome_unknown", message: "Instagram konteyneri allaqachon chop etilgan — qayta urinmang" });
          return "pending";
        },
        schedule,
      ).catch((e: unknown) => {
        throw e instanceof DistributionError ? e.with({ step: "poll", partial }) : e;
      });
      if (state !== "ready") throw new DistributionError({ kind: "transient", step: "poll", partial, message: `Instagram konteyneri tayyor bo'lmadi (kutish tugadi); resume.containerId=${containerId} bilan davom eting` });

      try {
        const pub = await http.request({
          method: "POST",
          url: graphUrl(`${account.externalId}/media_publish`),
          headers: form,
          body: toGraphForm({ creation_id: containerId, access_token: token }),
          mode: "create",
        });
        if (pub.status < 200 || pub.status >= 300) throw http.fail(pub, "create", ref);
        const id = str(asRecord(pub.json).id);
        if (!id) throw new DistributionError({ kind: "outcome_unknown", status: pub.status, message: "Instagram post id qaytarmadi — qayta urinmang, profilni tekshiring" });
        // Post YARATILGAN (media_publish 2xx), id yaroqsiz: yo'lga qo'ymaymiz va `outcome_unknown` (qayta urinmaslik: dublikat xavfi).
        if (!isGraphId(id)) throw new DistributionError({ kind: "outcome_unknown", status: pub.status, message: "Instagram post id'si noto'g'ri shaklda — post chiqqan bo'lishi mumkin, qayta urinmang, profilni tekshiring" });

        let url: string | null = null;
        try {
          const j = await getJson(http, deps, graphUrl(id, { fields: "permalink", access_token: token }));
          url = str(j.permalink) ?? null; // UNVERIFIED maydon
        } catch {
          url = null;
        }
        return { externalId: id, url };
      } catch (e) {
        throw e instanceof DistributionError ? e.with({ step: "publish", partial }) : e;
      }
    },

    async remove(): Promise<void> {
      throw notSupported("Instagram postini o'chirish", "API buni qo'llamaydi");
    },
  };
  return provider;
}
