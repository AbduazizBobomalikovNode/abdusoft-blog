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

/** 0022 faqat QO'SHADI: ikkita nullable ustun; mavjud qatorlar o'zgarmaydi va "reja yo'q" holatida qoladi. */
describe("migration 0022 (distribution relative plan)", () => {
  const sqlText = fs.readFileSync(path.join(drizzleDir, "0022_distribution_relative_plan.sql"), "utf8");

  it("is additive only: two ADD COLUMN statements, nothing dropped or altered", () => {
    const stmts = sqlText.split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean);
    expect(stmts).toHaveLength(2);
    for (const st of stmts) expect(st).toMatch(/^ALTER TABLE "distributions" ADD COLUMN "plan_(delay_minutes|materialized_at)" /);
    expect(sqlText).not.toMatch(/DROP|ALTER COLUMN|SET NOT NULL|RENAME|DELETE|UPDATE /i);
  });

  it("existing rows keep working: columns are nullable and default to no plan", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mig0021-"));
    fs.cpSync(drizzleDir, tmp, { recursive: true });
    fs.rmSync(path.join(tmp, "0022_distribution_relative_plan.sql"));
    const journalPath = path.join(tmp, "meta/_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
    journal.entries = journal.entries.filter((e) => e.tag !== "0022_distribution_relative_plan");
    fs.writeFileSync(journalPath, JSON.stringify(journal));

    const client = new PGlite();
    await migrate(drizzle(client), { migrationsFolder: tmp });
    const post = (await client.query<{ id: string }>(`INSERT INTO posts (slug, title, content_json, content_html, toc) VALUES ('a', 'A', '{}'::jsonb, '', '[]'::jsonb) RETURNING id`)).rows[0]!.id;
    await client.query(`INSERT INTO distributions (post_id, provider, status, text) VALUES ($1, 'x', 'scheduled', 'Eski')`, [post]);
    for (const stmt of sqlText.split("--> statement-breakpoint")) if (stmt.trim()) await client.exec(stmt);

    const row = (await client.query<{ status: string; text: string; plan_delay_minutes: number | null; plan_materialized_at: string | null }>(`SELECT status, text, plan_delay_minutes, plan_materialized_at FROM distributions`)).rows;
    expect(row).toEqual([{ status: "scheduled", text: "Eski", plan_delay_minutes: null, plan_materialized_at: null }]);
    const cols = await client.query<{ column_name: string; is_nullable: string }>(`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'distributions' AND column_name LIKE 'plan_%' ORDER BY column_name`);
    expect(cols.rows).toEqual([
      { column_name: "plan_delay_minutes", is_nullable: "YES" },
      { column_name: "plan_materialized_at", is_nullable: "YES" },
    ]);
    await client.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
