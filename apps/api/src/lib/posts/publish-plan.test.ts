import { describe, expect, it } from "vitest";
import { planOnPublish, planPatchOnPublish, type PublishPlanInput } from "./publish-plan.js";

const NOW = new Date("2026-11-28T10:00:00.000Z");
const base = (over: Partial<PublishPlanInput>): PublishPlanInput => ({ stored: { mode: "text", variant: "m", delayMinutes: 30 }, kind: "manual", wasPublished: false, alreadySent: false, now: NOW, ...over });

describe("planPatchOnPublish", () => {
  it("no plan or already-published post: nothing changes", () => {
    expect(planPatchOnPublish(base({ stored: null }))).toEqual({});
    expect(planPatchOnPublish(base({ wasPublished: true }))).toEqual({});
  });
  it("delay plan: now + delay for every publish kind, attempts reset", () => {
    for (const kind of ["manual", "approve", "scheduled"] as const) {
      const patch = planPatchOnPublish(base({ kind }));
      expect(patch.channelSendAt?.toISOString()).toBe("2026-11-28T10:30:00.000Z");
      expect(patch.channelPlan).toMatchObject({ delayMinutes: 30, attempts: 0 });
    }
  });
  it("already sent or unparsable: plan cleared", () => {
    expect(planPatchOnPublish(base({ alreadySent: true }))).toEqual({ channelPlan: null, channelSendAt: null });
    expect(planPatchOnPublish(base({ stored: { junk: true } }))).toEqual({ channelPlan: null, channelSendAt: null });
  });
  it("absolute plan: future kept; past dropped on manual/approve, sent at once on scheduler", () => {
    const future = { mode: "text", variant: "m", delayMinutes: 0, sendAt: "2026-11-28T12:00:00.000Z" };
    const past = { ...future, sendAt: "2026-11-28T08:00:00.000Z" };
    expect(planPatchOnPublish(base({ stored: future })).channelSendAt?.toISOString()).toBe(future.sendAt);
    expect(planPatchOnPublish(base({ stored: past }))).toEqual({ channelPlan: null, channelSendAt: null });
    expect(planPatchOnPublish(base({ stored: past, kind: "approve" }))).toEqual({ channelPlan: null, channelSendAt: null });
    expect(planPatchOnPublish(base({ stored: past, kind: "scheduled" })).channelSendAt).toEqual(NOW);
  });
});

describe("planOnPublish outcome", () => {
  it("reports none / armed / dropped with the reason", () => {
    expect(planOnPublish(base({ stored: null })).outcome).toEqual({ state: "none" });
    expect(planOnPublish(base({})).outcome).toEqual({ state: "armed", at: "2026-11-28T10:30:00.000Z" });
    expect(planOnPublish(base({ alreadySent: true })).outcome).toEqual({ state: "dropped", reason: "already_sent" });
    expect(planOnPublish(base({ stored: { junk: 1 } })).outcome).toEqual({ state: "dropped", reason: "invalid" });
    const past = { mode: "text", variant: "m", delayMinutes: 0, sendAt: "2026-11-28T08:00:00.000Z" };
    expect(planOnPublish(base({ stored: past })).outcome).toEqual({ state: "dropped", reason: "past_time" });
  });
  it("an actor without channel rights never arms: the plan is dropped (published post never keeps plan with NULL send_at)", () => {
    const r = planOnPublish(base({ mayTouchChannel: false }));
    expect(r.patch).toEqual({ channelPlan: null, channelSendAt: null });
    expect(r.outcome).toEqual({ state: "dropped", reason: "no_permission" });
    for (const kind of ["manual", "approve", "scheduled"] as const) {
      const out = planOnPublish(base({ kind, stored: { mode: "text", variant: "m", delayMinutes: 0, sendAt: "2026-11-28T12:00:00.000Z" } }));
      expect(out.patch.channelPlan == null || out.patch.channelSendAt != null).toBe(true);
    }
  });
});

