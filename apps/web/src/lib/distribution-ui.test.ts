import { describe, expect, it } from "vitest";
import { DISTRIBUTION_STATUS_LABELS, splitXThread, type DistributionAccountDto, type DistributionItemDto } from "@blog/shared";
import { counterView, threadCounterView, groupChecks, isFutureEnough, isHttpsUrl, itemActions, localInputToIso, minScheduleInput, own, purgeDistributionWarning, statusPill, textForSave, tokenLine, trashedItemActions, trashedVisibleItems } from "./distribution-ui";

const item = (over: Partial<DistributionItemDto> = {}): DistributionItemDto => ({
  id: "i", postId: "p", provider: "x", status: "draft", text: null, sentText: null, imageChoice: "auto", linkMode: null, xThread: false, xThreadNumbering: false, threadPosted: 0, scheduledAt: null, nextAttemptAt: null,
  attempts: 0, lastErrorKind: null, lastErrorMessage: null, externalId: null, externalUrl: null, step: null, canResume: false, versionId: null, planDelayMinutes: null, planMaterializedAt: null, createdBy: null, createdVia: "web",
  sentAt: null, removedAt: null, createdAt: "2026-11-26T10:00:00Z", updatedAt: "2026-11-26T10:00:00Z", ...over,
});
const account = (over: Partial<DistributionAccountDto> = {}): DistributionAccountDto => ({
  id: "a", displayName: "Owner", username: null, status: "active", scopes: [], connectedAt: "2026-11-01T00:00:00Z", tokenState: "ok", expiresAt: null, daysLeft: null, canRefresh: false, ...over,
});

describe("live counter uses the provider's own counting", () => {
  it("X: URL = 23, emoji = 2; over the limit is flagged", () => {
    const c = counterView("x", "Salom https://example.com/very/long/path/that/is/long", 280);
    expect(c.length).toBe(6 + 23);
    expect(c.label).toBe("29 / 280");
    expect(c.level).toBe("ok");
    expect(counterView("x", "🚀".repeat(141), 280)).toMatchObject({ length: 282, level: "over", remaining: -2 });
    expect(counterView("x", "🚀".repeat(141), 280).className).toContain("destructive");
  });
  it("Threads: emoji counts as its UTF-8 bytes", () => {
    expect(counterView("threads", "🚀", 500).length).toBe(4);
    expect(counterView("threads", "ab", 500).length).toBe(2);
  });
  it("LinkedIn/Instagram: code points; warn above 95%; GitHub has no counter", () => {
    expect(counterView("linkedin", "a".repeat(2900), 3000).level).toBe("warn");
    expect(counterView("instagram", "😀😀", 2200).length).toBe(2);
    const g = counterView("github", "abc", null);
    expect(g).toMatchObject({ level: "none", label: "3" });
  });
});

describe("which actions are allowed", () => {
  const caps = { delete: true };
  it("no distribution yet / draft / failed / scheduled are editable and sendable when the channel is ready", () => {
    for (const status of [null, "draft", "failed", "scheduled"] as const) {
      const a = itemActions(status === null ? null : item({ status }), true, caps);
      expect(a.edit && a.send && a.schedule && a.save, String(status)).toBe(true);
    }
    expect(itemActions(null, false, caps).send).toBe(false);
  });
  it("cancel for draft/scheduled/failed; retry only for failed", () => {
    expect(itemActions(item({ status: "scheduled" }), true, caps)).toMatchObject({ cancel: true, retry: false });
    expect(itemActions(item({ status: "failed" }), true, caps)).toMatchObject({ cancel: true, retry: true });
    expect(itemActions(item({ status: "failed" }), false, caps).retry).toBe(false);
    expect(itemActions(item({ status: "draft" }), true, caps).retry).toBe(false);
  });
  it("needs_checking: only the resolution panel — no send, no retry, no cancel", () => {
    const a = itemActions(item({ status: "needs_checking" }), true, caps);
    expect(a).toMatchObject({ resolve: true, send: false, schedule: false, retry: false, cancel: false, edit: false });
  });
  it("sending locks everything; sent offers remove (if supported) and 'send again'", () => {
    expect(itemActions(item({ status: "sending" }), true, caps)).toMatchObject({ edit: false, send: false, cancel: false, resolve: false });
    const sent = item({ status: "sent", externalId: "123" });
    expect(itemActions(sent, true, caps)).toMatchObject({ remove: true, sendAgain: true, send: false });
    expect(itemActions(sent, true, { delete: false }).remove).toBe(false);
    expect(itemActions(item({ status: "sent" }), true, caps).remove).toBe(false); // id yo'q
  });
});

