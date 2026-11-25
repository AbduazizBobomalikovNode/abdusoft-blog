import { and, eq, like } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startMockTelegram } from "../../scripts/mock-telegram.js";
import { db } from "../db/index.js";
import { auditLog } from "../db/schema.js";
import { session, verification } from "../db/auth-schema.js";
import { reconfigureBot } from "../telegram/client.js";
import { createTestUser, TEST_USER_PASSWORD } from "../test/auth-test-helpers.js";
import { migrateTestDb } from "../test/migrate-test-db.js";
import {
  API,
  WEB,
  linkFromMessage,
  openLink,
  postReset,
  requestReset,
  signIn,
  tgCalls,
  tgControl,
  tgReset,
  tokenFromLink,
  type MockTelegram,
} from "../test/password-reset-helpers.js";

vi.hoisted(() => {
  process.env.TRUST_PROXY = "true";
  process.env.PASSWORD_RESET_MAX_PER_HOUR = "2";
  process.env.PASSWORD_RESET_TTL_MINUTES = "20";
});

const PRIVATE_CHAT = 424242;
const NEW_PASSWORD = "yangi-juda-uzun-parol-2026";

let mock: MockTelegram;
let app: Hono;
let whenIdle: () => Promise<void>;
let saveSettings: typeof import("./settings.js").saveSettings;
let invalidateSettingsCache: typeof import("./settings.js").invalidateSettingsCache;

async function setAdminChat(chatId: string) {
  await saveSettings({ telegram: { adminChatId: chatId } });
  invalidateSettingsCache();
}

async function requestAndWait(email: string) {
  const res = await requestReset(app, email);
  await whenIdle();
  return res;
}

async function sentLink(): Promise<string> {
  const sent = await tgCalls(mock, "sendMessage");
  expect(sent).toHaveLength(1);
  return linkFromMessage(String(sent[0]!.body.text));
}

async function auditFor(userId: string, action: string) {
  return db.select().from(auditLog).where(and(eq(auditLog.entityId, userId), eq(auditLog.action, action)));
}

beforeAll(async () => {
  mock = await startMockTelegram();
  await migrateTestDb();
  ({ app } = await import("../app.js"));
  ({ whenPasswordResetIdle: whenIdle } = await import("./password-reset.js"));
  ({ saveSettings, invalidateSettingsCache } = await import("./settings.js"));
  delete process.env.TELEGRAM_API_ROOT;
  invalidateSettingsCache();
  await saveSettings({
    telegram: { botToken: "test-bot-token", webhookSecret: "0123456789abcdef", adminChatId: String(PRIVATE_CHAT), apiRoot: mock.url },
  });
  reconfigureBot("test-bot-token", mock.url);
});

afterAll(async () => {
  reconfigureBot("", "");
  await mock.close();
});

