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
  },
});