describe("token line", () => {
  const now = new Date("2026-11-26T10:00:00Z");
  it("expiring / ok / expired / refreshable / not connected", () => {
    expect(tokenLine(null, now)).toEqual({ tone: "neutral", text: "Ulanmagan" });
    expect(tokenLine(account({ tokenState: "expiring", expiresAt: "2026-12-03T10:00:00Z" }), now)).toEqual({ tone: "warn", text: "Token 7 kundan keyin tugaydi" });
    expect(tokenLine(account({ expiresAt: "2027-01-20T10:00:00Z" }), now).tone).toBe("success");
    expect(tokenLine(account({ status: "reauth_required" }), now).tone).toBe("danger");
    expect(tokenLine(account({ tokenState: "expired", expiresAt: "2026-11-01T10:00:00Z" }), now).text).toContain("qayta ulash");
    expect(tokenLine(account({ canRefresh: true, expiresAt: "2026-11-26T12:00:00Z" }), now).text).toBe("Token o'zi yangilanadi");
    // Instagram (Unified Login): muddatsiz token "N kun" deb ko'rsatilmaydi.
    expect(tokenLine(account({ neverExpires: true, expiresAt: null, daysLeft: null }), now)).toEqual({ tone: "success", text: "Token muddatsiz (tugamaydi)" });
    expect(tokenLine(account({ neverExpires: true, expiresAt: null, status: "reauth_required" }), now).tone).toBe("danger");
    expect(tokenLine(account({ expiresAt: null }), now).text).toBe("Muddati noma'lum");
  });
});

describe("schedule input and misc helpers", () => {
  it("datetime-local -> ISO, invalid -> null, min is now + 5 min", () => {
    expect(localInputToIso("2026-12-01T09:00")).toBe(new Date("2026-12-01T09:00").toISOString());
    expect(localInputToIso("")).toBeNull();
    expect(localInputToIso("2026-12-01")).toBeNull();
    const now = new Date(2026, 10, 26, 10, 0, 0);
    expect(minScheduleInput(now)).toBe("2026-11-26T10:05");
    expect(isFutureEnough(new Date(now.getTime() + 120_000).toISOString(), now)).toBe(true);
    expect(isFutureEnough(new Date(now.getTime() + 10_000).toISOString(), now)).toBe(false);
    expect(isFutureEnough(null, now)).toBe(false);
  });
  it("https URL check for manual resolution", () => {
    expect(isHttpsUrl("https://x.com/owner/status/1")).toBe(true);
    expect(isHttpsUrl("http://x.com/1")).toBe(false);
    expect(isHttpsUrl("https://user:pw@x.com/1")).toBe(false);
    expect(isHttpsUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpsUrl("x.com")).toBe(false);
  });
  it("text equal to the default (or blank) is saved as 'not edited'", () => {
    expect(textForSave("default", "default")).toBeNull();
    expect(textForSave("  ", "default")).toBeNull();
    expect(textForSave("mening matnim", "default")).toBe("mening matnim");
  });
  it("groups checks by severity", () => {
    const mk = (id: string, status: "ok" | "warn" | "error") => ({ id, group: "text" as const, status, title: id, message: id, value: null, limit: null, imageUrl: null });
    const g = groupChecks([mk("a", "ok"), mk("b", "warn"), mk("c", "error"), mk("d", "error")]);
    expect([g.ok.length, g.warnings.length, g.errors.length]).toEqual([1, 1, 2]);
  });
});

describe("own(): table lookups never reach the prototype", () => {
  it("returns the fallback for prototype keys and unknown keys, the value for own keys", () => {
    const map = { a: "A" } as Record<string, string>;
    expect(own(map, "a", "-")).toBe("A");
    for (const k of ["constructor", "__proto__", "toString", "hasOwnProperty", "missing", "", null, undefined]) expect(own(map, k, "-")).toBe("-");
    expect(statusPill("sent").label).toBe(DISTRIBUTION_STATUS_LABELS.sent);
    expect(statusPill("constructor" as never).label).toBe("constructor");
  });
});

