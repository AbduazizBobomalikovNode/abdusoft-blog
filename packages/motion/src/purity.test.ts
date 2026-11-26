import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PKG } from "./test-helpers.ts";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const f = path.join(dir, n);
    return statSync(f).isDirectory() ? files(f) : [f];
  });
}
const sources = files(path.join(PKG, "src")).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.ts$/.test(f));

/**
 * The module's hard rules: no AI, no speech, no network access at render time, and storyboard text never
 * becomes markup. Fails the build if someone adds an SDK, a fetch or an innerHTML.
 */
describe("engine stays deterministic and offline", () => {
  const forbidden: Array<[string, RegExp]> = [
    ["model / AI SDKs", /from\s+["'](?:openai|@anthropic-ai\/[^"']*|@google\/generative-ai|ai|langchain[^"']*|@ai-sdk\/[^"']*)["']/],
    ["speech / TTS", /(?:text[-_ ]?to[-_ ]?speech|speechSynthesis|SpeechSynthesisUtterance|elevenlabs|polly)/i],
    ["network APIs", /(?:\bfetch\s*\(|from\s+["']node:(?:http|https|http2|net|dgram|tls)["']|\bXMLHttpRequest\b|\bWebSocket\b|from\s+["'](?:axios|got|undici|node-fetch|ws)["'])/],
    ["raw HTML injection", /(?:dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML)/],
    ["non-determinism in scenes", /(?:Math\.random\s*\(|Date\.now\s*\(|new Date\s*\()/],
    ["licence keys / telemetry", /(?:licenseKey|apiKey|registerUsageEvent|@remotion\/licensing)/],
  ];

  it("scans a non-trivial number of sources", () => {
    expect(sources.length).toBeGreaterThan(20);
  });

  it.each(forbidden)("no %s", (name, re) => {
    const hits = sources.filter((f) => re.test(readFileSync(f, "utf8"))).map((f) => path.relative(PKG, f));
    // The renderer, the runner script, the preflight and the CLI entry may time themselves / stamp a marker file (measurement, not pixels).
    const allowed = name === "non-determinism in scenes" ? hits.filter((h) => !/^src\/(render\/|runner\/|preflight\.ts$|cli\.ts$)/.test(h)) : hits;
    expect(allowed).toEqual([]);
  });

  it("package.json carries no AI or network dependency", () => {
    const pkg = JSON.parse(readFileSync(path.join(PKG, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@remotion/bundler", "@remotion/renderer", "react", "react-dom", "remotion", "shiki", "zod"]);
  });

  it("remotion packages share one pinned version", () => {
    const pkg = JSON.parse(readFileSync(path.join(PKG, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    const v = ["remotion", "@remotion/bundler", "@remotion/renderer"].map((n) => pkg.dependencies[n]);
    expect(new Set(v).size).toBe(1);
    expect(v[0]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
