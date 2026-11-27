import { describe, expect, it } from "vitest";
import type { DistributionItemDto } from "@blog/shared";
import { canPlanForPost, clampDelay, delayText, distributionAvailableFor, isPresetDelay, isWaitingPlan, planPhrase, planStateOf, planSummaryLines } from "./distribution-plan";

const item = (over: Partial<DistributionItemDto> = {}) =>
  ({ provider: "linkedin", status: "draft", planDelayMinutes: null, planMaterializedAt: null, scheduledAt: null, lastErrorMessage: null, ...over }) as DistributionItemDto;

describe("distribution plan helpers", () => {
  it("plans only for unpublished posts; the dialog is open for published or plannable ones", () => {
    for (const s of ["draft", "in_review", "scheduled"]) expect(canPlanForPost(s)).toBe(true);
    for (const s of ["published", "archived"]) expect(canPlanForPost(s)).toBe(false);
    expect(distributionAvailableFor("published")).toBe(true);
    expect(distributionAvailableFor("draft")).toBe(true);
    expect(distributionAvailableFor("archived")).toBe(false);
  });

  it("clamps custom delays to 0..10080 integers", () => {
    expect(clampDelay("15")).toBe(15);
    expect(clampDelay("")).toBe(0);
    expect(clampDelay("abc")).toBe(0);
    expect(clampDelay(-5)).toBe(0);
    expect(clampDelay(99999)).toBe(10080);
    expect(clampDelay(7.9)).toBe(7);
    expect([0, 15, 60, 180, 1440].every(isPresetDelay)).toBe(true);
    expect(isPresetDelay(30)).toBe(false);
  });

  it("words the delay like the Telegram plan", () => {
    expect(delayText(15)).toBe("15 daq");
    expect(delayText(90)).toBe("1 soat 30 daq");
    expect(delayText(1440)).toBe("1 kun");
    expect(delayText(10080)).toBe("7 kun");
    expect(planPhrase(0)).toBe("chop etilishi bilan");
    expect(planPhrase(15)).toBe("chiqqach 15 daq");
  });

  it("derives the plan state from the row", () => {
    expect(planStateOf(null)).toBe("none");
    expect(planStateOf(item())).toBe("none");
    expect(planStateOf(item({ planDelayMinutes: 5 }))).toBe("waiting");
    expect(planStateOf(item({ planDelayMinutes: 5, status: "scheduled" }))).toBe("scheduled");
    expect(planStateOf(item({ planDelayMinutes: 5, status: "failed" }))).toBe("failed");
    expect(planStateOf(item({ planDelayMinutes: 5, status: "sending" }))).toBe("active");
    expect(planStateOf(item({ planDelayMinutes: 5, status: "sent" }))).toBe("sent");
    expect(isWaitingPlan(item({ planDelayMinutes: 5 }))).toBe(true);
    expect(isWaitingPlan(item({ planDelayMinutes: 5, status: "scheduled" }))).toBe(false);
    expect(isWaitingPlan(null)).toBe(false);
  });

  it("lists every channel plan in a fixed order, skipping channels without a plan and cancelled rows", () => {
    const lines = planSummaryLines(
      [
        item({ provider: "x", planDelayMinutes: 0 }),
        item({ provider: "linkedin", planDelayMinutes: 15 }),
        item({ provider: "threads" }),
        item({ provider: "instagram", planDelayMinutes: 60, status: "cancelled" }),
        item({ provider: "github", planDelayMinutes: 5, status: "failed", lastErrorMessage: "Reja bajarilmadi: x" }),
      ],
      (p) => ({ linkedin: "LinkedIn", x: "X", threads: "Threads", instagram: "Instagram", github: "GitHub" })[p],
    );
    expect(lines.map((l) => `${l.label} · ${l.phrase}`)).toEqual(["LinkedIn · chiqqach 15 daq", "X · chop etilishi bilan", "GitHub · chiqqach 5 daq"]);
    expect(lines[2]).toMatchObject({ state: "failed", error: "Reja bajarilmadi: x" });
    expect(lines[0]).toMatchObject({ state: "waiting", scheduledAt: null });
  });

  it("prefers the active row over an older sent one", () => {
    const lines = planSummaryLines(
      [item({ provider: "x", status: "sent", planDelayMinutes: 5 }), item({ provider: "x", status: "scheduled", planDelayMinutes: 30, scheduledAt: "2026-11-26T10:30:00Z" })],
      () => "X",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ state: "scheduled", phrase: "chiqqach 30 daq", scheduledAt: "2026-11-26T10:30:00Z" });
  });
});
