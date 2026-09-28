import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import "dotenv/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(dirname, "../drizzle");

/**
 * Xodim (staff) review workflow migratsiyasi `posts.created_by`ni qo'shadi,
 * lekin mavjud postlarda bu maydon `NULL` bo'lib qoladi. Bu funksiya har
 * safar `db:migrate` chaqirilganda ishlaydi va idempotent — faqat hali
 * `created_by IS NULL` bo'lgan postlarni birinchi (eng qadimgi) admin
 * foydalanuvchiga bog'laydi. Admin topilmasa (yangi, hali seed qilinmagan
 * baza) hech narsa qilmaydi.
 */
async function backfillPostCreatedBy(db: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> }) {
  await db.execute(sql`
    UPDATE posts
    SET created_by = (SELECT id FROM "user" WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1)
    WHERE created_by IS NULL
      AND EXISTS (SELECT 1 FROM "user" WHERE role = 'admin')
  `);
}

async function main() {
  if (process.env.DATABASE_URL) {
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder });
    await backfillPostCreatedBy(db);
    await pool.end();
    console.log("Migratsiya (Postgres) muvaffaqiyatli yakunlandi.");
    return;
  }

  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const { PGlite } = await import("@electric-sql/pglite");
  const dataDir = path.resolve(dirname, "../.data/pglite");
  mkdirSync(dataDir, { recursive: true });
  const client = new PGlite(dataDir);
  const db = drizzle(client);
  await migrate(db, { migrationsFolder });
  await backfillPostCreatedBy(db);
  await client.close();
  console.log("Migratsiya (PGlite) muvaffaqiyatli yakunlandi.");
}

main().catch((error: unknown) => {
  console.error("Migratsiya xatosi:", error);
  process.exitCode = 1;
});
