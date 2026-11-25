import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { storyboardJsonSchema } from "./json-schema.ts";
import { LIMITS } from "./limits.ts";
import { PKG } from "./test-helpers.ts";

describe("JSON Schema export", () => {
  const schema = storyboardJsonSchema() as {
    additionalProperties: boolean;
    required: string[];
    properties: Record<string, { enum?: string[]; maxItems?: number; default?: unknown; items?: { oneOf?: unknown[]; anyOf?: unknown[] } }>;
  };

  it("committed storyboard.schema.json is current (run `pnpm --filter @blog/motion schema`)", () => {
    const committed = readFileSync(path.join(PKG, "storyboard.schema.json"), "utf8");
    expect(committed).toBe(`${JSON.stringify(storyboardJsonSchema(), null, 2)}\n`);
  });

  it("is strict at the top level and requires the essentials", () => {
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(expect.arrayContaining(["version", "title", "theme", "scenes"]));
    expect(schema.required).not.toContain("siteName");
    expect(schema.properties.format?.enum).toEqual(["landscape"]);
    expect(schema.properties.theme?.enum).toEqual(["light", "dark"]);
    expect(schema.properties.scenes?.maxItems).toBe(LIMITS.maxScenes);
  });

  it("describes all five scene types", () => {
    const text = JSON.stringify(schema);
    for (const t of ["title", "bullets", "code", "terminal", "outro"]) expect(text).toContain(`"const":"${t}"`);
    expect(text).toContain(`"maxLength":${LIMITS.title}`);
  });
});
