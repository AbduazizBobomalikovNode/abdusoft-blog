import type { ChannelCheck } from "@blog/shared";
import { DistributionError, notSupported } from "../errors.js";
import { asRecord, HostClient, str, type HttpResponse, type ProviderDeps } from "../http.js";
import { assertPublicHttpsUrl, check, isPublicHttpsUrl } from "../checks.js";
import { codePointLength } from "../text.js";
import { DAY_MS, getTokenStatus, type TokenPolicy } from "../token-status.js";
import type {
  ConnectedAccount,
  DistributionPost,
  DistributionProvider,
  PreflightInput,
  ProviderContext,
  PublishInput,
  PublishResult,
} from "../types.js";

/**
 * GitHub profil README ("so'nggi maqolalar" bloki). Hujjatlar 2026-11-25 da docs.github.com dan o'qilgan;
 * sahifalarda nashr sanasi yo'q, REST versiyasi `2026-03-10` ko'rsatilgan.
 *
 *  - Contents: https://docs.github.com/en/rest/repos/contents (REST 2026-03-10)
 *  - Versiyalar: https://docs.github.com/en/rest/about-the-rest-api/api-versions (2026-03-10 eng yangi; 2022-11-28 — 2028-03-10 gacha)
 *  - Sarlavhalar/User-Agent: https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api
 *  - Fine-grained token: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
 *      (muddat 1..366 kun yoki cheksiz; bitta repo tanlash mumkin; Contents read/write)
 *  - Ruxsatlar: https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
 *  - Profil README: https://docs.github.com/en/account-and-profile/how-tos/profile-customization/managing-your-profile-readme
 *  - Limitlar: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
 *  - GET /user: https://docs.github.com/en/rest/users/users#get-the-authenticated-user
 */

export const GITHUB_API_BASE = "https://api.github.com";
export const GITHUB_USER_URL = `${GITHUB_API_BASE}/user`;
export const GITHUB_HOSTS = ["api.github.com"] as const;
export const GITHUB_API_VERSION = "2026-03-10";
export const GITHUB_USER_AGENT = "blog-distribution";

export const GITHUB_DEFAULT_START_MARKER = "<!-- BLOG-POSTS:START -->";
export const GITHUB_DEFAULT_END_MARKER = "<!-- BLOG-POSTS:END -->";
/** Contents API: 1 MB gacha to'liq qo'llab-quvvatlanadi; kattasi `content: ""` qaytaradi. */
export const GITHUB_MAX_README_BYTES = 1024 * 1024;

/** Yopishtirilgan token: dasturiy yangilash yo'q. Muddati sarlavhadan (UNVERIFIED) yoki noma'lum. */
export const GITHUB_TOKEN_POLICY: TokenPolicy = {
  refresh: "none",
  warnBeforeMs: 7 * DAY_MS,
  remindBeforeMs: 14 * DAY_MS,
  refreshLeadMs: 0,
};

export type MarkerPosition = "start" | "end" | { afterLine: string };

export interface GithubOptions {
  /** Standart: token egasining login'i (profil README repo'si `login/login`). */
  owner?: string;
  repo?: string;
  path?: string;
  branch?: string;
  startMarker?: string;
  endMarker?: string;
  /** README'dagi maqolalar soni. */
  limit?: number;
  /** Markerlar yo'q bo'lsa — FAQAT shu berilsa yaratiladi (aks holda xato). */
  createMarkersAt?: MarkerPosition;
  commitMessage?: string;
}

export function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": GITHUB_USER_AGENT,
  };
}

export function contentsUrl(owner: string, repo: string, path: string, ref?: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const u = new URL(`${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encoded}`);
  if (ref) u.searchParams.set("ref", ref);
  return u.toString();
}

