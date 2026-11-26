import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, "../..");
const repoRoot = path.resolve(packageDir, "../..");
const template = readFileSync(path.join(packageDir, "render-workflow/render-video.yml"), "utf8");
const code = template
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("#"))
  .join("\n");

describe("render workflow template (separate render repository)", () => {
  it("is not a workflow of the blog repository (no Actions-write token for the blog repo is ever needed)", () => {
    expect(existsSync(path.join(repoRoot, ".github/workflows/render-video.yml"))).toBe(false);
    expect(existsSync(path.join(packageDir, "render-workflow/README.md"))).toBe(true);
  });

  it("checks out the blog source explicitly, from a hard-coded repository, without persisting credentials", () => {
    expect(code).toMatch(/^  SOURCE_REPO: AbduazizBobomalikovNode\/abdusoft-blog$/m);
    // Qaysi kod sir bilan ishlashini repozitoriy o'zgaruvchisi hal qilmasligi kerak.
    expect(code).not.toMatch(/vars\.VIDEO_SOURCE_REPO/);
    const checkout = code.slice(code.indexOf("actions/checkout@"));
    expect(checkout).toMatch(/repository: \$\{\{ env\.SOURCE_REPO \}\}/);
    expect(checkout).toMatch(/ref: main/);
    expect(checkout).toMatch(/persist-credentials: false/);
  });

  it("uses one concurrency group PER JOB and never cancels a running render", () => {
    expect(code).toMatch(/group: render-video-\$\{\{ inputs\.job_id \}\}/);
    expect(code).toMatch(/cancel-in-progress: false/);
  });

  it("pins every third-party action by full commit SHA with the version in a comment", () => {
    const uses = [...template.matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThanOrEqual(5);
    for (const m of uses) {
      expect(m[1], m[0]).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      expect(m[2], m[0]).toMatch(/^\s+# v\d+\.\d+\.\d+$/);
    }
  });

  it("gives the secret only to the last step, reads inputs only through the environment, and has minimal permissions", () => {
    expect(code).toMatch(/permissions:\n {2}contents: read/);
    const secretUses = code.match(/secrets\.VIDEO_RUNNER_SECRET/g) ?? [];
    expect(secretUses).toHaveLength(1);
    expect(code.indexOf("secrets.VIDEO_RUNNER_SECRET")).toBeGreaterThan(code.indexOf("name: Render and upload"));
    expect(code).not.toMatch(/run:[^\n]*\$\{\{ *inputs\./);
    expect(code).toMatch(/environment: video-render/);
  });
});
