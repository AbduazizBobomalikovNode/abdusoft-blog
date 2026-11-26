import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, type TestUser } from "../../test/auth-test-helpers.js";

type Svc = typeof import("./index.js");
let svc: Svc;
let db: typeof import("../../db/index.js").db;
let schema: typeof import("../../db/schema.js");
let admin: TestUser;

const cell = (attrs: Record<string, unknown> = {}) => ({ type: "tableCell", attrs, content: [{ type: "paragraph" }] });
const table = (n: number, attrs: Record<string, unknown>) => ({ type: "table", content: [{ type: "tableRow", content: Array.from({ length: n }, () => cell(attrs)) }] });
/** The reviewer's document: valid before the column groups were counted, now over the limit; rendering it costs ~3.5 s CPU and ~1.1 GB. */
const heavy = { type: "doc", content: Array.from({ length: 93 }, () => table(32, { colspan: 32 })) };

beforeAll(async () => {
  await migrateTestDb();
  svc = await import("./index.js");
  ({ db } = await import("../../db/index.js"));
  schema = await import("../../db/schema.js");
  admin = await createTestUser({ role: "admin", name: "Admin" });
});

describe("a stored document that is over today's limits", () => {
  it("is not re-rendered when only the title changes (excerpt falls back to the stored text)", async () => {
    const actor = svc.actorFromAdminUser({ id: admin.id, role: "admin" }, "web");
    const created = await svc.createPost(actor, { title: "Eski post" });
    if (!created.ok) throw new Error("create failed");
    await db.update(schema.posts).set({ contentJson: heavy, contentText: "Avval render qilingan matn", contentHtml: "<p>old</p>" }).where(eq(schema.posts.id, created.data.id));

    const started = process.cpuUsage();
    const updated = await svc.updatePost(actor, created.data.id, { title: "Yangi sarlavha", excerpt: null });
    const cpuMs = (() => {
      const c = process.cpuUsage(started);
      return (c.user + c.system) / 1000;
    })();
    expect(updated.ok).toBe(true);
    expect(cpuMs).toBeLessThan(1500);
    const [row] = await db.select().from(schema.posts).where(eq(schema.posts.id, created.data.id));
    expect(row!.title).toBe("Yangi sarlavha");
    expect(row!.excerpt).toBe("Avval render qilingan matn");
    expect(row!.contentHtml).toBe("<p>old</p>");
  });

  it("is still refused when the caller submits that document as new content", async () => {
    const actor = svc.actorFromAdminUser({ id: admin.id, role: "admin" }, "web");
    const created = await svc.createPost(actor, { title: "Yangi" });
    if (!created.ok) throw new Error("create failed");
    const r = await svc.updatePost(actor, created.data.id, { contentJson: heavy as never });
    expect(r.ok).toBe(false);
  });
});
