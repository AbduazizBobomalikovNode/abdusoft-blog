import sharp from "sharp";
import type { FetchLike } from "../http.js";
import { ALL_ALLOWED_HOSTS, json, empty, type RecordedCall } from "../test-utils.js";
import type { PreparedImage } from "../../../telegram/channel-media.js";

/**
 * Testlar uchun umumiy yordamchilar (`*.test.ts` emas). Hamma tashqi so'rov SOXTA `fetch` orqali o'tadi va faqat provider
 * allow-list hostlariga ruxsat beriladi — haqiqiy platformaga so'rov chiqmaydi.
 */

export type PlatformHandler = (call: RecordedCall & { path: string; search: URLSearchParams }) => Response | Error | undefined | Promise<Response | Error | undefined>;

export interface PlatformMock {
  fetch: FetchLike;
  calls: RecordedCall[];
  /** Eng oldin qo'shilgan emas — eng KEYIN qo'shilgan handler birinchi tekshiriladi. */
  use(handler: PlatformHandler): void;
  reset(): void;
  where(pred: (c: RecordedCall) => boolean): RecordedCall[];
}

export const TOKENS = { li: "LI-ACCESS-TOKEN-0001", liNew: "LI-ACCESS-TOKEN-0002", xAccess: "X-ACCESS-TOKEN-0001", xRefresh: "X-REFRESH-TOKEN-0001", xAccess2: "X-ACCESS-TOKEN-0002", xRefresh2: "X-REFRESH-TOKEN-0002", threads: "THREADS-LONG-TOKEN-0001", ig: "IG-LONG-TOKEN-0001", gh: "github_pat_TESTTOKEN0001" } as const;

/** Barcha providerlar uchun "muvaffaqiyatli" standart javoblar. */
function defaults(call: RecordedCall & { path: string; search: URLSearchParams }): Response {
  const { host, path, method } = call;
  // --- LinkedIn ---
  if (host === "www.linkedin.com" && path === "/oauth/v2/accessToken") return json({ access_token: TOKENS.li, expires_in: 5184000, scope: "openid,profile,w_member_social" });
  if (host === "api.linkedin.com" && path === "/v2/userinfo") return json({ sub: "li-owner-1", name: "Test Owner" });
  if (host === "api.linkedin.com" && path === "/rest/images") return json({ value: { uploadUrl: "https://www.linkedin.com/dms-uploads/upload-1", image: "urn:li:image:IMG1" } });
  if (host === "www.linkedin.com" && path.startsWith("/dms-uploads/")) return empty(201);
  if (host === "api.linkedin.com" && path === "/rest/posts" && method === "POST") return empty(201, { "x-restli-id": "urn:li:share:7000001" });
  if (host === "api.linkedin.com" && path.startsWith("/rest/posts/") && method === "DELETE") return empty(204);
  // --- X ---
  if (host === "api.x.com" && path === "/2/oauth2/token") return json({ access_token: TOKENS.xAccess, refresh_token: TOKENS.xRefresh, expires_in: 7200, scope: "tweet.read tweet.write users.read media.write offline.access" });
  if (host === "api.x.com" && path === "/2/users/me") return json({ data: { id: "x-owner-1", username: "owner", name: "Test Owner" } });
  if (host === "api.x.com" && path === "/2/media/upload") return json({ data: { id: "media-1" } });
  if (host === "api.x.com" && path === "/2/tweets" && method === "POST") return json({ data: { id: "tweet-1" } }, { status: 201 });
  if (host === "api.x.com" && path.startsWith("/2/tweets/") && method === "DELETE") return json({ data: { deleted: true } });
  // --- Threads ---
  if (host === "graph.threads.com") {
    if (path === "/oauth/access_token") return json({ access_token: "THREADS-SHORT-TOKEN", user_id: 77 });
    if (path === "/access_token") return json({ access_token: TOKENS.threads, expires_in: 5184000 });
    if (path === "/refresh_access_token") return json({ access_token: "THREADS-LONG-TOKEN-0002", expires_in: 5184000 });
    if (path === "/v1.0/me") return json({ id: "T1", username: "owner", name: "Test Owner" });
    if (path === "/v1.0/T1/threads") return json({ id: "TC1" });
    if (path === "/v1.0/TC1") return json({ id: "TC1", status: "FINISHED" });
    if (path === "/v1.0/T1/threads_publish") return json({ id: "TM1" });
    if (path === "/v1.0/TM1" && method === "GET") return json({ id: "TM1", permalink: "https://www.threads.com/@owner/post/TM1" });
    if (path === "/v1.0/TM1" && method === "DELETE") return json({ success: true });
  }
  // --- Instagram ---
  if (host === "graph.facebook.com") {
    if (path === "/v27.0/oauth/access_token") return json({ access_token: TOKENS.ig, token_type: "bearer" });
    if (path === "/v27.0/me/assigned_instagram_accounts") return json({ data: [{ id: "17841400000001", username: "owner_ig" }] });
    if (path === "/v27.0/me") return json({ id: "SU1", client_business_id: "BIZ1" });
    if (path === "/v27.0/IG1/media") return json({ id: "5001" });
    if (path === "/v27.0/5001") return json({ id: "5001", status_code: "FINISHED" });
    if (path === "/v27.0/IG1/media_publish") return json({ id: "6001" });
    if (path === "/v27.0/6001") return json({ id: "6001", permalink: "https://www.instagram.com/p/6001/" });
  }
  // --- GitHub ---
  if (host === "api.github.com" && path === "/user") return json({ login: "owner", name: "Test Owner" }, { headers: { "github-authentication-token-expiration": "2027-03-01 10:00:00 UTC" } });
  if (host === "api.github.com" && path === "/repos/owner/owner/contents/README.md") {
    if (method === "GET") {
      const readme = `# Salom\n\n<!-- BLOG-POSTS:START -->\n- eski\n<!-- BLOG-POSTS:END -->\n`;
      return json({ sha: "readme-sha-1", encoding: "base64", content: Buffer.from(readme).toString("base64"), size: readme.length });
    }
    return json({ commit: { sha: "commit-sha-1", html_url: "https://github.com/owner/owner/commit/commit-sha-1" }, content: { sha: "readme-sha-2" } });
  }
  return new Response(JSON.stringify({ error: `TEST: mock yo'q: ${method} ${host}${path}` }), { status: 599 });
}

