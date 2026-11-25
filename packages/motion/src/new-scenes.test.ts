import { describe, expect, it } from "vitest";
import { layoutDiagram } from "./diagram-layout.ts";
import { LIMITS } from "./limits.ts";
import { type StoryboardIssue } from "./schema/issues.ts";
import { parseDiff, SHOWPIECE_VARIANTS, storyboardSchema } from "./schema/storyboard.ts";
import { resolveScene, sceneReviewFrames } from "./scene-ref.ts";
import { base } from "./test-helpers.ts";
import { computeTimeline } from "./timeline.ts";
import { FPS, LOOP_FRAMES, TRANSITION_FRAMES } from "./timing.ts";
import { validateStoryboard } from "./validate.ts";

function issues(input: unknown): StoryboardIssue[] {
  const r = validateStoryboard(input);
  if (r.ok) throw new Error("expected the storyboard to be rejected");
  return r.issues;
}
const only = (input: unknown): StoryboardIssue => {
  const list = issues(input);
  expect(list, JSON.stringify(list)).toHaveLength(1);
  return list[0] as StoryboardIssue;
};
const ok = (scenes: unknown[], extra: Record<string, unknown> = {}) => {
  const r = validateStoryboard({ ...base(scenes), ...extra });
  if (!r.ok) throw new Error(JSON.stringify(r.issues, null, 1));
  return r;
};

const nodes = (...ids: string[]) => ids.map((id) => ({ id, label: id.toUpperCase() }));
const chain = (...ids: string[]) => ids.slice(1).map((to, i) => ({ from: ids[i] as string, to }));

describe("storyboard-level additions", () => {
  it("accepts every preset and rejects an unknown one with a suggestion", () => {
    for (const preset of ["default", "vivid", "blueprint", "neon"]) ok([{ type: "title", title: "A" }], { preset });
    const i = only({ ...base(), preset: "neonn" });
    expect(i.path).toBe("preset");
    expect(i.message).toBe('preset must be one of: default, vivid, blueprint, neon; got "neonn"');
    expect(i.suggestion).toBe('Did you mean "neon"?');
  });

  it("accepts the new transitions per scene and as the default", () => {
    for (const t of ["wipe", "push", "zoom"]) {
      ok([{ type: "title", title: "A" }, { type: "title", title: "B", transition: t }], { defaultTransition: t });
    }
    expect(only(base([{ type: "title", title: "A" }, { type: "title", title: "B", transition: "dissolve" }])).message).toBe(
      'transition must be one of: cut, fade, slide, wipe, push, zoom; got "dissolve"',
    );
  });

  it("title and bullets layouts are optional and validated", () => {
    ok([{ type: "title", title: "A", layout: "split" }, { type: "bullets", heading: "H", items: ["x"], layout: "centered" }]);
    expect(only(base([{ type: "title", title: "A", layout: "middle" }])).message).toBe('layout must be one of: left, centered, split; got "middle"');
    expect(only(base([{ type: "bullets", heading: "H", items: ["x"], layout: "left" }])).suggestion).toBe("Use one of: list, centered, split.");
  });
});

