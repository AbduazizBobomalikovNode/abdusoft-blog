import { Hono } from "hono";
import { config } from "../config.js";
import { listConnections, revokeAllConnections, revokeConnection } from "../lib/mcp/connections.js";
import { actorFromAdminUser } from "../lib/posts/types.js";
import { requireAdmin } from "../lib/require-admin.js";

/**
 * "Ulangan ilovalar": faqat admin. Faqat MCP yoqilganda `routes/admin.ts` ulaydi (o'chiq bo'lsa bu marshrutlar yo'q).
 * Ro'yxat — o'z ulanishlari; bekor qilish — TO'LIQ (refresh token'lar + rozilik), jurnalga `mcp.revoke` yoziladi.
 */
export const adminConnectionsRoute = new Hono()
  .use("*", requireAdmin)
  .get("/", async (c) => {
    const adminUser = c.get("adminUser");
    return c.json({ items: await listConnections(adminUser.id), writeToolsEnabled: config.MCP_WRITE_TOOLS_ENABLED });
  })
  // "Hammasini uzish": barcha ulanishlar bir yo'la (token'lar, rozilik, kodlar) + jurnal.
  .delete("/", async (c) => {
    const adminUser = c.get("adminUser");
    return c.json(await revokeAllConnections(actorFromAdminUser(adminUser, "web"), adminUser.id));
  })
  .delete("/:clientId", async (c) => {
    const adminUser = c.get("adminUser");
    const result = await revokeConnection(actorFromAdminUser(adminUser, "web"), adminUser.id, c.req.param("clientId"));
    if (!result.revoked) return c.json({ error: "Topilmadi" }, 404);
    return c.json({ revoked: true });
  });
