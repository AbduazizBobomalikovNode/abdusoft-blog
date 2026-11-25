import type { ChannelCheck } from "@blog/shared";
import { DistributionError } from "../errors.js";
import { asRecord, HostClient, str, type ProviderDeps } from "../http.js";
import { check, fmtBytes, isPublicHttpsUrl, textCheck } from "../checks.js";
import { codePointLength, findUrls, graphemes, normalizeUzbekApostrophes, fitParts, utf8Length } from "../text.js";
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
 * Threads. Hujjatlar 2026-11-25 da developers.facebook.com dan o'qilgan; sahifalarda SANA ko'rsatilmagan.
 *
 * MUHIM: joriy hujjat `threads.com` (authorize) va `graph.threads.com` (API) hostlarini ishlatadi; `threads.net` /
 * `graph.threads.net` eski hostlar (ularning hozirgi holati tekshirilmadi — UNVERIFIED), shuning uchun ishlatilmaydi.
 *
 *  - Boshlash/token: https://developers.facebook.com/docs/threads/get-started/get-access-tokens-and-permissions (sana yo'q)
 *  - Uzoq muddatli token / yangilash: https://developers.facebook.com/docs/threads/get-started/long-lived-tokens (sana yo'q)
 *  - Post yaratish: https://developers.facebook.com/docs/threads/posts (sana yo'q; API prefiksi `/v1.0/`)
 *  - O'chirish: https://developers.facebook.com/documentation/threads/posts/delete-posts (sana yo'q)
 *  - Profil: https://developers.facebook.com/documentation/threads/threads-profiles (sana yo'q)
 *  - Muammolar/holat/limit: https://developers.facebook.com/docs/threads/troubleshooting (sana yo'q)
 */

export const THREADS_AUTHORIZE_URL = "https://threads.com/oauth/authorize";
export const THREADS_API_BASE = "https://graph.threads.com";
export const THREADS_API_VERSION = "v1.0";
/** Qisqa muddatli token: POST (client_id, client_secret, code, grant_type=authorization_code, redirect_uri). */
export const THREADS_TOKEN_URL = `${THREADS_API_BASE}/oauth/access_token`;
/** Uzoq muddatli (60 kun): GET ?grant_type=th_exchange_token&client_secret&access_token. */
export const THREADS_LONG_LIVED_URL = `${THREADS_API_BASE}/access_token`;
/** Yangilash: GET ?grant_type=th_refresh_token&access_token (token >= 24 soat eski va amal qilayotgan bo'lishi kerak). */
export const THREADS_REFRESH_URL = `${THREADS_API_BASE}/refresh_access_token`;
export const THREADS_HOSTS = ["graph.threads.com"] as const;

/** `threads_delete` — o'chirish uchun hujjat talab qiladi (delete-posts sahifasi). */
export const THREADS_SCOPES = ["threads_basic", "threads_content_publish", "threads_delete"] as const;
/** 500 belgi; emoji UTF-8 bayt soni bo'yicha sanaladi (posts sahifasi). Havola belgilari hisobga kiradimi — UNVERIFIED. */
export const THREADS_TEXT_MAX = 500;
/** Rasm: JPEG/PNG, 8 MB, nisbat <= 10:1, kenglik >= 320 px (posts sahifasi). */
export const THREADS_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const THREADS_IMAGE_MIMES = ["image/jpeg", "image/png"] as const;
/** 250 post / 24 soat (troubleshooting sahifasi). */
export const THREADS_POSTS_PER_DAY = 250;

const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

