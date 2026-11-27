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

/** 0021 ning ma'lumot bosqichi: avval 0021'gacha bo'lgan sxema, so'ng 0021'ning o'zi qo'llanadi. */
describe("migration 0021 data step", () => {
  it("turns only non-terminal custom-text distributions into a primary '1-versiya'", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mig0020-"));
    fs.cpSync(drizzleDir, tmp, { recursive: true });
    fs.rmSync(path.join(tmp, "0021_distribution_versions.sql"));
    const journalPath = path.join(tmp, "meta/_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
    journal.entries = journal.entries.filter((e) => e.tag !== "0021_distribution_versions");
    fs.writeFileSync(journalPath, JSON.stringify(journal));

    const client = new PGlite();
    await migrate(drizzle(client), { migrationsFolder: tmp });
    const post = (await client.query<{ id: string }>(`INSERT INTO posts (slug, title, content_json, content_html, toc) VALUES ('a', 'A', '{}'::jsonb, '', '[]'::jsonb) RETURNING id`)).rows[0]!.id;
    const post2 = (await client.query<{ id: string }>(`INSERT INTO posts (slug, title, content_json, content_html, toc) VALUES ('b', 'B', '{}'::jsonb, '', '[]'::jsonb) RETURNING id`)).rows[0]!.id;
    const ins = (provider: string, status: string, text: string | null, extra = "", pid = post) =>
      client.query(`INSERT INTO distributions (post_id, provider, status, text, image_choice, link_mode${extra ? ", sent_at" : ""}) VALUES ($1, $2, $3::distribution_status, $4, 'og', ${provider === "linkedin" ? "'text'" : "NULL"}${extra ? ", now()" : ""})`, [pid, provider, status, text]);
    await ins("linkedin", "draft", "Qo'lda matn");
    await ins("x", "scheduled", "   "); // bo'sh joy — ko'chirilmaydi
    await ins("threads", "draft", null); // standart matn — ko'chirilmaydi
    await ins("instagram", "sent", "Yuborilgan", "sent"); // terminal — ko'chirilmaydi
    await ins("x", "needs_checking", "Tekshirish kerak matni", "", post2);

    const sql = fs.readFileSync(path.join(drizzleDir, "0021_distribution_versions.sql"), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) if (stmt.trim()) await client.exec(stmt);

    const rows = (await client.query<{ provider: string; name: string; text: string; image_choice: string; link_mode: string | null; is_primary: boolean }>(`SELECT provider, name, text, image_choice, link_mode, is_primary FROM distribution_versions ORDER BY provider, text`)).rows;
    expect(rows).toEqual([
      { provider: "linkedin", name: "1-versiya", text: "Qo'lda matn", image_choice: "og", link_mode: "text", is_primary: true },
      { provider: "x", name: "1-versiya", text: "Tekshirish kerak matni", image_choice: "og", link_mode: null, is_primary: true },
    ]);
    const col = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'distributions' AND column_name = 'version_id'`);
    expect(col.rows).toHaveLength(1);
    await client.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
