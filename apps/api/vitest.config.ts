import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Har bir test fayli alohida module-graph'da ishlaydi — shu sabab har
    // birining o'z in-memory PGlite instansiyasi bo'ladi (bir-biriga ta'sir qilmaydi).
    pool: "forks",
    // Testlar toza clone'da ham (.env faylsiz) ishlashi uchun xavfsiz test qiymatlari.
    // `src/config.ts` prod'dagi validatsiyasi o'zgarmaydi — faqat test jarayoni env'ga ega bo'ladi.
    // DATABASE_URL bo'sh — tashqi bazaga ulanmaydi, in-memory PGlite ishlatiladi
    // (process.env'da mavjud qiymat dotenv tomonidan ustidan yozilmaydi, ya'ni
    // lokal .env'dagi haqiqiy DATABASE_URL ham testga o'tmaydi).
    env: {
      BETTER_AUTH_SECRET: "test-only-secret-not-for-production-0123456789",
      DATABASE_URL: "",
    },
  },
});
