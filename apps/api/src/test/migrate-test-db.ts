import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/pglite/migrator";
import { db } from "../db/index.js";
import type { PgliteDatabase } from "drizzle-orm/pglite";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(dirname, "../../drizzle");

/**
 * Test fayllari `beforeAll`da chaqiradi — `db/index.ts` `NODE_ENV=test`
 * bo'lganda in-memory PGlite yaratadi (fayl tizimiga tegmaydi), shu funksiya
 * unga `drizzle/` papkasidagi SQL migratsiyalarni qo'llaydi.
 */
export async function migrateTestDb(): Promise<void> {
  await migrate(db as PgliteDatabase<Record<string, unknown>>, { migrationsFolder });
}
