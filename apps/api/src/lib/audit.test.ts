import { describe, expect, it } from "vitest";
import { sanitizeAuditMeta } from "./audit.js";

describe("sanitizeAuditMeta", () => {
  it("drops secret-looking keys at any depth", () => {
    const clean = sanitizeAuditMeta({
      sections: ["telegram"],
      botToken: "123:ABC",
      nested: { password: "hunter2", apiKey: "k", ok: 1, Cookie: "a=b", authorization: "Bearer x" },
      accessKeyId: "AKIA",
    });
    expect(clean).toEqual({ sections: ["telegram"], nested: { ok: 1 } });
  });

  it("truncates long strings, caps arrays and depth", () => {
    const clean = sanitizeAuditMeta({
      long: "x".repeat(500),
      list: Array.from({ length: 80 }, (_, i) => i),
      deep: { a: { b: { c: { d: 1 } } } },
    }) as { long: string; list: number[]; deep: unknown };
    expect(clean.long.length).toBeLessThanOrEqual(201);
    expect(clean.list).toHaveLength(50);
    expect(clean.deep).toEqual({ a: {} });
  });

  it("returns an empty object for undefined meta", () => {
    expect(sanitizeAuditMeta(undefined)).toEqual({});
  });
});
