import { describe, expect, it } from "vitest";
import { LIMITS } from "./limits.ts";
import { formatIssues, type StoryboardIssue } from "./schema/issues.ts";
import { base, readFixture } from "./test-helpers.ts";
import { validateStoryboard, validateStoryboardJson } from "./validate.ts";

function issues(input: unknown): StoryboardIssue[] {
  const r = validateStoryboard(input);
  if (r.ok) throw new Error("expected the storyboard to be rejected");
  return r.issues;
}
const only = (input: unknown): StoryboardIssue => {
  const list = issues(input);
  expect(list).toHaveLength(1);
  return list[0] as StoryboardIssue;
};

describe("storyboard acceptance", () => {
  it("accepts both example fixtures", () => {
    for (const name of ["blog-post.json", "repository.json"]) {
      const r = validateStoryboard(readFixture(name));
      expect(r.ok, name).toBe(true);
    }
  });

  it("fills defaults: siteName, format, defaultTransition", () => {
    const r = validateStoryboard(base());
    if (!r.ok) throw new Error(formatIssues(r.issues));
    expect(r.storyboard.siteName).toBe("abdusoft");
    expect(r.storyboard.format).toBe("landscape");
    expect(r.storyboard.defaultTransition).toBe("fade");
  });

  it("accepts #RGB and #RRGGBB accents", () => {
    expect(validateStoryboard({ ...base(), accent: "#63f" }).ok).toBe(true);
    expect(validateStoryboard({ ...base(), accent: "#6366F1" }).ok).toBe(true);
  });

  it("reports invalid JSON text as an issue instead of throwing", () => {
    const r = validateStoryboardJson("{ nope");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues[0]?.code).toBe("invalid_json");
      expect(r.issues[0]?.path).toBe("$");
    }
  });
});

describe("storyboard rejection: exact, actionable messages", () => {
  it("rejects unknown keys with the allowed list and a did-you-mean", () => {
    const i = only(base([{ type: "title", title: "A", subtitel: "b" }]));
    expect(i.path).toBe("scenes[0]");
    expect(i.message).toBe(
      'unknown key "subtitel"; allowed keys: type, id, durationSeconds, transition, kicker, title, subtitle, tags, layout',
    );
    expect(i.suggestion).toBe('Did you mean "subtitel" -> "subtitle"? Remove keys the schema does not define.');
  });

  it("rejects unknown top-level keys", () => {
    const i = only({ ...base(), music: "x" });
    expect(i.path).toBe("$");
    expect(i.message).toContain('unknown key "music"');
  });

  it("rejects a title that is too long, quoting limit and actual", () => {
    const i = only(base([{ type: "title", title: "x".repeat(LIMITS.title + 13) }]));
    expect(i).toMatchObject({ path: "scenes[0].title", limit: 80, actual: 93 });
    expect(i.message).toBe("title is 93 characters; the limit is 80");
    expect(i.suggestion).toBe("Shorten it to the key idea, or move detail into 'subtitle'.");
  });

  it("rejects a bullet that is too long and names the bullet", () => {
    const items = ["ok", "y".repeat(LIMITS.bullet + 1)];
    const i = only(base([{ type: "bullets", heading: "H", items }]));
    expect(i.path).toBe("scenes[0].items[1]");
    expect(i.message).toBe("bullet 2 is 81 characters; the limit is 80");
  });

  it("rejects too many bullets / scenes / tags", () => {
    const items = Array.from({ length: 7 }, (_, n) => `p${n}`);
    expect(only(base([{ type: "bullets", heading: "H", items }])).message).toBe("items has 7 entries; the limit is 6");
    const scenes = Array.from({ length: 17 }, () => ({ type: "title", title: "A", durationSeconds: 1 }));
    expect(only(base(scenes)).message).toBe("scenes has 17 scenes; the limit is 16");
    const tags = ["a", "b", "c", "d", "e", "f"];
    expect(only(base([{ type: "title", title: "A", tags }])).message).toBe("tags has 6 entries; the limit is 5");
  });

  it("rejects an empty bullet list", () => {
    expect(only(base([{ type: "bullets", heading: "H", items: [] }])).message).toBe("items must contain at least one bullet");
  });

  it("rejects line breaks in single-line text", () => {
    const i = only(base([{ type: "title", title: "A\nB" }]));
    expect(i.message).toBe("title must be a single line without line breaks, tabs or control characters");
    expect(i.path).toBe("scenes[0].title");
  });

  it("rejects an unknown scene type with a suggestion", () => {
    const i = only(base([{ type: "bulets", heading: "H", items: ["a"] }]));
    expect(i.path).toBe("scenes[0].type");
    expect(i.message).toBe('unknown scene type "bulets"; supported types: title, bullets, code, terminal, outro, intro, closing, diagram, compare, stat, steps, quote, codeDiff');
    expect(i.suggestion).toBe('Did you mean "bullets"?');
  });

  it("rejects an unsupported format with the reason", () => {
    const i = only({ ...base(), format: "vertical" });
    expect(i.path).toBe("format");
    expect(i.message).toBe('format "vertical" is not enabled yet; only "landscape" (1920x1080 @ 30 fps) is accepted');
  });

  it("rejects a wrong version and a bad accent", () => {
    expect(only({ ...base(), version: 2 }).message).toBe("version must be 1; got 2");
    expect(only({ ...base(), accent: "blue" }).message).toBe("accent must be a hex colour like #6366f1 or #63f");
  });

  it("suggests the canonical language for aliases", () => {
    const i = only(base([{ type: "code", language: "ts", code: "a" }]));
    expect(i.path).toBe("scenes[0].language");
    expect(i.suggestion).toBe('Did you mean "typescript"?');
  });

  it("reports a missing required field", () => {
    const i = only(base([{ type: "outro", url: "a.uz" }]));
    expect(i.path).toBe("scenes[0].cta");
    expect(i.message).toMatch(/^cta is required but missing/);
  });

  it("limits code lines, line length, tabs and step ranges", () => {
    const tooMany = Array.from({ length: 15 }, (_, n) => `l${n}`).join("\n");
    const a = only(base([{ type: "code", language: "text", code: tooMany }]));
    expect(a).toMatchObject({ path: "scenes[0].code", limit: 14, actual: 15 });
    expect(a.message).toBe("code has 15 lines; the limit is 14");

    const long = only(base([{ type: "code", language: "text", code: `ok\n${"x".repeat(73)}` }]));
    expect(long).toMatchObject({ limit: 72, actual: 73 });
    expect(long.message).toBe("code line 2 has 73 characters; the limit is 72");

    expect(only(base([{ type: "code", language: "text", code: "a\tb" }])).message).toBe("code contains a tab character");

    const range = only(base([{ type: "code", language: "text", code: "a\nb", steps: [{ lines: { from: 1, to: 5 } }] }]));
    expect(range.path).toBe("scenes[0].steps[0].lines.to");
    expect(range.message).toBe("lines.to is 5 but the code has only 2 lines");

    const swapped = only(base([{ type: "code", language: "text", code: "a\nb", steps: [{ lines: { from: 2, to: 1 } }] }]));
    expect(swapped.message).toBe("lines.from (2) is greater than lines.to (1)");
  });

  it("limits terminal entries and requires a command", () => {
    const lines = Array.from({ length: 13 }, () => ({ kind: "command", text: "ls" }));
    expect(only(base([{ type: "terminal", lines }])).message).toBe("lines has 13 entries; the limit is 12");
    expect(only(base([{ type: "terminal", lines: [{ kind: "output", text: "x" }] }])).message).toBe("a terminal scene needs at least one command");
    const longCmd = only(base([{ type: "terminal", lines: [{ kind: "command", text: "c".repeat(73) }] }]));
    expect(longCmd.message).toBe("command text is 73 characters; the limit is 72");
    expect(longCmd.path).toBe("scenes[0].lines[0].text");
  });

  it("rejects a durationSeconds outside 1-30", () => {
    expect(only(base([{ type: "title", title: "A", durationSeconds: 31 }])).message).toBe("durationSeconds is 31; the maximum is 30");
    expect(only(base([{ type: "title", title: "A", durationSeconds: 0.5 }])).message).toBe("durationSeconds is 0.5; the minimum is 1");
  });

  it("collects every problem at once, each with a path", () => {
    const list = issues(base([{ type: "title", title: "x".repeat(90), tags: "no" }, { type: "outro" }]));
    expect(list.length).toBeGreaterThanOrEqual(4);
    for (const i of list) expect(i.path).toMatch(/^[$a-zA-Z]/);
    expect(formatIssues(list)).toContain("1. scenes[0]");
  });
});

