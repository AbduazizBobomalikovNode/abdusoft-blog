import { timingSafeEqual } from "node:crypto";
import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { z } from "zod";

const BodySchema = z.object({
  paths: z.array(z.string()).default([]),
});

/** Doim bir xil uzunlikdagi buferlarni solishtiradi — vaqt asosidagi (timing) hujumlardan himoya. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * `apps/api` postlar chop etilganda/o'zgarganda shu endpointga so'rov yuboradi
 * (`x-revalidate-secret` header orqali autentifikatsiya).
 */
export async function POST(request: Request): Promise<Response> {
  const secret = request.headers.get("x-revalidate-secret");
  const expected = process.env.REVALIDATE_SECRET;

  if (!secret || !expected || !safeEqual(secret, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  for (const path of parsed.data.paths) {
    revalidatePath(path);
  }

  return NextResponse.json({ revalidated: parsed.data.paths });
}
