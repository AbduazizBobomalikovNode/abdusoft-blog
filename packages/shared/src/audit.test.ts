import { describe, expect, it } from "vitest";
import { AuditListQuerySchema } from "./audit.js";

describe("AuditListQuerySchema", () => {
  it("applies pagination defaults like the other admin lists", () => {
    expect(AuditListQuerySchema.parse({})).toMatchObject({ page: 1, limit: 30 });
  });

  it("accepts a known channel and date-only or ISO bounds", () => {
    const parsed = AuditListQuerySchema.parse({ via: "mcp", from: "2026-01-01", to: "2026-01-31T10:00:00.000Z" });
    expect(parsed.via).toBe("mcp");
  });

  it("rejects an unknown channel, a bad date and an oversized page", () => {
    expect(AuditListQuerySchema.safeParse({ via: "fax" }).success).toBe(false);
    expect(AuditListQuerySchema.safeParse({ from: "yesterday-ish" }).success).toBe(false);
    expect(AuditListQuerySchema.safeParse({ limit: 500 }).success).toBe(false);
  });
});
