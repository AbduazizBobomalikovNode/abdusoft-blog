import { describe, expect, it } from "vitest";
import { readFixture } from "./test-helpers.ts";
import { INPUT_LIMITS } from "./limits.ts";
import { STRUCTURE_LIMITS, structureIssue } from "./precheck.ts";
import { validateStoryboard, validateStoryboardJson } from "./validate.ts";

const timed = <T>(fn: () => T): { value: T; ms: number } => {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
};

describe("structural pre-check (before the schema runs)", () => {
  it("every shipped fixture passes the pre-check (the limits are far above real storyboards)", () => {
    for (const name of ["showcase.json", "blog-post.json", "repository.json"]) expect(structureIssue(readFixture(name)), name).toBeNull();
  });

  it("a 256 KB flood of unknown keys is refused in a few milliseconds, not about a second", () => {
    const flood: Record<string, unknown> = { version: 1, title: "t", scenes: [{ type: "title", title: "x" }] };
    for (let i = 0; i < 12_000; i++) flood[`k${i}`] = i;
    const text = JSON.stringify(flood);
    expect(text.length).toBeLessThanOrEqual(INPUT_LIMITS.maxStoryboardBytes);
    const { value, ms } = timed(() => validateStoryboardJson(text));
    expect(value.ok).toBe(false);
    if (!value.ok) expect(value.issues[0]).toMatchObject({ code: "structure_too_large", path: "$" });
    expect(ms).toBeLessThan(150);
  });

  it("flooding a nested scene object or a list is refused too", () => {
    const scene: Record<string, unknown> = { type: "title", title: "x" };
    for (let i = 0; i < 5000; i++) scene[`u${i}`] = 1;
    const r1 = validateStoryboard({ version: 1, title: "t", scenes: [scene] });
    expect(!r1.ok && r1.issues[0]).toMatchObject({ code: "structure_too_large", path: "$.scenes[0]" });
    const r2 = validateStoryboard({ version: 1, title: "t", scenes: Array.from({ length: 5000 }, () => ({ type: "title", title: "x" })) });
    expect(!r2.ok && r2.issues[0]).toMatchObject({ code: "structure_too_large", path: "$.scenes" });
  });

  it("deep nesting and a huge total node count are refused without recursion", () => {
    let deep: unknown = "x";
    for (let i = 0; i < 50_000; i++) deep = [deep];
    expect(structureIssue(deep)?.code).toBe("structure_too_large");
    const wide = { a: Array.from({ length: 100 }, () => Array.from({ length: 100 }, () => 1)) };
    expect(structureIssue(wide)?.message).toMatch(/too many values/);
    expect(STRUCTURE_LIMITS.maxNodes).toBeGreaterThan(1000);
  });

  it("never throws on odd input", () => {
    for (const v of [null, undefined, 1, "s", [], {}, [[]], { a: null }]) expect(() => structureIssue(v)).not.toThrow();
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(structureIssue(cyc)?.code).toBe("structure_too_large");
  });
});
