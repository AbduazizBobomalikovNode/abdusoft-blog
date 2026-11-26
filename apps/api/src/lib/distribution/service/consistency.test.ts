import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { measureSocialText, socialCounterState } from "@blog/shared";
import { createProvider, PROVIDER_IDS } from "../registry.js";
import { OG_IMAGE_ROUTE_SUFFIX } from "./images.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const SAMPLES = [
  "Salom dunyo",
  "Oʻzbekiston va gʻoya: o'zbekcha matn",
  "Havola https://example.com/a/b?c=d va yana https://uz.example.org/x.",
  "Emoji 🚀👩‍👩‍👧‍👦🇺🇿 va 1️⃣ raqam",
  "日本語のテキスト and Кирилл матн",
  "a".repeat(300),
  "",
];

describe("web counter and API providers count identically", () => {
  for (const id of PROVIDER_IDS) {
    it(`${id}: measureSocialText === provider.measureText`, () => {
      const p = createProvider(id);
      for (const t of SAMPLES) expect(measureSocialText(id, t), `${id}: ${JSON.stringify(t)}`).toBe(p.measureText(t));
    });
  }
  it("counter levels follow the limit", () => {
    expect(socialCounterState("x", "a".repeat(100), 280).level).toBe("ok");
    expect(socialCounterState("x", "a".repeat(270), 280).level).toBe("warn");
    expect(socialCounterState("x", "a".repeat(281), 280)).toMatchObject({ level: "over", remaining: -1 });
    expect(socialCounterState("github", "abc", null).level).toBe("none");
  });
});

describe("OG route suffix", () => {
  it("matches the web app's constant (the site generates the image at /<slug>/opengraph-image-<suffix>)", () => {
    const src = readFileSync(path.resolve(here, "../../../../../web/src/lib/json-ld.ts"), "utf8");
    expect(src).toContain(`OG_IMAGE_ROUTE_SUFFIX = "${OG_IMAGE_ROUTE_SUFFIX}"`);
  });
});