/** Threads hisobi: oddiy belgi = 1 code point; emoji = UTF-8 bayt soni ("Emojis count as their UTF-8 byte count"). */
export function threadsLength(text: string): number {
  let n = 0;
  for (const g of graphemes(text)) n += EMOJI_RE.test(g) && !/^[0-9#*]$/.test(g) ? utf8Length(g) : codePointLength(g);
  return n;
}

export function threadsUrl(path: string, query?: Record<string, string>): string {
  const u = new URL(`${THREADS_API_BASE}/${THREADS_API_VERSION}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, v);
  return u.toString();
}

/** Sof: konteyner yaratish tanasi (form). `link_attachment` faqat TEXT postlarda; IMAGE bilan ishlamaydi. */
export function buildThreadsContainerParams(input: { text: string; linkUrl?: string; imageUrl?: string; accessToken: string }): Record<string, string> {
  if (input.imageUrl) return { media_type: "IMAGE", image_url: input.imageUrl, text: input.text, access_token: input.accessToken };
  return {
    media_type: "TEXT",
    text: input.text,
    ...(input.linkUrl ? { link_attachment: input.linkUrl } : {}),
    access_token: input.accessToken,
  };
}

function renderText(post: DistributionPost, opts: RenderOptions = {}): string {
  void opts;
  // Havola `link_attachment` orqali beriladi (matnga qo'shilmaydi); hashtag yo'q (Threads bitta topic_tag ishlatadi).
  const title = normalizeUzbekApostrophes(post.title.trim());
  const excerpt = post.excerpt ? normalizeUzbekApostrophes(post.excerpt.trim()) : "";
  return fitParts({ title, optional: [{ key: "excerpt", text: excerpt }] }, THREADS_TEXT_MAX, threadsLength);
}

export interface ThreadsOptions {
  pollScheduleMs?: readonly number[];
}

export function createThreadsProvider(options: ThreadsOptions = {}): DistributionProvider {
  const schedule = options.pollScheduleMs ?? DEFAULT_POLL_SCHEDULE_MS;
  const nowOf = (deps: ProviderDeps) => deps.now?.() ?? new Date();

  async function getJson(http: HostClient, deps: ProviderDeps, url: string, mode: "read" = "read") {
    const res = await http.request({ method: "GET", url, mode });
    if (res.status < 200 || res.status >= 300) throw http.fail(res, mode, graphRefine(deps, "Threads"));
    return asRecord(res.json);
  }

  async function fetchMe(deps: ProviderDeps, token: string, secrets: string[]) {
    const http = new HostClient(deps, THREADS_HOSTS, [token, ...secrets]);
    return getJson(http, deps, threadsUrl("me", { fields: "id,username,name", access_token: token }));
  }

  function build(token: string, expiresIn: number | null, me: Record<string, unknown>, now: Date, prev?: ConnectedAccount): ConnectedAccount {
    const id = str(me.id) ?? prev?.externalId;
    if (!id) throw new DistributionError({ kind: "validation_rejected", message: "Threads /me javobida id yo'q" });
    return {
      provider: "threads",
      externalId: id,
      displayName: str(me.name) ?? str(me.username) ?? prev?.displayName ?? id,
      username: str(me.username) ?? prev?.username,
      accessToken: token,
      refreshToken: null,
      accessTokenExpiresAt: expiresIn === null ? null : new Date(now.getTime() + expiresIn * 1000),
      refreshTokenExpiresAt: null,
      scopes: prev?.scopes ?? [...THREADS_SCOPES],
      issuedAt: now,
      connectedAt: prev?.connectedAt ?? now,
    };
  }

  const provider: DistributionProvider = {
    id: "threads",
    capabilities: { text: true, link: true, image: true, edit: false, delete: true, nativeScheduling: false },
    limits: { textMax: THREADS_TEXT_MAX, textUnit: "utf8_bytes", imageMaxBytes: THREADS_IMAGE_MAX_BYTES, imageMimes: THREADS_IMAGE_MIMES },
    tokenPolicy: GRAPH_TOKEN_POLICY,
    auth: {
      kind: "oauth_code",
      scopes: THREADS_SCOPES,
      buildAuthorizationUrl({ creds, state }: AuthorizationUrlInput): string {
        const u = new URL(THREADS_AUTHORIZE_URL);
        u.searchParams.set("client_id", creds.clientId);
        u.searchParams.set("redirect_uri", creds.redirectUri);
        u.searchParams.set("scope", THREADS_SCOPES.join(","));
        u.searchParams.set("response_type", "code");
        u.searchParams.set("state", state);
        return u.toString();
      },
      async exchangeCode(deps: ProviderDeps, { creds, code }: ExchangeCodeInput): Promise<ConnectedAccount> {
        const now = nowOf(deps);
        const secrets = [creds.clientSecret ?? "", code];
        const http = new HostClient(deps, THREADS_HOSTS, secrets);
        const short = await http.request({
          method: "POST",
          url: THREADS_TOKEN_URL,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: toGraphForm({ client_id: creds.clientId, client_secret: creds.clientSecret, code, grant_type: "authorization_code", redirect_uri: creds.redirectUri }),
          mode: "safe_write",
        });
        if (short.status < 200 || short.status >= 300) throw http.fail(short, "safe_write", graphRefine(deps, "Threads"));
        const shortToken = str(asRecord(short.json).access_token);
        if (!shortToken) throw new DistributionError({ kind: "validation_rejected", message: "Threads access_token qaytarmadi" });
        const http2 = new HostClient(deps, THREADS_HOSTS, [...secrets, shortToken]);
        const longRes = await getJson(
          http2,
          deps,
          `${THREADS_LONG_LIVED_URL}?${toGraphForm({ grant_type: "th_exchange_token", client_secret: creds.clientSecret, access_token: shortToken })}`,
        );
        const longToken = str(longRes.access_token);
        if (!longToken) throw new DistributionError({ kind: "validation_rejected", message: "Threads uzoq muddatli token qaytarmadi" });
        const me = await fetchMe(deps, longToken, secrets);
        return build(longToken, typeof longRes.expires_in === "number" ? longRes.expires_in : null, me, now);
      },
      async refresh(deps: ProviderDeps, _creds: ClientCredentials, account: ConnectedAccount): Promise<ConnectedAccount> {
        const now = nowOf(deps);
        const http = new HostClient(deps, THREADS_HOSTS, [account.accessToken]);
        const res = await getJson(http, deps, `${THREADS_REFRESH_URL}?${toGraphForm({ grant_type: "th_refresh_token", access_token: account.accessToken })}`);
        const token = str(res.access_token);
        if (!token) throw new DistributionError({ kind: "validation_rejected", message: "Threads yangilangan token qaytarmadi" });
        return build(token, typeof res.expires_in === "number" ? res.expires_in : null, {}, now, account);
      },
    },

    tokenStatus: (account, now) => getTokenStatus(account, GRAPH_TOKEN_POLICY, now),
    renderDefaultText: renderText,
    measureText: threadsLength,

    preflight(input: PreflightInput): ChannelCheck[] {
      const text = input.text ?? renderText(input.post);
      const out: ChannelCheck[] = [textCheck({ text, used: threadsLength(text), limit: THREADS_TEXT_MAX, unitLabel: "birlik" })];
      const urls = findUrls(text).length;
      if (urls > 5) out.push(check({ id: "text.links", group: "text", status: "error", title: "Havolalar", message: "Matnda 5 tadan ortiq havola bo'lmasligi kerak", value: String(urls), limit: "5" }));
      if (!isPublicHttpsUrl(input.post.url)) out.push(check({ id: "config.url", group: "config", status: "error", title: "Havola", message: "Maqola havolasi ochiq https URL bo'lishi kerak", value: input.post.url }));
      if (input.imageUrl || input.image) {
        out.push(check({ id: "media.link", group: "media", status: "warn", title: "Havola kartasi", message: "Rasmli postda havola kartasi (link_attachment) ishlamaydi — havola faqat matnda bo'ladi", value: null }));
        if (input.imageUrl && !isPublicHttpsUrl(input.imageUrl)) out.push(check({ id: "media.url", group: "media", status: "error", title: "Rasm URL", message: "Rasm ommaviy https URL bo'lishi kerak (Threads uni o'zi yuklab oladi)", value: input.imageUrl, imageUrl: input.imageUrl }));
        if (!input.imageUrl) out.push(check({ id: "media.url", group: "media", status: "error", title: "Rasm URL", message: "Rasm ommaviy https URL orqali beriladi", value: null }));
        if (input.image) {
          const img = input.image;
          const okMime = (THREADS_IMAGE_MIMES as readonly string[]).includes(img.mime);
          out.push(check({ id: "media.format", group: "media", status: okMime ? "ok" : "error", title: "Rasm formati", message: okMime ? "Format mos" : "Threads: JPEG yoki PNG kerak — rasmni o'tkazing (bu yerda konvertatsiya yo'q)", value: img.mime, limit: "jpeg, png" }));
          out.push(check({ id: "media.size", group: "media", status: img.sizeBytes <= THREADS_IMAGE_MAX_BYTES ? "ok" : "error", title: "Fayl hajmi", message: img.sizeBytes <= THREADS_IMAGE_MAX_BYTES ? "Mos" : "Rasm 8 MB dan katta — siqing", value: fmtBytes(img.sizeBytes), limit: "8 MB" }));
          const ratio = Math.max(img.width, img.height) / Math.max(1, Math.min(img.width, img.height));
          out.push(check({ id: "media.aspect", group: "media", status: ratio <= 10 ? "ok" : "error", title: "Nisbat", message: ratio <= 10 ? "Mos" : "Nisbat 10:1 dan oshmasligi kerak — qirqing", value: `${ratio.toFixed(1)}:1`, limit: "10:1" }));
          out.push(check({ id: "media.width", group: "media", status: img.width >= 320 ? "ok" : "error", title: "Kenglik", message: img.width >= 320 ? "Mos" : "Kenglik kamida 320 px", value: `${img.width} px`, limit: "≥ 320 px" }));
        }
      }
      return out;
    },

    async publish(ctx: ProviderContext, input: PublishInput): Promise<PublishResult> {
      const { deps, account } = ctx;
      const token = account.accessToken;
      const http = new HostClient(deps, THREADS_HOSTS, [token]);
      const ref = graphRefine(deps, "Threads");
      const form = { "Content-Type": "application/x-www-form-urlencoded" };

      // 1) Konteyner (xavfsiz: yetim konteyner 24 soatda tugaydi).
      const created = await http.request({
        method: "POST",
        url: threadsUrl(`${account.externalId}/threads`),
        headers: form,
        body: toGraphForm(buildThreadsContainerParams({ text: input.text, linkUrl: input.imageUrl ? undefined : input.post.url, imageUrl: input.imageUrl, accessToken: token })),
        mode: "safe_write",
      });
      if (created.status < 200 || created.status >= 300) throw http.fail(created, "safe_write", ref);
      const containerId = str(asRecord(created.json).id);
      if (!containerId) throw new DistributionError({ kind: "validation_rejected", message: "Threads konteyner id qaytarmadi" });

      // 2) Holatni chegaralangan kutish bilan so'rash.
      const state = await pollContainer(
        deps,
        async (): Promise<ContainerState> => {
          const j = await getJson(http, deps, threadsUrl(containerId, { fields: "status,error_message", access_token: token }));
          const status = str(j.status);
          if (status === "FINISHED") return "ready";
          if (status === "ERROR" || status === "EXPIRED") throw new DistributionError({ kind: "validation_rejected", platformMessage: str(j.error_message), message: `Threads konteyner holati: ${status}` });
          return "pending";
        },
        schedule,
      );
      if (state !== "ready") throw new DistributionError({ kind: "transient", message: `Threads konteyneri tayyor bo'lmadi (kutish tugadi); konteyner id ${containerId}` });

      // 3) Chop etish (create).
      const pub = await http.request({
        method: "POST",
        url: threadsUrl(`${account.externalId}/threads_publish`),
        headers: form,
        body: toGraphForm({ creation_id: containerId, access_token: token }),
        mode: "create",
      });
      if (pub.status < 200 || pub.status >= 300) throw http.fail(pub, "create", ref);
      const id = str(asRecord(pub.json).id);
      if (!id) throw new DistributionError({ kind: "outcome_unknown", status: pub.status, message: "Threads post id qaytarmadi — qayta urinmang, profilni tekshiring" });

      // 4) Havola (permalink) — UNVERIFIED maydon; xato bo'lsa jim o'tkazib yuboriladi (post allaqachon chiqqan).
      let url: string | null = null;
      try {
        const j = await getJson(http, deps, threadsUrl(id, { fields: "permalink", access_token: token }));
        url = str(j.permalink) ?? null;
      } catch {
        url = null;
      }
      return { externalId: id, url };
    },

    async remove(ctx: ProviderContext, externalId: string): Promise<void> {
      const token = ctx.account.accessToken;
      const http = new HostClient(ctx.deps, THREADS_HOSTS, [token]);
      const res = await http.request({ method: "DELETE", url: threadsUrl(externalId, { access_token: token }), mode: "safe_write" });
      if (res.status < 200 || res.status >= 300) throw http.fail(res, "safe_write", graphRefine(ctx.deps, "Threads"));
    },
  };
  return provider;
}
