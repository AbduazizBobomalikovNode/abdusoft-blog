/**
 * Sana va o'qish vaqtini o'zbek tilida formatlash uchun umumiy yordamchilar.
 *
 * Oy nomlari qo'lda (Intl.DateTimeFormat'siz) yozilgan: "uz-UZ" locale
 * ma'lumotlari server (Node, full-icu) va brauzer ICU'si o'rtasida farq
 * qiladi — brauzerda ko'pincha "sentabr" o'rniga "M09" fallback'i chiqadi.
 * Bu Next.js SSR bilan hydration mismatch beradi (server "25-sentabr, 2026"
 * render qiladi, client "2026 M09 25" bilan almashtiradi). Qo'lda yozilgan
 * ro'yxat ikkala tomonda bir xil natija beradi.
 */
const UZ_MONTHS_FULL = [
  "yanvar",
  "fevral",
  "mart",
  "aprel",
  "may",
  "iyun",
  "iyul",
  "avgust",
  "sentabr",
  "oktabr",
  "noyabr",
  "dekabr",
];

const UZ_MONTHS_SHORT = ["yan", "fev", "mar", "apr", "may", "iyun", "iyul", "avg", "sen", "okt", "noy", "dek"];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getDate()}-${UZ_MONTHS_FULL[d.getMonth()]}, ${d.getFullYear()}`;
}

export function formatReadingTime(minutes: number | null): string {
  if (!minutes) return "";
  return `${minutes} daqiqa`;
}

/** Admin panel uchun qisqa sana + vaqt — masalan "25 sen, 14:05". */
export function formatDateTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getDate()} ${UZ_MONTHS_SHORT[d.getMonth()]}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Faqat soat:daqiqa — masalan "14:05". */
export function formatTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Grafik x-o'qi uchun UTC kundagi qisqa sana — masalan "25 sen". */
export function formatDayShortUTC(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  return `${d.getUTCDate()} ${UZ_MONTHS_SHORT[d.getUTCMonth()]}`;
}

/**
 * Izohlar uchun nisbiy vaqt — "hozirgina" / "5 daqiqa oldin" / "3 soat oldin" /
 * "kecha", 24 soatdan (kalendar kuni bo'yicha "kecha"dan) keyin esa oddiy sana.
 */
export function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diffSec < 60) return "hozirgina";

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} daqiqa oldin`;

  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} soat oldin`;

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  if (date >= startOfYesterday && date < startOfToday) return "kecha";

  return formatDate(iso);
}