beforeEach(async () => {
  await tgReset(mock);
  await setAdminChat(String(PRIVATE_CHAT));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/auth/request-password-reset", () => {
  it("answers identically for an admin, a staff member, a plain user and an unknown e-mail", async () => {
    const admin = await createTestUser({ role: "admin" });
    const staff = await createTestUser({ role: "staff" });
    const user = await createTestUser({ role: "user" });

    const answers = [];
    for (const email of [admin.email, staff.email, user.email, "no-such-person@example.test"]) {
      const res = await requestAndWait(email);
      answers.push([res.status, await res.json()]);
    }
    expect(answers[0]![0]).toBe(200);
    for (const answer of answers) expect(answer).toEqual(answers[0]);
  });

  it("sends a Telegram message only for an admin, to the private admin chat, with a working link", async () => {
    const admin = await createTestUser({ role: "admin" });
    const staff = await createTestUser({ role: "staff" });
    const user = await createTestUser({ role: "user" });

    await requestAndWait(staff.email);
    await requestAndWait(user.email);
    await requestAndWait("nobody@example.test");
    expect(await tgCalls(mock, "sendMessage")).toHaveLength(0);

    const ip = "203.0.113.9";
    await requestReset(app, admin.email, ip);
    await whenIdle();
    const sent = await tgCalls(mock, "sendMessage");
    expect(sent).toHaveLength(1);
    const body = sent[0]!.body;
    const text = String(body.text);
    expect(body.chat_id).toBe(String(PRIVATE_CHAT));
    expect(body.parse_mode).toBe("HTML");
    expect(body.protect_content).toBe(true);
    expect(body.link_preview_options).toEqual({ is_disabled: true });
    expect(text).toContain(admin.email);
    expect(text).toContain(ip);
    expect(text).toContain("20 daqiqa");
    expect(text).toContain("faqat bir marta");
    expect(text).toMatch(/\d{2}\.\d{2}\.\d{4} \d{2}:\d{2} \(Toshkent\)/);
    expect(text).toContain("Agar bu siz bo'lmasangiz");

    // Havola: API'ning o'zi tekshiradi va veb tiklash sahifasiga `?token=` bilan yo'naltiradi.
    const link = linkFromMessage(text);
    expect(link.startsWith(`${API}/api/auth/reset-password/`)).toBe(true);
    const opened = await openLink(app, link);
    expect(opened.status).toBe(302);
    const location = new URL(opened.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(`${WEB}/parolni-tiklash`);
    expect(location.searchParams.get("token")).toBe(tokenFromLink(link));
  });

  it("uses the configured lifetime (20 minutes) for the stored token", async () => {
    const admin = await createTestUser({ role: "admin" });
    const before = Date.now();
    await requestAndWait(admin.email);
    const token = tokenFromLink(await sentLink());
    const [row] = await db.select().from(verification).where(eq(verification.identifier, `reset-password:${token}`));
    const lifetimeMs = row!.expiresAt.getTime() - before;
    expect(lifetimeMs).toBeGreaterThan(19 * 60_000);
    expect(lifetimeMs).toBeLessThanOrEqual(20 * 60_000 + 5_000);
  });

  it("does not wait for Telegram (a slow bot must not make an existing admin distinguishable)", async () => {
    const admin = await createTestUser({ role: "admin" });
    await tgControl(mock, "/__delay", { method: "sendMessage", ms: 1500 });
    const started = Date.now();
    const res = await requestReset(app, admin.email);
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(1000);
    await whenIdle();
    expect(await tgCalls(mock, "sendMessage")).toHaveLength(1);
  });

  it("refuses to send to a group or channel, logs a clear server-side line, and shows the requester nothing different", async () => {
    const admin = await createTestUser({ role: "admin" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const control = await requestAndWait("nobody@example.test");

    for (const chat of ["-1001234567890", "777"]) {
      if (chat === "777") await tgControl(mock, "/__chat-type", { chatId: 777, type: "supergroup" });
      await setAdminChat(chat);
      const res = await requestAndWait(admin.email);
      expect([res.status, await res.json()]).toEqual([control.status, await control.clone().json()]);
    }

    expect(await tgCalls(mock, "sendMessage")).toHaveLength(0);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("shaxsiy chat emas") && l.includes("YUBORILMADI"))).toBe(true);
    // Yuborilmagan token yaroqli qolmaydi.
    const left = await db.select().from(verification).where(and(eq(verification.value, admin.id), like(verification.identifier, "reset-password:%")));
    expect(left).toHaveLength(0);
    const entries = await auditFor(admin.id, "auth.password_reset_request");
    expect(entries.map((e) => (e.meta as { outcome: string }).outcome)).toEqual(["chat_not_private", "chat_not_private"]);
  });

  it("sends nothing when the bot or the admin chat is not configured", async () => {
    const admin = await createTestUser({ role: "admin" });
    await setAdminChat("");
    const res = await requestAndWait(admin.email);
    expect(res.status).toBe(200);
    expect(await tgCalls(mock, "sendMessage")).toHaveLength(0);
    const [entry] = await auditFor(admin.id, "auth.password_reset_request");
    expect((entry!.meta as { outcome: string }).outcome).toBe("telegram_not_configured");
  });

  it("coalesces repeated requests while a valid link exists (one message, one valid token)", async () => {
    const admin = await createTestUser({ role: "admin" });
    // Parallel — ikki so'rov ham bir vaqtda keladi.
    await Promise.all([requestReset(app, admin.email), requestReset(app, admin.email)]);
    await whenIdle();
    await requestAndWait(admin.email);
    await requestAndWait(admin.email);

    expect(await tgCalls(mock, "sendMessage")).toHaveLength(1);
    const valid = await db.select().from(verification).where(and(eq(verification.value, admin.id), like(verification.identifier, "reset-password:%")));
    expect(valid).toHaveLength(1);
    const outcomes = (await auditFor(admin.id, "auth.password_reset_request")).map((e) => (e.meta as { outcome: string }).outcome).sort();
    expect(outcomes).toEqual(["coalesced", "coalesced", "coalesced", "delivered"]);
  });

  it("caps messages per account per hour (limit 2) even after earlier links expired", async () => {
    const admin = await createTestUser({ role: "admin" });
    const other = await createTestUser({ role: "admin" });
    const expire = () => db.delete(verification).where(eq(verification.value, admin.id));

    await requestAndWait(admin.email);
    await expire();
    await requestAndWait(admin.email);
    await expire();
    await requestAndWait(admin.email); // 3-chi — chegaradan oshdi
    expect(await tgCalls(mock, "sendMessage")).toHaveLength(2);

    // Boshqa hisobga ta'sir qilmaydi.
    await requestAndWait(other.email);
    expect(await tgCalls(mock, "sendMessage")).toHaveLength(3);
    const outcomes = (await auditFor(admin.id, "auth.password_reset_request")).map((e) => (e.meta as { outcome: string }).outcome);
    expect(outcomes.filter((o) => o === "hourly_limit")).toHaveLength(1);
  });

  it("a failed Telegram send leaves no valid token and the next request can deliver", async () => {
    const admin = await createTestUser({ role: "admin" });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await tgControl(mock, "/__fail", { method: "sendMessage", count: 1 });
    await requestAndWait(admin.email);
    expect(await tgCalls(mock, "sendMessage")).toHaveLength(1); // urinish bo'ldi (mock xato qaytardi)
    expect(await db.select().from(verification).where(eq(verification.value, admin.id))).toHaveLength(0);

    await tgReset(mock);
    await requestAndWait(admin.email);
    expect(await tgCalls(mock, "sendMessage")).toHaveLength(1);
  });
});

describe("resetting the password with the link", () => {
  it("sets the new password, retires the old one, ends all sessions and cannot be reused", async () => {
    const admin = await createTestUser({ role: "admin" });
    const another = await signIn(app, admin.email, TEST_USER_PASSWORD);
    expect(another.status).toBe(200);
    expect(await db.select().from(session).where(eq(session.userId, admin.id))).not.toHaveLength(0);

    await requestAndWait(admin.email);
    const link = await sentLink();
    const token = tokenFromLink(link);

    // Qisqa parol — server chegarasi hurmat qilinadi, token sarflanmaydi.
    const tooShort = await postReset(app, { token, newPassword: "short" });
    expect(tooShort.status).toBe(400);
    expect(((await tooShort.json()) as { code: string }).code).toBe("PASSWORD_TOO_SHORT");

    const ok = await postReset(app, { token, newPassword: NEW_PASSWORD });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: true });

    expect((await signIn(app, admin.email, TEST_USER_PASSWORD)).status).toBe(401);
    expect((await signIn(app, admin.email, NEW_PASSWORD)).status).toBe(200);
    // Tiklashdan keyingi sign-in sessiyasidan boshqa hamma narsa o'chirilgan edi.
    const getOld = await app.request(`${API}/api/auth/get-session`, { headers: { cookie: admin.cookie } });
    expect(await getOld.json()).toBeNull();

    const again = await postReset(app, { token, newPassword: "boshqa-uzun-parol-2027" });
    expect(again.status).toBe(400);
    expect(((await again.json()) as { code: string }).code).toBe("INVALID_TOKEN");
    const reopened = await openLink(app, link);
    expect(new URL(reopened.headers.get("location")!).searchParams.get("error")).toBe("INVALID_TOKEN");

    const [completed] = await auditFor(admin.id, "auth.password_reset_complete");
    expect(completed).toBeTruthy();
  });

  it("rejects an expired link (both the open step and the reset itself)", async () => {
    const admin = await createTestUser({ role: "admin" });
    await requestAndWait(admin.email);
    const link = await sentLink();
    const token = tokenFromLink(link);
    await db.update(verification).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(verification.identifier, `reset-password:${token}`));

    const opened = await openLink(app, link);
    expect(new URL(opened.headers.get("location")!).searchParams.get("error")).toBe("INVALID_TOKEN");
    const res = await postReset(app, { token, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("INVALID_TOKEN");
    expect((await signIn(app, admin.email, TEST_USER_PASSWORD)).status).toBe(200);
  });

  it("a successful reset also retires every other outstanding link of that account", async () => {
    const admin = await createTestUser({ role: "admin" });
    await requestAndWait(admin.email);
    const token = tokenFromLink(await sentLink());
    const [extra] = await db.insert(verification).values({ id: "x-extra", identifier: "reset-password:extra-token", value: admin.id, expiresAt: new Date(Date.now() + 60_000) }).returning();
    expect(extra).toBeTruthy();

    expect((await postReset(app, { token, newPassword: NEW_PASSWORD })).status).toBe(200);
    expect(await db.select().from(verification).where(eq(verification.value, admin.id))).toHaveLength(0);
  });
});

