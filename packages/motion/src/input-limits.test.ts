import { describe, expect, it } from "vitest";
import { INPUT_LIMITS, LIMITS } from "./limits.ts";
import { storyboardJsonSchema } from "./json-schema.ts";
import { base } from "./test-helpers.ts";
import { validateStoryboard, validateStoryboardJson } from "./validate.ts";

const codeScene = (code: string) => ({ type: "code", language: "typescript", code });
const diffScene = (diff: string) => ({ type: "codeDiff", language: "typescript", diff });
const timed = <T>(fn: () => T): { value: T; ms: number } => {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
};

describe("untrusted input: size caps derived from the display limits", () => {
  it("derives the code and diff caps from the line limits", () => {
    expect(INPUT_LIMITS.maxCodeChars).toBe(LIMITS.maxCodeLines * (LIMITS.maxLineChars * 2 + 1));
    expect(INPUT_LIMITS.maxDiffChars).toBe(LIMITS.maxDiffLines * (LIMITS.maxLineChars * 2 + 2));
  });

  it("a 50 MB single-line code string is rejected at once, not after ~20 s", () => {
    const { value, ms } = timed(() => validateStoryboard(base([codeScene("x".repeat(50_000_000))])));
    expect(value.ok).toBe(false);
    if (!value.ok) {
      expect(value.issues[0]?.path).toBe("scenes[0].code");
      expect(value.issues[0]?.message).toMatch(/code is 50000000 characters; the limit is 2030/);
    }
    expect(ms).toBeLessThan(1500);
  });

  it("a 50 MB single-line diff string is rejected at once", () => {
    const { value, ms } = timed(() => validateStoryboard(base([diffScene(`+${"x".repeat(50_000_000)}`)])));
    expect(value.ok).toBe(false);
    expect(ms).toBeLessThan(1500);
  });

  it("200k lines of code or diff do not make validation throw, and the issue list stays small", () => {
    for (const scene of [codeScene("a\n".repeat(200_000)), diffScene("+a\n".repeat(200_000))]) {
      const { value, ms } = timed(() => validateStoryboard(base([scene])));
      expect(value.ok).toBe(false);
      if (!value.ok) expect(value.issues.length).toBeLessThanOrEqual(INPUT_LIMITS.maxIssues + 1);
      expect(ms).toBeLessThan(1500);
    }
  });

  it("reports the real line-count problem for code just under the character cap", () => {
    const r = validateStoryboard(base([codeScene("a\n".repeat(LIMITS.maxCodeLines + 5))]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => /lines; the limit is/.test(i.message))).toBe(true);
  });

  it("stops collecting issues after a small cap and says so", () => {
    const scenes = Array.from({ length: 16 }, () => ({ type: "bullets", heading: "h".repeat(200), items: Array.from({ length: 6 }, () => "b".repeat(300)) }));
    const r = validateStoryboard(base(scenes));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.length).toBeLessThanOrEqual(INPUT_LIMITS.maxIssues + 1);
      expect(r.issues.at(-1)?.code).toBe("too_many_issues");
    }
  });

  it("rejects an oversized JSON text by byte size BEFORE parsing it", () => {
    const text = `{"version":1,"title":"${"é".repeat(INPUT_LIMITS.maxStoryboardBytes)}"}`; // 2 bytes per letter
    const { value, ms } = timed(() => validateStoryboardJson(text));
    expect(value.ok).toBe(false);
    if (!value.ok) expect(value.issues).toMatchObject([{ code: "input_too_large", path: "$", limit: INPUT_LIMITS.maxStoryboardBytes }]);
    expect(ms).toBeLessThan(200);
    // not even valid JSON, but the size verdict comes first
    const junk = validateStoryboardJson("x".repeat(INPUT_LIMITS.maxStoryboardBytes + 1));
    expect(!junk.ok && junk.issues[0]?.code).toBe("input_too_large");
  });

  it("accepts a normal storyboard well under the byte limit", () => {
    expect(validateStoryboardJson(JSON.stringify(base())).ok).toBe(true);
  });

  it("never throws, whatever it is given", () => {
    const hostile: unknown[] = [
      null,
      undefined,
      42,
      "x",
      [],
      [[]],
      { version: 1, scenes: "no" },
      { get version(): never { throw new Error("getter boom"); } },
      new Proxy({}, { get() { throw new Error("proxy boom"); }, ownKeys() { throw new Error("keys boom"); } }),
      Object.create(null),
      { ...base(), scenes: Array.from({ length: 5000 }, () => ({ type: "title" })) },
    ];
    for (const h of hostile) {
      expect(() => validateStoryboard(h)).not.toThrow();
      const r = validateStoryboard(h);
      expect(r.ok).toBe(false);
    }
    for (const text of ["", "{", "\u0000", "[]", "null", "{\"a\":1e999999}", "x".repeat(1000)]) expect(() => validateStoryboardJson(text)).not.toThrow();
  });
});

describe("scene ids", () => {
  it("rejects a duplicate scene id, naming the first use", () => {
    const r = validateStoryboard(base([{ type: "title", id: "a", title: "x" }, { type: "bullets", id: "b", heading: "h", items: ["i"] }, { type: "title", id: "a", title: "y" }]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues).toHaveLength(1);
      expect(r.issues[0]).toMatchObject({ path: "scenes[2].id", code: "custom" });
      expect(r.issues[0]?.message).toContain('"a" is already used by scene 1');
      expect(r.issues[0]?.suggestion).toBeTruthy();
    }
  });

  it("accepts unique ids and scenes without ids", () => {
    expect(validateStoryboard(base([{ type: "title", id: "a", title: "x" }, { type: "title", title: "y" }, { type: "title", title: "z" }, { type: "title", id: "b", title: "w" }])).ok).toBe(true);
  });

  it("still exports a JSON Schema", () => {
    expect(storyboardJsonSchema()).toHaveProperty("properties.scenes");
  });
});
