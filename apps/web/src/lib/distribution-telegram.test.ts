import { describe, expect, it } from "vitest";
import type { ChannelPlan, ChannelStatus, ResolvedChannelChoice } from "@blog/shared";
import { absoluteTimeError, canEditSendAt, formatChannelAt, isoToLocalInput, planTiming, planWithDelay, planWithSendAt, telegramDotTone, telegramErrorLine, telegramStatusLine, TELEGRAM_PLAN_NOTE, createInFlightGuard, sendGate, previewSelectionOf, telegramDefaultSelection, telegramPanelMode, telegramPlanEditable, telegramPlanLine, telegramPlanStorageHint, telegramTabSummary } from "./distribution-telegram";

const choice = (over: Partial<ResolvedChannelChoice> = {}) =>
  ({ choice: { kind: "auto", mode: "media", variant: "m" }, label: "Rasmli · O'rtacha", mode: "media", visibleLength: 812, limit: 1024, passes: true, ...over }) as ResolvedChannelChoice;

describe("telegramTabSummary", () => {
  it("describes choice, plan and sent state", () => {
    const s = telegramTabSummary({ choice: choice(), plan: { delayMinutes: 15 } as ChannelPlan, sent: true });
    expect(s.choice).toBe("⭐ Rasmli · O'rtacha · 812 / 1024 · cheklovlardan o'tadi");
    expect(s.plan).toBe("saytga chiqqach 15 daq");
    expect(s.sent).toBe("kanalga yuborilgan");
  });
  it("handles empty state", () => {
    const s = telegramTabSummary({ choice: null, plan: null, sent: false });
    expect(s).toEqual({ choice: "belgilanmagan (standart)", plan: "reja yo'q", sent: "hali yuborilmagan" });
  });
  it("flags failing choice and immediate plan", () => {
    const s = telegramTabSummary({ choice: choice({ passes: false }), plan: { delayMinutes: 0 } as ChannelPlan, sent: false });
    expect(s.choice).toContain("mos emas");
    expect(s.plan).toBe("saytga chop etilishi bilan");
  });
});

describe("previewSelectionOf", () => {
  it("maps auto and version choices", () => {
    expect(previewSelectionOf(null)).toBeNull();
    expect(previewSelectionOf(choice())).toEqual({ mode: "media", variant: "m" });
    expect(previewSelectionOf(choice({ choice: { kind: "version", versionId: "00000000-0000-4000-8000-000000000000" } }))).toEqual({ versionId: "00000000-0000-4000-8000-000000000000" });
  });
});

describe("telegram panel helpers", () => {
  it("sends only for published posts, otherwise prepares (mark + plan)", () => {
    expect(telegramPanelMode("published")).toBe("send");
    for (const st of ["draft", "in_review", "scheduled", "changes_requested"]) expect(telegramPanelMode(st)).toBe("prepare");
  });
  it("the plan is settable only before publish", () => {
    for (const st of ["draft", "in_review", "scheduled"]) expect(telegramPlanEditable(st)).toBe(true);
    for (const st of ["published", "archived"]) expect(telegramPlanEditable(st)).toBe(false);
  });
  it("says where the plan is stored", () => {
    for (const st of ["draft", "in_review", "scheduled"]) {
      expect(telegramPlanStorageHint(st)).toContain("avtomatik saqlanadi");
      expect(telegramPlanStorageHint(st)).toContain("qoralamaga qaytarilsa reja saqlanib qoladi");
    }
    expect(telegramPlanStorageHint("published")).toBe("");
    expect(TELEGRAM_PLAN_NOTE).toContain("qo'lda ham");
  });
  it("falls back to a standard preview when nothing is marked (never empty)", () => {
    expect(telegramDefaultSelection(null)).toEqual({ mode: "media", variant: "m" });
    expect(telegramDefaultSelection(true)).toEqual({ mode: "media", variant: "m" });
    expect(telegramDefaultSelection(false)).toEqual({ mode: "text", variant: "m" });
  });
  it("one-line plan summary for the Publish card", () => {
    expect(telegramPlanLine(null)).toContain("rejasi yo'q");
    expect(telegramPlanLine({ delayMinutes: 15 } as ChannelPlan)).toBe("Telegram · saytga chiqqach 15 daq");
    expect(telegramPlanLine({ delayMinutes: 0 } as ChannelPlan)).toBe("Telegram · saytga chop etilishi bilan");
  });
});

describe("send gate (flush before send)", () => {
  it("sends only when nothing was saved in this click", () => {
    expect(sendGate("clean")).toBe("send");
    expect(sendGate("saved")).toBe("stop-saved");
    expect(sendGate("failed")).toBe("stop-failed");
  });
});

describe("in-flight guard", () => {
  it("rejects a second synchronous entry until left", () => {
    const g = createInFlightGuard();
    expect(g.tryEnter()).toBe(true);
    expect(g.tryEnter()).toBe(false);
    g.leave();
    expect(g.tryEnter()).toBe(true);
  });
});

const AT = new Date(2026, 10, 28, 14, 30).toISOString();
const NOW = new Date(2026, 10, 20, 9, 0);
const status = (over: Partial<ChannelStatus> = {}): ChannelStatus => ({ state: "none", plan: null, sendAt: null, sentAt: null, messageIds: [], attempts: 0, lastError: null, ...over });

