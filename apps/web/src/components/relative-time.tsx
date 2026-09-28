"use client";

import { useSyncExternalStore } from "react";
import { formatDate, formatRelativeTime } from "@/lib/format";

/** Hech qachon o'zgarmaydigan "external store" — faqat server/client farqini aniqlash uchun. */
function subscribe(): () => void {
  return () => {};
}

/**
 * `useSyncExternalStore`ning server/client snapshot farqidan foydalanamiz:
 * serverda (va client'ning birinchi hydration render'ida) doim `false`,
 * mount bo'lgandan keyin `true`. Effekt ichida `setState` chaqirmagani uchun
 * qo'shimcha keskin re-render tug'dirmaydi va hydration mismatch xavfi yo'q.
 */
function useMounted(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}

/**
 * Server va client birinchi render'da BIR XIL narsani (absolyut sana) chiqaradi
 * — hydration mismatch bo'lmasligi uchun. Mount bo'lgandan keyin nisbiy vaqtga
 * ("5 daqiqa oldin") almashadi. `<time dateTime>` — semantik va screen reader'lar
 * uchun to'g'ri.
 */
export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  const mounted = useMounted();

  return (
    <time dateTime={iso} className={className}>
      {mounted ? formatRelativeTime(iso) : formatDate(iso)}
    </time>
  );
}