describe("intro and closing", () => {
  it("accept every variant, with and without optional fields", () => {
    for (const variant of SHOWPIECE_VARIANTS) {
      ok([{ type: "intro", variant, title: "Salom" }, { type: "closing", variant, cta: "Oʻqing", url: "abdusoft.uz" }]);
    }
    ok([{ type: "intro", title: "Salom", kicker: "k", subtitle: "s", tags: ["a"] }]);
  });

  it("reject an unknown variant with a did-you-mean", () => {
    const i = only(base([{ type: "intro", variant: "auroraa", title: "A" }]));
    expect(i.path).toBe("scenes[0].variant");
    expect(i.message).toBe(`variant must be one of: ${SHOWPIECE_VARIANTS.join(", ")}; got "auroraa"`);
    expect(i.suggestion).toBe('Did you mean "aurora"?');
  });

  it("enforce the text limits of title and cta/url", () => {
    expect(only(base([{ type: "intro", title: "x".repeat(81) }])).message).toBe("title is 81 characters; the limit is 80");
    expect(only(base([{ type: "closing", cta: "x".repeat(61), url: "a.uz" }])).message).toBe("cta is 61 characters; the limit is 60");
    expect(only(base([{ type: "closing", cta: "c", url: "a b" }])).message).toBe("url text must not contain spaces");
    expect(only(base([{ type: "closing", cta: "c" }])).message).toMatch(/^url is required but missing/);
  });

  it("list their own allowed keys in unknown-key errors", () => {
    expect(only(base([{ type: "intro", title: "A", ctaa: "x" }])).message).toContain("allowed keys: type, id, durationSeconds, transition, variant, kicker, title, subtitle, tags");
    expect(only(base([{ type: "closing", cta: "c", url: "a.uz", subtitle: "x" }])).message).toContain("allowed keys: type, id, durationSeconds, transition, variant, siteName, cta, url");
  });

  it("have a 3.5-8 s automatic length, and the closing holds one loop period", () => {
    const r = ok([{ type: "intro", title: "Salom dunyo" }, { type: "closing", cta: "Oʻqing", url: "abdusoft.uz" }], { defaultTransition: "fade" });
    const [a, b] = r.timeline.scenes;
    for (const s of [a, b]) {
      expect((s?.durationFrames ?? 0) / FPS).toBeGreaterThanOrEqual(3.5);
      expect((s?.durationFrames ?? 0) / FPS).toBeLessThanOrEqual(8);
    }
    expect(a?.loop).toBeNull();
    expect(b?.loop).toEqual({ startFrame: (b?.endFrame ?? 0) - LOOP_FRAMES, frames: LOOP_FRAMES });
    // the loop window starts after the animation has settled
    expect(b?.loop?.startFrame).toBeGreaterThanOrEqual((b?.startFrame ?? 0) + (b?.leadFrames ?? 0) + (b?.doneAt ?? 0));
    expect(b?.content).toMatchObject({ type: "closing", loopFrames: LOOP_FRAMES, variant: "aurora" });
  });

  it("explicit durations cannot cut the animation short", () => {
    const i = only(base([{ type: "intro", title: "A", durationSeconds: 1 }]));
    expect(i.code).toBe("duration_too_short");
    expect(i.message).toMatch(/shorter than this intro scene needs/);
  });
});