describe("absolute channel time helpers", () => {
  it("formats local date and time (year only when different)", () => {
    expect(formatChannelAt(AT, NOW)).toBe("28.11 14:30");
    expect(formatChannelAt(new Date(2027, 0, 5, 8, 5).toISOString(), NOW)).toBe("05.01.2027 08:05");
    expect(formatChannelAt("nope", NOW)).toBe("—");
  });
  it("round-trips ISO <-> datetime-local", () => {
    expect(isoToLocalInput(AT)).toBe("2026-11-28T14:30");
    expect(isoToLocalInput(null)).toBe("");
    expect(isoToLocalInput("x")).toBe("");
  });
  it("plan summary and line show the absolute time", () => {
    const plan = { mode: "text", variant: "m", delayMinutes: 0, sendAt: AT } as ChannelPlan;
    expect(telegramPlanLine(plan)).toContain("kanalga 28.11 14:30 da yuboriladi");
    expect(telegramTabSummary({ choice: null, plan, sent: false }).plan).toContain("kanalga 28.11 14:30 da");
    expect(telegramPlanLine({ mode: "text", variant: "m", delayMinutes: 15 } as ChannelPlan)).toBe("Telegram · saytga chiqqach 15 daq");
  });
  it("delay and sendAt exclude each other", () => {
    const base = { mode: "text", variant: "m", delayMinutes: 30 } as ChannelPlan;
    const abs = planWithSendAt(base, AT);
    expect(abs).toMatchObject({ delayMinutes: 0, sendAt: AT });
    const back = planWithDelay(abs, 60);
    expect(back.sendAt).toBeUndefined();
    expect("sendAt" in back).toBe(false);
    expect(back.delayMinutes).toBe(60);
    expect(planTiming(abs)).toEqual({ delayMinutes: 0, sendAt: AT });
    expect(planTiming(base)).toEqual({ delayMinutes: 30 });
  });
  it("validates the time on the client", () => {
    const local = (d: Date) => isoToLocalInput(d.toISOString());
    expect(absoluteTimeError("", { now: NOW })).toBe("Vaqtni tanlang");
    expect(absoluteTimeError(local(new Date(2026, 10, 19)), { now: NOW })).toBe("Vaqt kelajakda bo'lishi kerak");
    expect(absoluteTimeError(local(new Date(2026, 10, 25)), { now: NOW, notBeforeLocal: local(new Date(2026, 10, 26)) })).toContain("saytga chiqishidan oldin");
    expect(absoluteTimeError(local(new Date(2028, 0, 1)), { now: NOW })).toContain("365");
    expect(absoluteTimeError(local(new Date(2026, 10, 28)), { now: NOW, notBeforeLocal: local(new Date(2026, 10, 26)) })).toBeNull();
  });
  it("status line and tab dot follow the server status", () => {
    expect(telegramStatusLine(null)).toBe("Holat yuklanmoqda…");
    expect(telegramStatusLine(status(), NOW)).toBe("Kanalga hali yuborilmagan");
    expect(telegramStatusLine(status({ state: "planned", sendAt: AT, plan: { kind: "at", delayMinutes: null, attempts: 0 } }), NOW)).toBe("Kanalga 28.11 14:30 da yuboriladi");
    expect(telegramStatusLine(status({ state: "planned", plan: { kind: "delay", delayMinutes: 15, attempts: 0 } }), NOW)).toContain("saytga chiqqach 15 daq");
    expect(telegramStatusLine(status({ state: "sending" }), NOW)).toContain("yuborilmoqda");
    expect(telegramStatusLine(status({ state: "sent", sentAt: AT }), NOW)).toBe("Kanalga yuborilgan · 28.11 14:30");
    expect(telegramDotTone(null)).toBeNull();
    expect(telegramDotTone(status())).toBeNull();
    expect(telegramDotTone(status({ state: "planned" }))).toBe("planned");
    expect(telegramDotTone(status({ state: "sent" }))).toBe("sent");
  });
  it("sent post: not editable, a lingering plan is reported but not offered", () => {
    expect(canEditSendAt(null)).toBe(false);
    expect(canEditSendAt(status())).toBe(true);
    expect(canEditSendAt(status({ state: "planned", sendAt: AT }))).toBe(true);
    expect(canEditSendAt(status({ state: "sent", sentAt: AT }))).toBe(false);
    expect(canEditSendAt(status({ state: "sending" }))).toBe(false);
    const lingering = status({ state: "planned", sendAt: AT, sentAt: AT });
    expect(canEditSendAt(lingering)).toBe(false);
    expect(telegramStatusLine(lingering, NOW)).toContain("kutayotgan reja qolgan");
    expect(telegramDotTone(lingering)).toBe("sent");
  });
});

describe("last send error", () => {
  const err = { message: "Bad Request: chat not found", at: AT };
  it("error line: message, time, retry hint only while something is pending", () => {
    expect(telegramErrorLine(null)).toBeNull();
    expect(telegramErrorLine(status(), NOW)).toBeNull();
    expect(telegramErrorLine(status({ lastError: err }), NOW)).toBe("Oxirgi urinish muvaffaqiyatsiz (28.11 14:30): Bad Request: chat not found");
    expect(telegramErrorLine(status({ state: "planned", lastError: err }), NOW)).toContain("qayta uriniladi");
    expect(telegramErrorLine(status({ lastError: { message: "x", at: null } }), NOW)).toBe("Oxirgi urinish muvaffaqiyatsiz: x");
  });
  it("red dot only when the last attempt failed and nothing is pending", () => {
    expect(telegramDotTone(status({ lastError: err }))).toBe("failed");
    expect(telegramDotTone(status({ state: "planned", lastError: err }))).toBe("planned");
    expect(telegramDotTone(status({ state: "sending", lastError: err }))).toBe("sending");
    expect(telegramDotTone(status({ state: "sent", sentAt: AT }))).toBe("sent");
    expect(telegramDotTone(status())).toBeNull();
  });
});
