import { describe, expect, it } from "vitest";
import type { ChannelPlan, ResolvedChannelChoice } from "@blog/shared";
import { previewSelectionOf, telegramDefaultSelection, telegramPanelMode, telegramPlanEditable, telegramPlanLine, telegramPlanStorageHint, telegramTabSummary } from "./distribution-telegram";

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
    expect(telegramPlanStorageHint("scheduled")).toContain("avtomatik");
    expect(telegramPlanStorageHint("draft")).toContain("rejalashtirilganda");
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
