import { describe, expect, it } from "vitest";
import type { ChannelPlan, ResolvedChannelChoice } from "@blog/shared";
import { previewSelectionOf, telegramTabSummary } from "./distribution-telegram";

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
