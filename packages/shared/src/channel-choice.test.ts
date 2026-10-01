import { describe, expect, it } from "vitest";
import { ChannelChoiceSchema, ChannelPlanSchema } from "./dto.js";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("ChannelChoiceSchema", () => {
  it("accepts valid auto combos and versions", () => {
    expect(ChannelChoiceSchema.safeParse({ kind: "auto", mode: "text", variant: "xl" }).success).toBe(true);
    expect(ChannelChoiceSchema.safeParse({ kind: "auto", mode: "media", variant: "l" }).success).toBe(true);
    expect(ChannelChoiceSchema.safeParse({ kind: "version", versionId: UUID }).success).toBe(true);
  });

  it("rejects invalid combos and malformed input", () => {
    expect(ChannelChoiceSchema.safeParse({ kind: "auto", mode: "media", variant: "xl" }).success).toBe(false);
    expect(ChannelChoiceSchema.safeParse({ kind: "auto", mode: "media", variant: "s" }).success).toBe(false);
    expect(ChannelChoiceSchema.safeParse({ kind: "version", versionId: "nope" }).success).toBe(false);
    expect(ChannelChoiceSchema.safeParse({ kind: "auto", mode: "text" }).success).toBe(false);
  });
});

describe("ChannelPlanSchema", () => {
  it("accepts { useChoice, delayMinutes } without mode/variant, and keeps explicit plans valid", () => {
    expect(ChannelPlanSchema.safeParse({ useChoice: true, delayMinutes: 0 }).success).toBe(true);
    expect(ChannelPlanSchema.safeParse({ mode: "text", variant: "m", delayMinutes: 5 }).success).toBe(true);
    expect(ChannelPlanSchema.safeParse({ mode: "text", versionId: UUID, delayMinutes: 0 }).success).toBe(true);
  });

  it("still rejects plans that choose nothing or an invalid combo", () => {
    expect(ChannelPlanSchema.safeParse({ delayMinutes: 0 }).success).toBe(false);
    expect(ChannelPlanSchema.safeParse({ mode: "media", variant: "xl", delayMinutes: 0 }).success).toBe(false);
  });
});
