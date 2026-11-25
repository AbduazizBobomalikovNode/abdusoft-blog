import { Hono } from "hono";
import { AuditListQuerySchema } from "@blog/shared";
import { listAuditEntries } from "../lib/admin-reads/audit.js";
import { requireAdmin } from "../lib/require-admin.js";

/** Admin amallari jurnali (faqat admin, faqat o'qish). So'rov mantig'i `lib/admin-reads/audit.ts`da (MCP bilan umumiy). */
export const adminAuditRoute = new Hono().use("*", requireAdmin).get("/", async (c) => {
  const parsed = AuditListQuerySchema.safeParse({
    entityType: c.req.query("entityType"),
    entityId: c.req.query("entityId"),
    actor: c.req.query("actor"),
    via: c.req.query("via"),
    action: c.req.query("action"),
    from: c.req.query("from"),
    to: c.req.query("to"),
    page: c.req.query("page"),
    limit: c.req.query("limit"),
  });
  if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov parametrlari" }, 400);

  return c.json(await listAuditEntries(parsed.data));
});
