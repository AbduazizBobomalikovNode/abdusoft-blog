import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import * as authSchema from "./auth-schema.js";
import * as schema from "./schema.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export const fullSchema = { ...schema, ...authSchema };

async function createDb() {
  if (config.DATABASE_URL) {
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: config.DATABASE_URL });
    return drizzle(pool, { schema: fullSchema });
  }

  const { drizzle } = await import("drizzle-orm/pglite");
  const { PGlite } = await import("@electric-sql/pglite");

  // vitest (`test`) — fayl tizimiga tegmaydigan, har bir test fayli uchun izolyatsiyalangan
  // in-memory PGlite. Migratsiyalarni test o'zi (beforeAll'da) qo'llaydi.
  if (config.NODE_ENV === "test") {
    const client = new PGlite();
    return drizzle(client, { schema: fullSchema });
  }

  const dataDir = path.resolve(dirname, "../../.data/pglite");
  mkdirSync(dataDir, { recursive: true });
  const client = new PGlite(dataDir);
  return drizzle(client, { schema: fullSchema });
}

export const db = await createDb();
export type Database = typeof db;