describe("trashed post: what is shown and what is allowed", () => {
  const mk = (status: DistributionItemDto["status"], over: Partial<DistributionItemDto> = {}): DistributionItemDto => item({ status, ...over });
  it("shows draft, scheduled, failed, needs_checking, sent and removed rows; plain cancelled ones are hidden", () => {
    const rows = [mk("draft"), mk("scheduled"), mk("failed"), mk("needs_checking"), mk("sent"), mk("cancelled"), mk("cancelled", { removedAt: "2026-11-01T00:00:00Z" })];
    expect(trashedVisibleItems(rows)).toHaveLength(6);
  });
  it("cancel only for scheduled, resolve only for needs_checking, remove only for sent rows the provider can delete; never send/retry", () => {
    const caps = { delete: true };
    expect(trashedItemActions(mk("scheduled"), caps)).toEqual({ cancel: true, resolve: false, remove: false });
    expect(trashedItemActions(mk("needs_checking"), caps)).toEqual({ cancel: false, resolve: true, remove: false });
    expect(trashedItemActions(mk("sent", { externalId: "1" }), caps)).toEqual({ cancel: false, resolve: false, remove: true });
    expect(trashedItemActions(mk("sent", { externalId: "1" }), { delete: false }).remove).toBe(false);
    for (const s of ["draft", "failed", "sending", "cancelled"] as const) expect(trashedItemActions(mk(s), caps)).toEqual({ cancel: false, resolve: false, remove: false });
  });
});

describe("warning before permanently deleting a post that was sent to networks", () => {
  const channels = [{ id: "linkedin", name: "LinkedIn (shaxsiy)" }, { id: "x", name: "X" }, { id: "github", name: "GitHub README" }];
  const mk = (provider: DistributionItemDto["provider"], status: DistributionItemDto["status"], over: Partial<DistributionItemDto> = {}): DistributionItemDto => item({ provider, status, ...over });
  it("lists the networks that still hold a sent post (each once); none -> no warning", () => {
    const w = purgeDistributionWarning([mk("linkedin", "sent"), mk("x", "sent"), mk("x", "sent"), mk("github", "scheduled")], channels)!;
    expect(w).toContain("LinkedIn, X.");
    expect(w).not.toContain("GitHub");
    expect(w).toMatch(/olib tashlab bo'lmaydi/);
    expect(purgeDistributionWarning([mk("linkedin", "scheduled"), mk("x", "cancelled", { removedAt: "2026-11-01T00:00:00Z" }), mk("x", "failed")], channels)).toBeNull();
    expect(purgeDistributionWarning([], channels)).toBeNull();
  });
});

describe("threadCounterView", () => {
  it("shows the tweet count and the longest part", () => {
    const v = threadCounterView(splitXThread("Birinchi\n---\nIkkinchi"));
    expect(v).toMatchObject({ level: "ok", label: "2 ta tvit · eng uzuni 8/280" });
  });
  it("flags a part over the limit as '2-si 291/280'", () => {
    const split = splitXThread("a\n---\n" + "x".repeat(291));
    // avtomatik bo'linadi, shuning uchun qo'lda oshgan holatni modellashtiramiz
    const over = { ...split, parts: split.parts.map((p, i) => (i === 1 ? { ...p, weight: 291, over: true } : p)), anyOver: true };
    expect(threadCounterView(over)).toMatchObject({ level: "over", className: "text-destructive" });
    expect(threadCounterView(over).label).toContain("2-si 291/280");
  });
  it("too many parts is an error", () => {
    const text = Array.from({ length: 16 }, (_, i) => `t${i}`).join("\n---\n");
    expect(threadCounterView(splitXThread(text))).toMatchObject({ level: "over", label: "16 ta tvit (ko'pi bilan 15)" });
  });
  it("empty text -> 0 ta tvit", () => {
    expect(threadCounterView(splitXThread(""))).toMatchObject({ label: "0 ta tvit" });
  });
});