function mdEscape(s: string): string {
  return s.replace(/[\r\n]+/g, " ").replace(/([\\[\]`*_<>|])/g, "\\$1").trim();
}

function fmtDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

export function renderReadmeItem(post: DistributionPost): string {
  // Havola tahlil qilingan `href` dan quriladi: yangi qator/bo'shliq bilan ro'yxat elementidan "chiqib ketish" mumkin emas.
  const url = assertPublicHttpsUrl(post.url, "Maqola havolasi").replace(/\(/g, "%28").replace(/\)/g, "%29");
  return `- [${mdEscape(post.title)}](${url})${post.publishedAt ? ` — ${fmtDate(post.publishedAt)}` : ""}`;
}

export function renderReadmeList(posts: readonly DistributionPost[], limit: number, eol = "\n"): string {
  return posts.slice(0, Math.max(0, limit)).map(renderReadmeItem).join(eol);
}

export interface SpliceResult {
  content: Buffer;
  changed: boolean;
  createdMarkers: boolean;
}

function detectEol(buf: Buffer): string {
  const i = buf.indexOf("\n");
  return i > 0 && buf[i - 1] === 0x0d ? "\r\n" : "\n";
}

/**
 * Ikki HTML-izoh marker orasidagi qismni almashtiradi. Qolgan baytlar O'ZGARMAYDI (Buffer darajasida — BOM, CRLF,
 * boshqa kodlash qismlari ham saqlanadi). Markerlar yo'q bo'lsa: `createAt` berilmagan bo'lsa xato; berilgan bo'lsa shu joyga yaratiladi.
 */
export function spliceMarkedBlock(
  original: Buffer,
  list: string,
  opts: { startMarker: string; endMarker: string; createAt?: MarkerPosition },
): SpliceResult {
  const start = Buffer.from(opts.startMarker, "utf8");
  const end = Buffer.from(opts.endMarker, "utf8");
  const s = original.indexOf(start);
  const e = s >= 0 ? original.indexOf(end, s + start.length) : original.indexOf(end);
  const eol = detectEol(original);
  const body = list ? `${eol}${list.replace(/\n/g, eol)}${eol}` : eol;

  if (s >= 0 && e >= 0) {
    if (original.indexOf(start, s + start.length) >= 0 || original.indexOf(end, e + end.length) >= 0) {
      throw new DistributionError({ kind: "validation_rejected", message: "README'da marker bir necha marta uchraydi — bittadan qoldiring" });
    }
    const next = Buffer.concat([original.subarray(0, s + start.length), Buffer.from(body, "utf8"), original.subarray(e)]);
    return { content: next, changed: !next.equals(original), createdMarkers: false };
  }
  if ((s >= 0) !== (e >= 0) || (s < 0 && original.indexOf(end) >= 0)) {
    throw new DistributionError({ kind: "validation_rejected", message: "README'da faqat bitta marker topildi yoki tartib buzilgan — tuzating" });
  }
  if (!opts.createAt) {
    throw new DistributionError({ kind: "validation_rejected", message: `README'da ${opts.startMarker} / ${opts.endMarker} markerlari yo'q (yaratish so'ralmagan)` });
  }
  const block = Buffer.from(`${opts.startMarker}${body}${opts.endMarker}`, "utf8");
  const eolBuf = Buffer.from(eol);
  let at: number;
  if (opts.createAt === "start") {
    return { content: Buffer.concat([block, eolBuf, original]), changed: true, createdMarkers: true };
  }
  if (opts.createAt === "end") {
    const sep = original.length === 0 ? Buffer.alloc(0) : original.subarray(-1)[0] === 0x0a ? eolBuf : Buffer.concat([eolBuf, eolBuf]);
    return { content: Buffer.concat([original, sep, block, eolBuf]), changed: true, createdMarkers: true };
  }
  // afterLine: shu satr (trim bilan teng) birinchi uchragandan keyin.
  const target = opts.createAt.afterLine.trim();
  let pos = 0;
  at = -1;
  while (pos <= original.length) {
    let nl = original.indexOf("\n", pos);
    if (nl < 0) nl = original.length;
    if (original.subarray(pos, nl).toString("utf8").trim() === target) {
      at = Math.min(nl + 1, original.length);
      break;
    }
    pos = nl + 1;
  }
  if (at < 0) throw new DistributionError({ kind: "validation_rejected", message: `README'da "${opts.createAt.afterLine}" satri topilmadi — markerlarni joylashtirib bo'lmadi` });
  const prefix = at === original.length && original[original.length - 1] !== 0x0a ? eolBuf : Buffer.alloc(0);
  return { content: Buffer.concat([original.subarray(0, at), prefix, eolBuf, block, eolBuf, original.subarray(at)]), changed: true, createdMarkers: true };
}

function parseExpiry(headers: Headers, fallbackNow: Date): Date | null {
  // `github-authentication-token-expiration` — UNVERIFIED (docs.github.com sahifalarida topilmadi), mavjud bo'lsa o'qiladi.
  const raw = headers.get("github-authentication-token-expiration");
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t > fallbackNow.getTime() - 365 * DAY_MS ? new Date(t) : null;
}

/** GitHub uchun `publish` kirishi: `latestPosts` MAJBURIY (bo'sh bo'lmagan) — aks holda blok bitta postga qisqarib qolardi. */
export type GithubPublishInput = PublishInput & { latestPosts: readonly DistributionPost[] };

export interface GithubProvider extends DistributionProvider {
  publish(ctx: ProviderContext, input: GithubPublishInput): Promise<PublishResult>;
}

export function createGithubProvider(options: GithubOptions = {}): GithubProvider {
  const startMarker = options.startMarker ?? GITHUB_DEFAULT_START_MARKER;
  const endMarker = options.endMarker ?? GITHUB_DEFAULT_END_MARKER;
  const limit = options.limit ?? 5;
  const path = options.path ?? "README.md";
  const nowOf = (deps: ProviderDeps) => deps.now?.() ?? new Date();

  const refine = (deps: ProviderDeps) => (res: HttpResponse, msg: string): DistributionError | undefined => {
    const base = { status: res.status, platformMessage: msg || undefined };
    const remaining = res.headers.get("x-ratelimit-remaining");
    const retryAfter = Number(res.headers.get("retry-after"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const now = nowOf(deps);
    if (res.status === 429 || (res.status === 403 && (remaining === "0" || Number.isFinite(retryAfter) && res.headers.has("retry-after") || /rate limit/i.test(msg)))) {
      const retryAt = res.headers.has("retry-after") && Number.isFinite(retryAfter)
        ? new Date(now.getTime() + retryAfter * 1000)
        : Number.isFinite(reset) && reset > 0
          ? new Date(reset * 1000)
          : new Date(now.getTime() + 60_000);
      return new DistributionError({ ...base, kind: "rate_limited", retryAt, message: "GitHub limiti oshdi" });
    }
    if (res.status === 401) return new DistributionError({ ...base, kind: "auth_expired", message: "GitHub token yaroqsiz yoki muddati tugagan — yangisini kiriting" });
    if (res.status === 403) return new DistributionError({ ...base, kind: "permission_missing", message: "GitHub ruxsat bermadi (token Contents: write ruxsatiga va shu repo'ga ega bo'lishi kerak)" });
    if (res.status === 404) return new DistributionError({ ...base, kind: "permission_missing", message: "Repo yoki fayl topilmadi — yoki token unga ruxsatga ega emas / muddati tugagan" });
    return undefined;
  };

  function target(account: ConnectedAccount) {
    const owner = options.owner ?? account.meta?.owner ?? account.externalId;
    const repo = options.repo ?? account.meta?.repo ?? owner;
    return { owner, repo };
  }

  const provider: GithubProvider = {
    id: "github",
    capabilities: { text: false, link: true, image: false, edit: true, delete: false, nativeScheduling: false, notes: { delete: "Provider faqat README blokini yangilaydi; o'chirish yo'q" } },
    limits: { textMax: null, textUnit: "none", imageMaxBytes: null, imageMimes: [] },
    tokenPolicy: GITHUB_TOKEN_POLICY,
    auth: {
      kind: "pasted_token",
      scopes: ["Contents: write"],
      async connectWithToken(deps: ProviderDeps, token: string): Promise<ConnectedAccount> {
        const http = new HostClient(deps, GITHUB_HOSTS, [token]);
        const res = await http.request({ method: "GET", url: GITHUB_USER_URL, headers: githubHeaders(token), mode: "read" });
        if (res.status < 200 || res.status >= 300) throw http.fail(res, "read", refine(deps));
        const j = asRecord(res.json);
        const login = str(j.login);
        if (!login) throw new DistributionError({ kind: "validation_rejected", message: "GitHub /user javobida login yo'q" });
        const now = nowOf(deps);
        return {
          provider: "github",
          externalId: login,
          displayName: str(j.name) ?? login,
          username: login,
          accessToken: token,
          refreshToken: null,
          accessTokenExpiresAt: parseExpiry(res.headers, now),
          refreshTokenExpiresAt: null,
          scopes: ["contents:write"],
          issuedAt: now,
          connectedAt: now,
          meta: { owner: login, repo: login },
        };
      },
    },

    tokenStatus: (account, now) => getTokenStatus(account, GITHUB_TOKEN_POLICY, now),
    renderDefaultText: (post) => renderReadmeItem(post),
    measureText: codePointLength,

    preflight(input: PreflightInput): ChannelCheck[] {
      const out: ChannelCheck[] = [];
      out.push(check({ id: "config.target", group: "config", status: "ok", title: "Nishon", message: `README'dagi ${startMarker} … ${endMarker} orasi almashtiriladi (qolgan qism o'zgarmaydi)` }));
      if (!input.post.title.trim()) out.push(check({ id: "config.title", group: "config", status: "error", title: "Sarlavha", message: "Sarlavha bo'sh" }));
      if (!isPublicHttpsUrl(input.post.url)) out.push(check({ id: "config.url", group: "config", status: "error", title: "Havola", message: "Maqola havolasi ochiq https URL bo'lishi kerak", value: input.post.url }));
      if (input.currentReadme !== undefined) {
        const has = input.currentReadme.includes(startMarker) && input.currentReadme.includes(endMarker);
        out.push(
          check({
            id: "config.markers",
            group: "config",
            status: has ? "ok" : options.createMarkersAt ? "warn" : "error",
            title: "Markerlar",
            message: has ? "Markerlar topildi" : options.createMarkersAt ? "Markerlar yo'q — so'ralgan joyda yaratiladi" : "README'da markerlar yo'q — qo'shing yoki yaratishni yoqing",
          }),
        );
        if (Buffer.byteLength(input.currentReadme) > GITHUB_MAX_README_BYTES) {
          out.push(check({ id: "config.size", group: "config", status: "error", title: "Fayl hajmi", message: "README 1 MB dan katta — Contents API to'liq qo'llab-quvvatlamaydi" }));
        }
      }
      return out;
    },

    async publish(ctx: ProviderContext, input: GithubPublishInput): Promise<PublishResult> {
      const { deps, account } = ctx;
      if (!Array.isArray(input.latestPosts) || input.latestPosts.length === 0) {
        throw new DistributionError({ kind: "validation_rejected", message: "GitHub README uchun latestPosts (bo'sh bo'lmagan ro'yxat) majburiy" });
      }
      const token = account.accessToken;
      const http = new HostClient(deps, GITHUB_HOSTS, [token]);
      const ref = refine(deps);
      const { owner, repo } = target(account);
      const posts = input.latestPosts;
      const list = renderReadmeList(posts, limit); // havolalar so'rovdan OLDIN tekshiriladi
      const headers = githubHeaders(token);

      const attempt = async (): Promise<PublishResult | "conflict"> => {
        const got = await http.request({ method: "GET", url: contentsUrl(owner, repo, path, options.branch), headers, mode: "read" });
        if (got.status < 200 || got.status >= 300) throw http.fail(got, "read", ref);
        const g = asRecord(got.json);
        const sha = str(g.sha);
        if (!sha || Array.isArray(got.json)) throw new DistributionError({ kind: "validation_rejected", message: "GitHub fayl ma'lumotini qaytarmadi (yo'l katalogmi?)" });
        if (g.encoding !== "base64" || typeof g.content !== "string" || (g.content === "" && Number(g.size) > 0)) {
          throw new DistributionError({ kind: "validation_rejected", message: "README o'qib bo'lmadi (1 MB dan katta yoki kodlash base64 emas)" });
        }
        const original = Buffer.from(g.content.replace(/\n/g, ""), "base64");
        const spliced = spliceMarkedBlock(original, list, { startMarker, endMarker, createAt: options.createMarkersAt });
        if (!spliced.changed) return { externalId: sha, url: `https://github.com/${owner}/${repo}` };
        const put = await http.request({
          method: "PUT",
          url: contentsUrl(owner, repo, path),
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            message: options.commitMessage ?? "docs: update latest articles",
            content: spliced.content.toString("base64"),
            sha,
            ...(options.branch ? { branch: options.branch } : {}),
          }),
          mode: "safe_write", // sha himoyasi bor: bir xil so'rovni qayta yuborish zararsiz
        });
        if (put.status === 409 || put.status === 422) return "conflict";
        if (put.status < 200 || put.status >= 300) throw http.fail(put, "safe_write", ref);
        const commit = asRecord(asRecord(put.json).commit);
        const content = asRecord(asRecord(put.json).content);
        return { externalId: str(commit.sha) ?? str(content.sha) ?? sha, url: str(commit.html_url) ?? str(content.html_url) ?? null };
      };

      const first = await attempt();
      if (first !== "conflict") return first;
      // sha mos kelmadi (409/422): faylni QAYTA o'qib, bir marta urinamiz.
      const second = await attempt();
      if (second !== "conflict") return second;
      throw new DistributionError({ kind: "transient", status: 409, message: "README bir vaqtda o'zgartirilmoqda (sha ziddiyati) — keyinroq urining" });
    },

    async remove(): Promise<void> {
      throw notSupported("GitHub README blokini o'chirish", "provider faqat blokni yangilaydi");
    },
  };
  return provider;
}
