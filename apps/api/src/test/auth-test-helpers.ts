import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db, fullSchema } from "../db/index.js";
import { user } from "../db/auth-schema.js";

/**
 * Testda haqiqiy GitHub OAuth qilib bo'lmaydi — shu sabab asosiy `lib/auth.ts`
 * instansidan ALOHIDA, lekin BIR XIL DB va secret bilan ishlaydigan
 * email+parol betterAuth instansi yaratamiz (`scripts/seed.ts`dagi
 * `seedAuth` bilan bir xil pattern). U yerda yaratilgan sessiya cookie'si
 * asosiy `auth.api.getSession()` orqali ham to'g'ri tasdiqlanadi — chunki
 * ikkalasi ham bir xil jadvallarga va bir xil `BETTER_AUTH_SECRET`ga tayanadi.
 */
const testAuth = betterAuth({
  baseURL: config.API_ORIGIN,
  secret: config.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, { provider: "pg", schema: fullSchema }),
  emailAndPassword: { enabled: true, disableSignUp: false },
  user: {
    additionalFields: {
      role: { type: "string", defaultValue: "user", input: false },
    },
  },
});

let counter = 0;

export interface TestUser {
  id: string;
  email: string;
  name: string;
  /** `Cookie:` header qiymati sifatida to'g'ridan-to'g'ri ishlatiladi. */
  cookie: string;
}

export async function createTestUser(
  opts: { role?: "admin" | "staff" | "user"; name?: string } = {},
): Promise<TestUser> {
  counter += 1;
  const email = `test-user-${counter}-${Date.now()}@example.test`;
  const password = "test-password-123456";
  const name = opts.name ?? `Test User ${counter}`;

  const signUp = await testAuth.api.signUpEmail({ body: { email, password, name } });
  const userId = signUp.user.id;

  if (opts.role && opts.role !== "user") {
    await db.update(user).set({ role: opts.role }).where(eq(user.id, userId));
  }

  const signInResponse = await testAuth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });

  const setCookies = signInResponse.headers.getSetCookie?.() ?? [];
  const cookie = setCookies.map((raw) => raw.split(";")[0]).join("; ");

  if (!cookie) {
    throw new Error("Test foydalanuvchi uchun sessiya cookie'si olinmadi (signInEmail Set-Cookie yubormadi)");
  }

  return { id: userId, email, name, cookie };
}
