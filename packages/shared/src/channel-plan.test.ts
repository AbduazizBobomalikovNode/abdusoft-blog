import { describe, expect, it } from "vitest";
import { ChannelPlanSchema, ChannelScheduleBodySchema, isAbsoluteChannelPlan } from "./dto.js";

const SEND_AT = "2026-12-01T09:30:00.000Z";

describe("ChannelPlanSchema absolute time", () => {
  it("accepts a delay plan unchanged (old rows keep parsing)", () => {
    const parsed = ChannelPlanSchema.safeParse({ mode: "text", variant: "m", delayMinutes: 15 });
    expect(parsed.success).toBe(true);
    expect(isAbsoluteChannelPlan(parsed.success ? parsed.data : null)).toBe(false);
  });
  it("accepts sendAt only together with delayMinutes 0", () => {
    const ok = ChannelPlanSchema.safeParse({ useChoice: true, delayMinutes: 0, sendAt: SEND_AT });
    expect(ok.success).toBe(true);
    expect(isAbsoluteChannelPlan(ok.success ? ok.data : null)).toBe(true);
    expect(ChannelPlanSchema.safeParse({ useChoice: true, delayMinutes: 5, sendAt: SEND_AT }).success).toBe(false);
  });
  it("rejects a malformed sendAt", () => {
    expect(ChannelPlanSchema.safeParse({ useChoice: true, delayMinutes: 0, sendAt: "ertaga" }).success).toBe(false);
  });
});

describe("ChannelScheduleBodySchema", () => {
  it("requires an ISO sendAt and keeps the selection optional", () => {
    expect(ChannelScheduleBodySchema.safeParse({ sendAt: SEND_AT }).success).toBe(true);
    expect(ChannelScheduleBodySchema.safeParse({ sendAt: SEND_AT, mode: "text", variant: "m" }).success).toBe(true);
    expect(ChannelScheduleBodySchema.safeParse({ sendAt: "2026-12-01 09:30" }).success).toBe(false);
    expect(ChannelScheduleBodySchema.safeParse({}).success).toBe(false);
  });
});
