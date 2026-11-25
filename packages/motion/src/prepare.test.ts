import { describe, expect, it } from "vitest";
import { renderPropsSchema } from "./props.ts";
import { computeHighlights, prepareRenderProps } from "./render/prepare.ts";
import { codeLines, storyboardSchema } from "./schema/storyboard.ts";
import { base, readFixture } from "./test-helpers.ts";
import { validateStoryboard } from "./validate.ts";

const parse = (scenes: unknown[], theme: "light" | "dark" = "dark") => storyboardSchema.parse({ ...base(scenes), theme });

describe("shiki highlighting (Node side, offline)", () => {
  it("tokens re-assemble to exactly the source text, line by line", async () => {
    const code = 'const a: number = 1; // oʻzbek\nfunction f() {\n  return "gʻoya";\n}\n';
    const sb = parse([{ type: "code", language: "typescript", code }]);
    const h = await computeHighlights(sb);
    const lines = h.code["0"] ?? [];
    expect(lines.map((l) => l.map((t) => t.content).join(""))).toEqual(codeLines(code));
    expect(lines[0]?.some((t) => t.color !== undefined)).toBe(true);
  });

  it("uses github-dark colours for dark and github-light for light", async () => {
    const scenes = [{ type: "code", language: "typescript", code: "const x = 1;" }];
    const dark = (await computeHighlights(parse(scenes, "dark"))).code["0"]?.[0]?.[0];
    const light = (await computeHighlights(parse(scenes, "light"))).code["0"]?.[0]?.[0];
    expect(dark?.color).toBe("#F97583"); // github-dark keyword
    expect(light?.color?.toLowerCase()).toBe("#d73a49"); // github-light keyword
  });

  it("markup in storyboard text stays inert data", async () => {
    const evil = '<img src=x onerror=alert(1)>\n<script>fetch("//e")</script>';
    const sb = parse([{ type: "code", language: "html", code: evil }]);
    const h = await computeHighlights(sb);
    const joined = (h.code["0"] ?? []).map((l) => l.map((t) => t.content).join("")).join("\n");
    expect(joined).toBe(evil); // plain strings; React escapes them when drawn
  });

  it('"text" has no colours and tokenizes bash commands for terminals', async () => {
    const sb = parse([
      { type: "code", language: "text", code: "plain\n\nlines" },
      { type: "terminal", lines: [{ kind: "command", text: "pnpm install --frozen-lockfile" }, { kind: "output", text: "ok" }] },
    ]);
    const h = await computeHighlights(sb);
    expect(h.code["0"]).toEqual([[{ content: "plain" }], [], [{ content: "lines" }]]);
    expect(Object.keys(h.terminal["1"] ?? {})).toEqual(["0"]);
    expect((h.terminal["1"]?.["0"] ?? []).map((t) => t.content).join("")).toBe("pnpm install --frozen-lockfile");
  });

  it("render props for both fixtures satisfy the composition's strict schema", async () => {
    for (const name of ["blog-post.json", "repository.json"]) {
      const r = validateStoryboard(readFixture(name));
      if (!r.ok) throw new Error("fixture invalid");
      const props = await prepareRenderProps(r.storyboard);
      expect(() => renderPropsSchema.parse(JSON.parse(JSON.stringify(props)))).not.toThrow();
    }
  });

  it("is deterministic", async () => {
    const sb = storyboardSchema.parse(readFixture("repository.json"));
    expect(JSON.stringify(await computeHighlights(sb))).toBe(JSON.stringify(await computeHighlights(sb)));
  });
});