describe("diagram", () => {
  const good = { type: "diagram", nodes: nodes("a", "b", "c"), edges: chain("a", "b", "c") };

  it("accepts a pipeline, both directions, with steps", () => {
    ok([good]);
    ok([{ ...good, direction: "tb", steps: [{ nodes: ["a", "b"], label: "Birinchi" }, { nodes: ["c"] }] }]);
  });

  it("rejects an edge to an unknown node with the defined ids and a suggestion", () => {
    const i = only(base([{ ...good, edges: [{ from: "a", to: "bb" }, { from: "b", to: "c" }] }]));
    expect(i.path).toBe("scenes[0].edges[0].to");
    expect(i.message).toBe('unknown node id "bb"; defined ids: a, b, c');
    expect(i.suggestion).toBe('Did you mean "b"?');
  });

  it("rejects unknown ids in steps, duplicate ids, self-loops and orphan nodes", () => {
    expect(only(base([{ ...good, steps: [{ nodes: ["zz"] }] }])).path).toBe("scenes[0].steps[0].nodes[0]");
    const dup = only(base([{ ...good, nodes: nodes("a", "b", "c", "a") }]));
    expect(dup.message).toBe('duplicate node id "a"');
    expect(dup.path).toBe("scenes[0].nodes[3].id");
    expect(only(base([{ ...good, edges: [{ from: "a", to: "a" }, { from: "a", to: "b" }, { from: "b", to: "c" }] }])).message).toBe('edge 1 connects "a" to itself');
    const orphan = only(base([{ ...good, nodes: nodes("a", "b", "c", "d") }]));
    expect(orphan.message).toBe('node "d" is not connected to any edge');
    expect(orphan.suggestion).toBe('Add an edge from or to "d", or remove the node.');
  });

  it("limits nodes, edges, label lengths and node ids", () => {
    const many = nodes("a", "b", "c", "d", "e", "f", "g", "h", "i");
    expect(issues(base([{ type: "diagram", nodes: many, edges: chain("a", "b") }])).map((x) => x.message)).toContain("nodes has 9 entries; the limit is 8");
    expect(only(base([{ ...good, nodes: [{ id: "a", label: "x".repeat(25) }, ...nodes("b", "c")] }])).message).toBe("label is 25 characters; the limit is 24");
    expect(issues(base([{ ...good, nodes: [{ id: "A B", label: "x" }, ...nodes("b", "c")] }]))[0]?.message).toMatch(/^node id must be 1-24 chars/);
    const few = issues(base([{ type: "diagram", nodes: nodes("a"), edges: [] }]));
    expect(few.map((x) => x.message)).toEqual(["a diagram needs at least 2 nodes", "a diagram needs at least one edge"]);
    expect(few[0]?.suggestion).toBe('Add at least two nodes, e.g. { "id": "api", "label": "API" }, and connect them with an edge.');
  });

  it("limits the longest chain per direction and the nodes side by side", () => {
    const six = nodes("a", "b", "c", "d", "e", "f");
    const lr = only(base([{ type: "diagram", nodes: six, edges: chain("a", "b", "c", "d", "e", "f") }]));
    expect(lr).toMatchObject({ path: "scenes[0].edges", limit: 5, actual: 6 });
    expect(lr.message).toBe('the longest chain has 6 nodes; the limit is 5 for direction "lr"');
    const tb = only(base([{ type: "diagram", direction: "tb", nodes: nodes("a", "b", "c", "d", "e"), edges: chain("a", "b", "c", "d", "e") }]));
    expect(tb.message).toBe('the longest chain has 5 nodes; the limit is 4 for direction "tb"');
    const wide = only(base([{ type: "diagram", nodes: nodes("s", "a", "b", "c", "d", "e"), edges: ["a", "b", "c", "d", "e"].map((to) => ({ from: "s", to })) }]));
    expect(wide.message).toBe("5 nodes would sit side by side in one layer; the limit is 4");
  });

  it("lists allowed keys for nodes, edges and steps", () => {
    expect(only(base([{ ...good, nodes: [{ id: "a", label: "A", colour: "x" }, ...nodes("b", "c")] }])).message).toBe('unknown key "colour"; allowed keys: id, label, detail, tone');
    expect(only(base([{ ...good, edges: [{ from: "a", to: "b", text: "x" }, { from: "b", to: "c" }] }])).message).toBe('unknown key "text"; allowed keys: from, to, label');
  });

  it("tolerates cycles: the return edge becomes a back edge", () => {
    const r = ok([{ type: "diagram", nodes: nodes("a", "b", "c"), edges: [...chain("a", "b", "c"), { from: "c", to: "a", label: "retry" }] }]);
    const c = r.timeline.scenes[0]?.content;
    expect(c?.type).toBe("diagram");
  });

  it("timeline: nodes appear along their first incoming edge, edges draw in order, steps follow the drawing", () => {
    const r = ok([{ ...good, steps: [{ nodes: ["a"], label: "x" }, { nodes: ["b", "c"] }] }]);
    const c = r.timeline.scenes[0]?.content;
    if (c?.type !== "diagram") throw new Error("not a diagram");
    expect(c.edgeAt[1]).toBeGreaterThan(c.edgeAt[0] ?? 0);
    expect(c.nodeAt[0]).toBeLessThan(c.nodeAt[1] ?? 0);
    expect(c.nodeAt[1]).toBeLessThan(c.nodeAt[2] ?? 0);
    expect(c.steps[0]?.start).toBeGreaterThan((c.edgeAt.at(-1) ?? 0) + c.edgeFrames);
    expect(c.steps[1]?.start).toBe(c.steps[0]?.end);
  });
});

describe("layoutDiagram", () => {
  it("layers a pipeline left to right and stacks parallel branches", () => {
    const lay = layoutDiagram(nodes("in", "a", "b", "out"), [
      { from: "in", to: "a" },
      { from: "in", to: "b" },
      { from: "a", to: "out" },
      { from: "b", to: "out" },
    ]);
    expect(lay.layers).toBe(3);
    expect(lay.widest).toBe(2);
    expect(lay.place.in).toEqual({ layer: 0, slot: 0, count: 1 });
    expect(lay.place.a?.layer).toBe(1);
    expect(lay.place.b?.layer).toBe(1);
    expect(new Set([lay.place.a?.slot, lay.place.b?.slot])).toEqual(new Set([0, 1]));
    expect(lay.place.out?.layer).toBe(2);
    expect(lay.order).toEqual(["in", "a", "b", "out"]);
  });

  it("is deterministic and marks back edges", () => {
    const edges = [...chain("a", "b", "c"), { from: "c", to: "a" }];
    const a = layoutDiagram(nodes("a", "b", "c"), edges);
    expect(a).toEqual(layoutDiagram(nodes("a", "b", "c"), edges));
    expect(a.backEdges).toEqual([2]);
    expect(a.layers).toBe(3);
  });
});

