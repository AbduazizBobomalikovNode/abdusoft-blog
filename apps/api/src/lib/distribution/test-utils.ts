import type { FetchLike, ProviderDeps } from "./http.js";
import { LINKEDIN_HOSTS } from "./providers/linkedin.js";
import { X_HOSTS } from "./providers/x.js";
import { THREADS_HOSTS } from "./providers/threads.js";
import { INSTAGRAM_HOSTS } from "./providers/instagram.js";
import { GITHUB_HOSTS } from "./providers/github.js";

/** Test yordamchilari (tarmoqsiz). `*.test.ts` emas — vitest o'zi ishga tushirmaydi. */

export const ALL_ALLOWED_HOSTS: readonly string[] = [...LINKEDIN_HOSTS, ...X_HOSTS, ...THREADS_HOSTS, ...INSTAGRAM_HOSTS, ...GITHUB_HOSTS];

export interface RecordedCall {
  method: string;
  url: string;
  host: string;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
  redirect: RequestInit["redirect"] | undefined;
}

export type Responder = (call: RecordedCall) => Response | Promise<Response> | Error;

export function json(body: unknown, init: ResponseInit & { headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
}

export function empty(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

/**
 * Soxta fetch: har bir chaqiruvni yozadi va HOST allow-list'dan tashqariga chiqsa test'ni yiqitadi
 * (so'rov hech qachon haqiqiy tarmoqqa chiqmaydi).
 */
export function mockFetch(responders: Responder[] | Responder) {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]).forEach((v, k) => {
      headers[k] = v;
    });
    const call: RecordedCall = {
      method: init?.method ?? "GET",
      url: input,
      host: url.hostname,
      headers,
      body: init?.body as string | Uint8Array | undefined,
      redirect: init?.redirect,
    };
    calls.push(call);
    if (!ALL_ALLOWED_HOSTS.includes(url.hostname) || url.protocol !== "https:") {
      throw new Error(`TEST: ruxsat etilmagan host'ga so'rov: ${url.protocol}//${url.hostname}`);
    }
    const r = Array.isArray(responders) ? responders[Math.min(i++, responders.length - 1)] : responders;
    if (!r) throw new Error("TEST: javob belgilanmagan");
    const out = await r(call);
    if (out instanceof Error) throw out;
    return out;
  };
  return { fetch: fetchImpl, calls };
}

export function makeDeps(fetchImpl: FetchLike, now = new Date("2026-11-25T10:00:00Z")): ProviderDeps & { slept: number[] } {
  const slept: number[] = [];
  return { fetch: fetchImpl, now: () => now, sleep: async (ms) => void slept.push(ms), timeoutMs: 1000, slept };
}

export function bodyText(call: RecordedCall): string {
  return typeof call.body === "string" ? call.body : call.body ? Buffer.from(call.body).toString("utf8") : "";
}

export function bodyJson(call: RecordedCall): Record<string, unknown> {
  return JSON.parse(bodyText(call)) as Record<string, unknown>;
}

export function formOf(call: RecordedCall): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(bodyText(call)));
}

export const POST_FIXTURE = {
  title: "Node.js'da oʻzbekcha matn bilan ishlash",
  excerpt: "Qisqa tavsif: g'oya va ma'no.",
  url: "https://abdusoft.uz/blog/node-uzbek",
  tags: ["node-js", "o'zbek", "backend"],
  publishedAt: new Date("2026-11-20T08:00:00Z"),
} as const;

export const SECRET = "SECRET-TOKEN-1234567890abcdef";