describe("connector plugin stays unloaded while MCP_ENABLED is off", () => {
  it("registers no plugins on the auth instance, yet the reset flow works", async () => {
    const { auth } = await import("./auth.js");
    expect(auth.options.plugins ?? []).toHaveLength(0);
    expect(await import("../config.js").then((m) => m.config.MCP_ENABLED)).toBe(false);
  });
});

describe("audit trail", () => {
  it("records the request (with IP) and the completion, never a token or a link, and nothing for unknown e-mails", async () => {
    const admin = await createTestUser({ role: "admin" });
    const ip = "198.51.100.77";

    await requestReset(app, "ghost@example.test", ip);
    await requestReset(app, admin.email, ip);
    await whenIdle();
    const link = await sentLink();
    const token = tokenFromLink(link);
    await postReset(app, { token, newPassword: NEW_PASSWORD });

    const [req] = await auditFor(admin.id, "auth.password_reset_request");
    expect((req!.meta as { ip: string }).ip).toBe(ip);
    const [done] = await auditFor(admin.id, "auth.password_reset_complete");
    expect(done!.actorUserId).toBe(admin.id);

    const everything = JSON.stringify(await db.select().from(auditLog));
    expect(everything).not.toContain(token);
    expect(everything).not.toContain("reset-password/");
    expect(everything).not.toContain(NEW_PASSWORD);
    expect(everything).not.toContain("ghost@example.test");
  });

  it("keeps the token out of server logs", async () => {
    const admin = await createTestUser({ role: "admin" });
    const sinks = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "info")];
    for (const spy of sinks) spy.mockImplementation(() => undefined);

    await requestAndWait(admin.email);
    const token = tokenFromLink(await sentLink());
    await postReset(app, { token, newPassword: NEW_PASSWORD });
    await openLink(app, `${API}/api/auth/reset-password/${token}?callbackURL=${encodeURIComponent(`${WEB}/parolni-tiklash`)}`);

    const logged = sinks.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(" "))).join("\n");
    expect(logged).not.toContain(token);
  });
});

describe("staff members and the forgot form", () => {
  it("a staff e-mail gets the neutral answer but no message; the audit shows it was not eligible", async () => {
    const staff = await createTestUser({ role: "staff" });
    await requestAndWait(staff.email);
    expect(await tgCalls(mock, "sendMessage")).toHaveLength(0);
    const [entry] = await auditFor(staff.id, "auth.password_reset_request");
    expect((entry!.meta as { outcome: string }).outcome).toBe("not_admin");
    expect(await db.select().from(verification).where(eq(verification.value, staff.id))).toHaveLength(0);
  });
});
