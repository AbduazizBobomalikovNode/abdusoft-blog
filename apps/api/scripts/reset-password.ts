import { resetPasswordOnServer, SERVER_RESET_MAX, SERVER_RESET_MIN } from "../src/lib/server-password-reset.js";

/**
 * Serverda parolni tiklash (Telegram ishlamasa/sozlanmagan bo'lsa):
 *
 *   read -rs NEW_PASSWORD && export NEW_PASSWORD     # parol terminal tarixiga tushmasin
 *   pnpm --filter @blog/api exec tsx scripts/reset-password.ts admin@example.com
 *
 * Parol faqat `NEW_PASSWORD` muhit o'zgaruvchisidan olinadi (argument sifatida emas) va hech qayerda chop etilmaydi.
 */
const email = process.argv[2];
const password = process.env.NEW_PASSWORD ?? "";

if (!email) {
  console.error("Foydalanish: NEW_PASSWORD=... tsx scripts/reset-password.ts <email>");
  process.exit(2);
}

const result = await resetPasswordOnServer(email, password);
if (result.ok) {
  console.log(`Parol yangilandi: ${email}. Barcha sessiyalar tugatildi.`);
  process.exit(0);
}

const messages = {
  not_found: "Bunday email bilan foydalanuvchi topilmadi.",
  too_short: `NEW_PASSWORD kamida ${SERVER_RESET_MIN} belgidan iborat bo'lishi kerak.`,
  too_long: `NEW_PASSWORD ${SERVER_RESET_MAX} belgidan oshmasligi kerak.`,
} as const;
console.error(messages[result.reason]);
process.exit(1);
