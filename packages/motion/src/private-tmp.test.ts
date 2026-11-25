import { existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { withPrivateTmp } from "./render/private-tmp.ts";

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
