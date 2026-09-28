/** Admin statistika sahifalari uchun raqam/delta formatlash yordamchilari. */

export interface Delta {
  /** Foizli o'zgarish, butun songa yaxlitlangan. `null` — hisoblab bo'lmaydi (masalan oldingi davr uchun ma'lumot yo'q). */
  percent: number | null;
  direction: "up" | "down" | "flat";
  /** Avvalgi qiymat 0 bo'lib, hozirgisi > 0 bo'lsa — foiz emas, "yangi" holati. */
  isNew: boolean;
}

export function computeDelta(current: number, previous: number | null): Delta {
  if (previous === null) return { percent: null, direction: "flat", isNew: false };

  if (previous === 0) {
    if (current === 0) return { percent: 0, direction: "flat", isNew: false };
    return { percent: null, direction: "up", isNew: true };
  }

  const percent = Math.round(((current - previous) / previous) * 100);
  const direction = percent > 0 ? "up" : percent < 0 ? "down" : "flat";
  return { percent, direction, isNew: false };
}

export function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("uz-UZ").format(value);
}

/** Umami `totaltime` (soniya, jami) dan o'rtacha sessiya davomiyligini "3:24" formatida qaytaradi. */
export function formatAvgDuration(totalSeconds: number, visits: number): string {
  if (visits <= 0) return "0:00";
  const avg = Math.round(totalSeconds / visits);
  const minutes = Math.floor(avg / 60);
  const seconds = avg % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