describe("compare", () => {
  const good = { type: "compare", left: { title: "Oldin", items: ["a", "b"] }, right: { title: "Keyin", items: ["c", "d"] } };

  it("accepts versus and beforeAfter with a verdict", () => {
    ok([good]);
    ok([{ ...good, mode: "beforeAfter", heading: "H", verdict: "Tezroq" }]);
  });

  it("rejects an unbalanced pair, naming both counts", () => {
    const i = only(base([{ ...good, right: { title: "K", items: ["1", "2", "3", "4", "5"] }, left: { title: "O", items: ["1"] } }]));
    expect(i.message).toBe("the columns are unbalanced: left has 1 items, right has 5");
    expect(i.path).toBe("scenes[0].right.items");
  });

  it("limits titles, items and the item count, and names the side", () => {
    expect(only(base([{ ...good, left: { title: "x".repeat(29), items: ["a"] } }])).message).toBe("title is 29 characters; the limit is 28");
    const i = only(base([{ ...good, right: { title: "K", items: ["c", "y".repeat(61)] } }]));
    expect(i.message).toBe("right item 2 is 61 characters; the limit is 60");
    expect(i.path).toBe("scenes[0].right.items[1]");
    expect(only(base([{ ...good, left: { title: "O", items: ["1", "2", "3", "4", "5", "6"] }, right: { title: "K", items: ["1", "2", "3", "4", "5"] } }])).message).toBe("items has 6 entries; the limit is 5");
    expect(only(base([{ ...good, left: { title: "O", items: [] } }])).message).toBe("items must contain at least one entry");
  });

  it("timeline: items alternate left and right and the verdict comes last", () => {
    const c = ok([{ ...good, verdict: "Xulosa" }]).timeline.scenes[0]?.content;
    if (c?.type !== "compare") throw new Error("not compare");
    expect(c.leftItemAt[0]).toBeLessThan(c.rightItemAt[0] ?? 0);
    expect(c.rightItemAt[0]).toBeLessThan(c.leftItemAt[1] ?? 0);
    expect(c.verdictAt).toBeGreaterThan(c.rightItemAt[1] ?? 0);
  });
});

describe("stat", () => {
  it("accepts one to three numbers with prefix, suffix, decimals and a note", () => {
    ok([{ type: "stat", heading: "H", stats: [{ value: 1200, label: "foydalanuvchi", suffix: "+" }] }]);
    ok([{ type: "stat", stats: [{ value: 99.9, decimals: 1, suffix: "%", label: "uptime", note: "2025" }, { value: -4.25, decimals: 2, label: "o'zgarish" }, { value: 0, label: "xato", prefix: "$" }] }]);
  });

  it("rejects no numbers, more than three, non-finite and out-of-range values", () => {
    expect(only(base([{ type: "stat", stats: [] }])).message).toBe("stats must contain at least one number");
    const four = Array.from({ length: 4 }, () => ({ value: 1, label: "x" }));
    expect(only(base([{ type: "stat", stats: four }])).message).toBe("stats has 4 entries; the limit is 3");
    expect(only(base([{ type: "stat", stats: [{ value: 1e12, label: "x" }] }])).message).toBe("value is 1000000000000; the maximum is 999999999");
    expect(only(base([{ type: "stat", stats: [{ value: "12", label: "x" }] }])).message).toBe("value must be number; got string");
  });

  it("asks for decimals when the value needs them", () => {
    const i = only(base([{ type: "stat", stats: [{ value: 3.14, label: "pi" }] }]));
    expect(i.path).toBe("scenes[0].stats[0].value");
    expect(i.message).toBe("value 3.14 has more decimals than decimals: 0 can show");
    expect(i.suggestion).toBe('Set "decimals": 1 (or round the value).');
    expect(only(base([{ type: "stat", stats: [{ value: 3.14, decimals: 3, label: "pi" }] }])).message).toBe("decimals is 3; the maximum is 2");
  });

  it("limits label, note and affixes", () => {
    expect(only(base([{ type: "stat", stats: [{ value: 1, label: "x".repeat(41) }] }])).message).toBe("label is 41 characters; the limit is 40");
    expect(only(base([{ type: "stat", stats: [{ value: 1, label: "x", suffix: "1234567" }] }])).message).toBe("suffix is 7 characters; the limit is 6");
    expect(only(base([{ type: "stat", stats: [{ value: 1, label: "x", extra: 1 }] }])).message).toBe('unknown key "extra"; allowed keys: value, decimals, prefix, suffix, label, note');
  });

  it("timeline: numbers start staggered and the count finishes before the scene settles", () => {
    const r = ok([{ type: "stat", stats: [{ value: 1, label: "a" }, { value: 2, label: "b" }, { value: 3, label: "c" }] }]);
    const t = r.timeline.scenes[0];
    const c = t?.content;
    if (c?.type !== "stat") throw new Error("not stat");
    expect(c.statAt).toHaveLength(3);
    expect(c.statAt[2]).toBeGreaterThan(c.statAt[0] ?? 0);
    expect((c.statAt[2] ?? 0) + c.countFrames).toBeLessThanOrEqual(t?.doneAt ?? 0);
  });
});

