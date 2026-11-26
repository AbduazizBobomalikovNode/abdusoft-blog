import { describe, expect, it } from "vitest";
import type { DistributionAccountDto, DistributionItemDto } from "@blog/shared";
import { counterView, groupChecks, isFutureEnough, isHttpsUrl, itemActions, localInputToIso, minScheduleInput, textForSave, tokenLine } from "./distribution-ui";

const item = (over: Partial<DistributionItemDto> = {}): DistributionItemDto => ({
  id: "i", postId: "p", provider: "x", status: "draft", text: null, sentText: null, imageChoice: "auto", linkMode: null, scheduledAt: null, nextAttemptAt: null,
  attempts: 0, lastErrorKind: null, lastErrorMessage: null, externalId: null, externalUrl: null, step: null, canResume: false, createdBy: null, createdVia: "web",
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
