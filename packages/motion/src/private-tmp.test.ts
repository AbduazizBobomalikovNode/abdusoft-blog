import { existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import { beforeAll, describe, expect, it } from "vitest";
import { RendererProcessError } from "./render/errors.ts";
import { enterDedicatedRenderProcess, leaveDedicatedRenderProcessForTests, withPrivateTmp } from "./render/private-tmp.ts";
import { MotionRenderer } from "./render/renderer.ts";

beforeAll(() => enterDedicatedRenderProcess());

describe("withPrivateTmp", () => {
  it("points the temp dir at a private folder and deletes it afterwards, even on failure", async () => {
    const before = process.env.TMPDIR;
    let dir = "";
    await expect(
      withPrivateTmp(async () => {
        dir = os.tmpdir();
        writeFileSync(`${dir}/leftover.bin`, "x");
        throw new Error("boom");
      }),
    ).rejects.toThrowError("boom");
    expect(dir).toMatch(/blog-motion-/);
    expect(existsSync(dir)).toBe(false);
    expect(process.env.TMPDIR).toBe(before);
  });

  it("serialises overlapping calls", async () => {
    const order: string[] = [];
    const a = withPrivateTmp(async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("a-end");
    });
    const b = withPrivateTmp(async () => {
      order.push("b-start");
    });
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
  });
});

describe("one render per dedicated process", () => {
  it("refuses to construct a renderer, or touch the temp env, in a process that has not opted in", async () => {
    leaveDedicatedRenderProcessForTests();
    try {
      const before = process.env.TMPDIR;
      await expect(MotionRenderer.create()).rejects.toBeInstanceOf(RendererProcessError);
      await expect(withPrivateTmp(async () => 1)).rejects.toBeInstanceOf(RendererProcessError);
      expect(process.env.TMPDIR).toBe(before);
      await expect(MotionRenderer.create()).rejects.toMatchObject({ code: "process_not_dedicated" });
    } finally {
      enterDedicatedRenderProcess();
    }
  });
});