describe("steps", () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `Qadam ${i + 1}`, detail: "tafsilot" }));

  it("accepts 2-5 horizontal and 2-6 vertical steps", () => {
    ok([{ type: "steps", items: items(2) }]);
    ok([{ type: "steps", items: items(5) }]);
    ok([{ type: "steps", layout: "vertical", items: items(6), heading: "H" }]);
  });

  it("rejects too few and too many, with the vertical suggestion for six horizontal steps", () => {
    expect(only(base([{ type: "steps", items: items(1) }])).message).toBe("steps needs at least 2 items");
    expect(only(base([{ type: "steps", layout: "vertical", items: items(7) }])).message).toBe("items has 7 entries; the limit is 6");
    const i = only(base([{ type: "steps", items: items(6) }]));
    expect(i.message).toBe("a horizontal timeline holds at most 5 steps; got 6");
    expect(i.suggestion).toBe('Set "layout": "vertical" (up to 6 steps) or merge two steps.');
  });

  it("limits title and detail", () => {
    expect(only(base([{ type: "steps", items: [{ title: "x".repeat(41) }, { title: "b" }] }])).message).toBe("title is 41 characters; the limit is 40");
    expect(only(base([{ type: "steps", items: [{ title: "a", detail: "x".repeat(81) }, { title: "b" }] }])).message).toBe("detail is 81 characters; the limit is 80");
  });

  it("timeline: the active step advances in order and the last one stays", () => {
    const c = ok([{ type: "steps", items: items(4) }]).timeline.scenes[0]?.content;
    if (c?.type !== "steps") throw new Error("not steps");
    for (let i = 1; i < c.activeAt.length; i++) expect(c.activeAt[i]).toBeGreaterThan(c.activeAt[i - 1] ?? 0);
  });
});

describe("quote", () => {
  it("accepts a quote with and without author and role", () => {
    ok([{ type: "quote", quote: "Oddiylik — ishonchlilikning sharti." }]);
    ok([{ type: "quote", quote: "q", author: "Edsger Dijkstra", role: "informatik" }]);
  });

  it("limits the quote at 200 characters and rejects line breaks", () => {
    const i = only(base([{ type: "quote", quote: "x".repeat(201) }]));
    expect(i).toMatchObject({ path: "scenes[0].quote", limit: 200, actual: 201 });
    expect(i.message).toBe("quote is 201 characters; the limit is 200");
    expect(only(base([{ type: "quote", quote: "a\nb" }])).message).toBe("quote must be a single line without line breaks, tabs or control characters");
    expect(only(base([{ type: "quote", quote: "q", author: "x".repeat(41) }])).message).toBe("author is 41 characters; the limit is 40");
  });

  it("a longer quote takes longer on screen", () => {
    const short = ok([{ type: "quote", quote: "Qisqa." }]).timeline.scenes[0];
    const long = ok([{ type: "quote", quote: "so'z ".repeat(38).trim() }]).timeline.scenes[0];
    expect(long?.durationFrames).toBeGreaterThan(short?.durationFrames ?? 0);
  });
});