export function createPlatformMock(): PlatformMock {
  const calls: RecordedCall[] = [];
  const handlers: PlatformHandler[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]).forEach((v, k) => {
      headers[k] = v;
    });
    const call: RecordedCall & { path: string; search: URLSearchParams } = {
      method: init?.method ?? "GET",
      url: input,
      host: url.hostname,
      headers,
      body: init?.body as string | Uint8Array | undefined,
      redirect: init?.redirect,
      path: url.pathname,
      search: url.searchParams,
    };
    calls.push(call);
    if (!ALL_ALLOWED_HOSTS.includes(url.hostname) || url.protocol !== "https:") throw new Error(`TEST: ruxsat etilmagan host'ga so'rov: ${url.protocol}//${url.hostname}`);
    for (let i = handlers.length - 1; i >= 0; i--) {
      const out = await handlers[i]!(call);
      if (out instanceof Error) throw out;
      if (out) return out;
    }
    return defaults(call);
  };
  return {
    fetch: fetchImpl,
    calls,
    use: (h) => void handlers.push(h),
    reset: () => {
      calls.length = 0;
      handlers.length = 0;
    },
    where: (pred) => calls.filter(pred),
  };
}

/** 1200x630 sinov rasmi (JPEG). */
export async function testJpeg(width = 1200, height = 630): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 30, g: 90, b: 160 } } }).jpeg().toBuffer();
}

export async function fakePreparedImage(url: string, width = 1200, height = 630): Promise<PreparedImage> {
  const buffer = await testJpeg(width, height);
  return { ok: true, url, buffer, original: { bytes: buffer.byteLength, width, height, format: "jpeg", animated: false }, sent: { bytes: buffer.byteLength, width, height, format: "jpeg" } };
}

