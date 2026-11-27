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
const TAG = "0023_distribution_x_thread";

/** 0023 faqat QO'SHADI: mavjud qatorlar "bitta tvit" holatida qoladi (x_thread=false, thread_ids=null). */
describe("migration 0023 (distribution X thread)", () => {
  const sqlText = fs.readFileSync(path.join(drizzleDir, `${TAG}.sql`), "utf8");

  it("is additive only: three ADD COLUMN statements, nothing dropped or altered", () => {
    const stmts = sqlText.split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean);
    expect(stmts).toHaveLength(3);
    for (const st of stmts) expect(st).toMatch(/^ALTER TABLE "distributions" ADD COLUMN "(x_thread|x_thread_numbering|thread_ids)" /);
    expect(sqlText).not.toMatch(/DROP|ALTER COLUMN|RENAME|DELETE|UPDATE /i);
  });

  it("existing rows keep working as single tweets", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mig0023-"));
    fs.cpSync(drizzleDir, tmp, { recursive: true });
    fs.rmSync(path.join(tmp, `${TAG}.sql`));
    const journalPath = path.join(tmp, "meta/_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
    journal.entries = journal.entries.filter((e) => e.tag !== TAG);
    fs.writeFileSync(journalPath, JSON.stringify(journal));

    const client = new PGlite();
    await migrate(drizzle(client), { migrationsFolder: tmp });
    const post = (await client.query<{ id: string }>(`INSERT INTO posts (slug, title, content_json, content_html, toc) VALUES ('a', 'A', '{}'::jsonb, '', '[]'::jsonb) RETURNING id`)).rows[0]!.id;
    await client.query(`INSERT INTO distributions (post_id, provider, status, text) VALUES ($1, 'x', 'scheduled', 'Eski')`, [post]);
    for (const stmt of sqlText.split("--> statement-breakpoint")) if (stmt.trim()) await client.exec(stmt);

    const row = (await client.query<{ status: string; text: string; x_thread: boolean; x_thread_numbering: boolean; thread_ids: unknown }>(`SELECT status, text, x_thread, x_thread_numbering, thread_ids FROM distributions`)).rows;
    expect(row).toEqual([{ status: "scheduled", text: "Eski", x_thread: false, x_thread_numbering: false, thread_ids: null }]);
    await client.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
