import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { config, isProduction } from "../config.js";
import { db, fullSchema } from "../db/index.js";
import { getSettings } from "./settings.js";

// GitHub OAuth provider'ni betterAuth BOOT vaqtida ro'yxatga oladi (better-auth
// dinamik provider almashtirishni qo'llab-quvvatlamaydi) — shu sabab bu yerda
// top-level await bilan bir marta o'qiladi (env yoki DB, `getSettings()` orqali
// birlashtirilgan holda). Agar admin keyinroq DB'da clientId/clientSecret'ni
// o'zgartirsa, o'zgarish `GET /admin/settings`da `github.restartRequired: true`
// bayrog'i orqali ko'rinadi — server qayta ishga tushirilgach kuchga kiradi.
const bootSettings = await getSettings();

/** `routes/admin-settings.ts` shu qiymatlarni joriy (saqlangan) qiymat bilan solishtirib `restartRequired`ni hisoblaydi. */
export const bootedGithubConfig = {
  clientId: bootSettings.github.clientId,
  clientSecret: bootSettings.github.clientSecret,
};

const githubEnabled = bootSettings.github.providerEnabled;

export const auth = betterAuth({
  baseURL: config.API_ORIGIN,
  secret: config.BETTER_AUTH_SECRET,
  trustedOrigins: [config.WEB_ORIGIN],
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: fullSchema,
  }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
  },
  socialProviders: githubEnabled
    ? {
        github: {
          clientId: bootSettings.github.clientId,
          clientSecret: bootSettings.github.clientSecret,
        },
      }
    : undefined,
  user: {
    additionalFields: {
      role: {
        type: "string",
        defaultValue: "user",
        input: false,
      },
    },
  },
  advanced: isProduction
    ? {
        crossSubDomainCookies: {
          enabled: true,
          domain: config.COOKIE_DOMAIN || ".abdusoft.uz",
        },
        defaultCookieAttributes: {
          secure: true,
          sameSite: "lax",
        },
      }
    : undefined,
});

export type Auth = typeof auth;