describe("timing limits (stage two)", () => {
  it("rejects an explicit duration shorter than the content needs", () => {
    const i = only(base([{ type: "bullets", heading: "H", items: ["one", "two", "three", "four"], durationSeconds: 3 }]));
    expect(i.path).toBe("scenes[0].durationSeconds");
    expect(i.code).toBe("duration_too_short");
    expect(i.message).toMatch(/^durationSeconds 3 is shorter than this bullets scene needs: its animation only finishes after \d+(\.\d)? s$/);
    expect(i.suggestion).toMatch(/Remove durationSeconds \(automatic length: [\d.]+ s\) or set it to [\d.]+ or more/);
  });

  it("the suggested minimum is itself accepted", () => {
    const scene = { type: "bullets", heading: "H", items: ["one", "two", "three", "four"] };
    const i = only(base([{ ...scene, durationSeconds: 3 }]));
    const min = Number(/set it to ([\d.]+) or more/.exec(i.suggestion ?? "")?.[1]);
    expect(validateStoryboard(base([{ ...scene, durationSeconds: min }])).ok).toBe(true);
  });

  it("rejects a total above 60 s and names the longest scenes", () => {
    const scenes = Array.from({ length: 5 }, () => ({ type: "title", title: "A", durationSeconds: 15 }));
    const i = only(base(scenes));
    expect(i.path).toBe("scenes");
    expect(i.code).toBe("total_too_long");
    expect(i.limit).toBe(60);
    expect(i.message).toMatch(/^total duration is \d+(\.\d)? s; the limit is 60 s$/);
    expect(i.suggestion).toContain("Longest scenes: scenes[");
    expect(i.suggestion).toContain("explicit");
  });

  it("accepts exactly 60 s", () => {
    const scenes = [
      { type: "title", title: "A", durationSeconds: 30, transition: "cut" },
      { type: "title", title: "B", durationSeconds: 30, transition: "cut" },
    ];
    const r = validateStoryboard(base(scenes));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.timeline.totalSeconds).toBe(60);
  });
});
