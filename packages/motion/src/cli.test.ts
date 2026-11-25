import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PKG } from "./test-helpers.ts";

const dir = mkdtempSync(path.join(tmpdir(), "motion-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(PKG, "src", "cli.ts"), ...args], { encoding: "utf8", cwd: PKG });

describe("cli (no browser involved)", () => {
  it("validate: ok on a fixture, exit 0", () => {
    const r = cli("validate", "fixtures/blog-post.json");
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/^ok: 5 scenes, \d+\.\d s \(limit 60 s\)/);
  });

  it("validate: exit 1 with path, message and fix on stderr", () => {
    const f = path.join(dir, "bad.json");
    writeFileSync(f, JSON.stringify({ version: 1, title: "t", theme: "dark", scenes: [{ type: "title", title: "x".repeat(93) }] }));
    const r = cli("validate", f);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("scenes[0].title: title is 93 characters; the limit is 80");
    expect(r.stderr).toContain("fix: Shorten it to the key idea");
  });

  it("validate --json: machine-readable issues on stdout", () => {
    const f = path.join(dir, "bad2.json");
    writeFileSync(f, JSON.stringify({ version: 1, title: "t", theme: "dark", format: "vertical", scenes: [{ type: "title", title: "x" }] }));
    const r = cli("validate", f, "--json");
    expect(r.status).toBe(1);
    const out = JSON.parse(r.stdout) as { ok: boolean; issues: Array<{ path: string; suggestion?: string }> };
    expect(out.ok).toBe(false);
    expect(out.issues[0]?.path).toBe("format");
  });

  it("timeline --json prints the pure timeline", () => {
    const r = cli("timeline", "fixtures/repository.json", "--json");
    expect(r.status).toBe(0);
    const tl = JSON.parse(r.stdout) as { fps: number; scenes: unknown[]; totalFrames: number };
    expect(tl.fps).toBe(30);
    expect(tl.scenes).toHaveLength(4);
  });

  it("schema prints the JSON Schema", () => {
    const r = cli("schema");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toHaveProperty("properties.scenes");
  });

  it("gif above 15 s fails before any browser work, naming MP4", () => {
    const r = cli("gif", "fixtures/blog-post.json", "--out", path.join(dir, "x.gif"));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("render an MP4 instead");
  });

  it("usage errors exit 2", () => {
    expect(cli("bogus").status).toBe(2);
    expect(cli("stills", "fixtures/blog-post.json").status).toBe(2);
  });
});
