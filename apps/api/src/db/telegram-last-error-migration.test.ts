import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(dirname, "../../drizzle");
const TAG = "0024_telegram_last_error";

/** 0024 faqat QO'SHADI: mavjud postlar "xato yo'q" holatida qoladi. */
describe("migration 0024 (telegram last error)", () => {
  const sqlText = fs.readFileSync(path.join(drizzleDir, `${TAG}.sql`), "utf8");

  it("is additive only: two nullable ADD COLUMN statements", () => {
    const stmts = sqlText.split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toBe('ALTER TABLE "posts" ADD COLUMN "channel_last_error" text;');
    expect(stmts[1]).toBe('ALTER TABLE "posts" ADD COLUMN "channel_last_error_at" timestamp with time zone;');
    expect(sqlText).not.toMatch(/DROP|ALTER COLUMN|RENAME|DELETE|UPDATE |NOT NULL/i);
  });

  it("applies on top of 0023 and existing rows get NULLs", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mig0024-"));
    fs.cpSync(drizzleDir, tmp, { recursive: true });
    fs.rmSync(path.join(tmp, `${TAG}.sql`));
    const journalPath = path.join(tmp, "meta/_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
    journal.entries = journal.entries.filter((e) => e.tag !== TAG);
    fs.writeFileSync(journalPath, JSON.stringify(journal));

    const client = new PGlite();
    await migrate(drizzle(client), { migrationsFolder: tmp });
    await client.query(`INSERT INTO posts (slug, title, content_json, content_html, toc) VALUES ('a', 'A', '{}'::jsonb, '', '[]'::jsonb)`);
    for (const stmt of sqlText.split("--> statement-breakpoint")) if (stmt.trim()) await client.exec(stmt);

    const rows = (await client.query<{ channel_last_error: string | null; channel_last_error_at: string | null }>(`SELECT channel_last_error, channel_last_error_at FROM posts`)).rows;
    expect(rows).toEqual([{ channel_last_error: null, channel_last_error_at: null }]);
    await client.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
