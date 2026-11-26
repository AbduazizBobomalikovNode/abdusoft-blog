import { describe, expect, it } from "vitest";
import { isBlogRepo, isValidRef, isValidRepo, isValidWorkflowFile, parseRepo } from "./github.js";

describe("repository validation (L2)", () => {
  it("accepts real GitHub names", () => {
    for (const r of ["owner/name", "a/b", "Abduaziz-Bobomalikov/abdusoft-blog-render", "o-w-n/na.me_1", "o/.github", "o/-x", "o/x.y", "o/...x", "o/x..y", "o/" + "n".repeat(100), "n".repeat(39) + "/x"]) {
      expect(isValidRepo(r), r).toBe(true);
    }
  });

  it("rejects dot-only segments, bad owners, bounds and anything that would normalise into another path", () => {
    const bad = [
      "../x", "./x", "x/..", "x/.", "o/...", "../..", "o/../../orgs/o", "o/x/../y", "o/x/y", "/x", "x/", "x", "", "o//x",
      "-o/x", "o-/x", "o--x/x", "o_o/x", "o.o/x", "o o/x", "o/x y", "o/x%2e%2e", "o/%2e%2e", "o/x?y", "o/x#y", "o/x\\y", "o/x\n", "o/x\0",
      "o/x.git", "o/X.GIT", "n".repeat(40) + "/x", "o/" + "n".repeat(101), "ö/x", "o/ü",
    ];
    for (const r of bad) expect(isValidRepo(r), JSON.stringify(r)).toBe(false);
    expect(parseRepo("owner/name")).toEqual({ owner: "owner", name: "name" });
    expect(parseRepo("o/..")).toBeNull();
  });

  it("recognises the blog repository case-insensitively", () => {
    expect(isBlogRepo("abduazizbobomalikovnode/ABDUSOFT-BLOG")).toBe(true);
    expect(isBlogRepo("abduazizbobomalikovnode/abdusoft-blog-render")).toBe(false);
  });
});

describe("workflow file and ref validation (L2)", () => {
  it("workflow: a plain .yml/.yaml name without separators", () => {
    for (const f of ["render-video.yml", "a.yaml", "Render_Video.v2.yml", "_x.yml"]) expect(isValidWorkflowFile(f), f).toBe(true);
    for (const f of ["", "x", "x.yml.exe", "x.yaml.txt", "../x.yml", "a/b.yml", ".github/workflows/x.yml", "a\\b.yml", ".yml", "-x.yml", ".x.yml", "x y.yml", "x.yml\n", "x%2fy.yml", "x?.yml", "n".repeat(120) + ".yml"]) {
      expect(isValidWorkflowFile(f), JSON.stringify(f)).toBe(false);
    }
  });

  it("ref: a plain branch name", () => {
    for (const r of ["main", "release/v1", "feature_x-1.2", "a/b/c"]) expect(isValidRef(r), r).toBe(true);
    for (const r of ["", "-main", "--force", "a..b", "..", "/main", "main/", "a//b", "a/.b", ".hidden", "main.", "x.lock", "a b", "a\tb", "a\nb", "a\u0001b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "a@{b", "n".repeat(101)]) {
      expect(isValidRef(r), JSON.stringify(r)).toBe(false);
    }
  });
});
