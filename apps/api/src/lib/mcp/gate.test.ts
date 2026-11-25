import { describe, expect, it } from "vitest";
import { Gate } from "./gate.js";

describe("Gate (concurrency limit for heavy work)", () => {
  it("runs at most `limit` jobs at once, queues the rest and refuses when the queue is full", async () => {
    const gate = new Gate(2, 3);
    let active = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const job = () =>
      gate.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        return "done";
      });
    const running = [job(), job(), job(), job(), job()]; // 2 active + 3 queued
    await new Promise((r) => setTimeout(r, 20));
    expect(active).toBe(2);
    expect(await job()).toBeNull(); // queue (3) is full
    while (releases.length > 0 || active > 0) {
      releases.shift()?.();
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await Promise.all(running)).toEqual(["done", "done", "done", "done", "done"]);
    expect(peak).toBe(2);
    expect(await gate.run(async () => 1)).toBe(1); // the gate is reusable afterwards
  });

  it("releases its slot when a job throws", async () => {
    const gate = new Gate(1, 1);
    await expect(gate.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await gate.run(async () => "ok")).toBe("ok");
  });
});