describe("codeDiff", () => {
  const good = { type: "codeDiff", language: "typescript", fileName: "a.ts", diff: " const a = 1;\n-const b = 2;\n+const b = 3;\n" };

  it("parses unified-style lines", () => {
    expect(parseDiff(good.diff)).toEqual([
      { op: "context", text: "const a = 1;" },
      { op: "remove", text: "const b = 2;" },
      { op: "add", text: "const b = 3;" },
    ]);
    expect(parseDiff("+a\n\n-b")[1]).toEqual({ op: "context", text: "" });
  });

  it("accepts a diff and rejects one without changes", () => {
    ok([good]);
    expect(only(base([{ ...good, diff: " a\n b" }])).message).toBe("diff has no added or removed lines");
  });

  it("names the offending line when a marker is missing", () => {
    const i = only(base([{ ...good, diff: " ok\nconst b = 3;\n+x" }]));
    expect(i.message).toBe('diff line 2 starts with "c"; every line must start with "+", "-" or a space');
    expect(i.suggestion).toBe('Prefix line 2 with "+" (added), "-" (removed) or a single space (unchanged).');
  });

  it("limits lines and line length, rejects tabs", () => {
    const many = Array.from({ length: 15 }, (_, n) => `+l${n}`).join("\n");
    expect(only(base([{ ...good, diff: many }])).message).toBe("diff has 15 lines; the limit is 14");
    const long = only(base([{ ...good, diff: `+${"x".repeat(73)}` }]));
    expect(long.message).toBe("diff line 1 has 73 characters after the marker; the limit is 72");
    expect(only(base([{ ...good, diff: "+a\tb" }])).message).toBe("diff contains a tab character");
  });

  it("timeline: added lines slide in one after another after the removal mark", () => {
    const c = ok([good]).timeline.scenes[0]?.content;
    if (c?.type !== "codeDiff") throw new Error("not codeDiff");
    expect(c.addAt).toEqual([null, null, expect.any(Number)]);
    expect(c.addAt[2]).toBeGreaterThan(c.removeAt);
  });
});

describe("transitions in the timeline", () => {
  it("wipe, push and zoom overlap the scenes by their own frame counts", () => {
    for (const kind of ["wipe", "push", "zoom"] as const) {
      const tl = computeTimeline(storyboardSchema.parse(base([{ type: "title", title: "A", durationSeconds: 5 }, { type: "title", title: "B", durationSeconds: 5, transition: kind }])));
      expect(tl.scenes[1]?.enter).toEqual({ kind, frames: TRANSITION_FRAMES[kind] });
      expect(tl.scenes[1]?.startFrame).toBe(150 - TRANSITION_FRAMES[kind]);
      expect(tl.scenes[0]?.exit).toEqual({ kind, frames: TRANSITION_FRAMES[kind] });
    }
  });

  it("transitions stay within the 60 s budget arithmetic", () => {
    expect(Math.max(...Object.values(TRANSITION_FRAMES))).toBeLessThanOrEqual(30);
  });
});

describe("single scene selection", () => {
  const tl = computeTimeline(
    storyboardSchema.parse(base([{ type: "title", id: "intro", title: "A" }, { type: "bullets", heading: "H", items: ["x"] }, { type: "closing", id: "bye", cta: "c", url: "a.uz" }])),
  );

  it("resolves by id and by 1-based position", () => {
    expect(resolveScene(tl, "intro").index).toBe(0);
    expect(resolveScene(tl, "2").type).toBe("bullets");
    expect(resolveScene(tl, "bye").type).toBe("closing");
  });

  it("explains a miss with the available scenes", () => {
    expect(() => resolveScene(tl, "outro")).toThrowError('no scene with id "outro"; scenes: 1=intro (title), 2 (bullets), 3=bye (closing)');
    expect(() => resolveScene(tl, "9")).toThrowError("scene 9 does not exist: the storyboard has 3 scenes (use 1-3 or a scene id)");
  });

  it("review frames run from the start of the content to the settled end", () => {
    const s = resolveScene(tl, "bye");
    const f = sceneReviewFrames(s);
    expect(f.map((x) => x.label)).toEqual(["start", "early", "middle", "end"]);
    expect(f[0]?.frame).toBe(s.startFrame + s.leadFrames);
    expect(f[3]?.frame).toBe(s.endFrame - s.exit.frames - 1);
    for (let i = 1; i < f.length; i++) expect(f[i]?.frame).toBeGreaterThanOrEqual(f[i - 1]?.frame ?? 0);
  });
});

describe("limits table is the single source of the numbers in messages", () => {
  it("new limits are positive and consistent", () => {
    expect(LIMITS.maxNodes).toBeGreaterThanOrEqual(LIMITS.minNodes);
    expect(LIMITS.maxStepsHorizontal).toBeLessThanOrEqual(LIMITS.maxSteps);
    expect(LIMITS.maxDiffLines).toBeLessThanOrEqual(LIMITS.maxCodeLines);
  });
});
