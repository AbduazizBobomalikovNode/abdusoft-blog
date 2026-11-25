import type { Hono } from "hono";
import { startMockTelegram } from "../../scripts/mock-telegram.js";

export const API = "http://localhost:4000";
export const WEB = "http://localhost:3000";

export type MockTelegram = Awaited<ReturnType<typeof startMockTelegram>>;
export type TgCall = { method: string; body: Record<string, unknown> };

export async function tgCalls(mock: MockTelegram, method?: string): Promise<TgCall[]> {
  const all = ((await (await fetch(`${mock.url}/__calls`)).json()) as { calls: TgCall[] }).calls;
  return method ? all.filter((c) => c.method === method) : all;
}

export async function tgControl(mock: MockTelegram, path: string, body: unknown): Promise<void> {
  await fetch(`${mock.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

export async function tgReset(mock: MockTelegram): Promise<void> {
  await fetch(`${mock.url}/__calls`, { method: "DELETE" });
  await tgControl(mock, "/__fail", { method: "sendMessage", count: 0 });
  await tgControl(mock, "/__delay", { method: "sendMessage", ms: 0 });
}

let ipSeq = 0;
/** Har so'rov uchun yangi "mijoz IP" (TRUST_PROXY=true bo'lishi kerak) — IP bo'yicha chegaralar bir-biriga halaqit bermasin. */
export const nextIp = () => `10.77.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;

export function requestReset(app: Hono, email: string, ip: string = nextIp()) {
  return app.request(`${API}/api/auth/request-password-reset`, {
    method: "POST",
    headers: { origin: WEB, "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ email }),
  });
}

export function postReset(app: Hono, body: Record<string, unknown>, ip: string = nextIp()) {
  return app.request(`${API}/api/auth/reset-password`, {
    method: "POST",
    headers: { origin: WEB, "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

export function openLink(app: Hono, link: string, ip: string = nextIp()) {
  const url = new URL(link);
  return app.request(`${API}${url.pathname}${url.search}`, { headers: { "x-forwarded-for": ip } });
}

export function signIn(app: Hono, email: string, password: string, ip: string = nextIp()) {
  return app.request(`${API}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin: WEB, "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ email, password }),
  });
}

/** Telegram xabari matnidan tiklash havolasini ajratib oladi. */
export function linkFromMessage(text: string): string {
  const match = /https?:\/\/\S+\/api\/auth\/reset-password\/\S+/.exec(text);
  if (!match) throw new Error("Xabarda tiklash havolasi yo'q");
  return match[0].replace(/&amp;/g, "&");
}

export function tokenFromLink(link: string): string {
  return decodeURIComponent(new URL(link).pathname.split("/").pop()!);
}
