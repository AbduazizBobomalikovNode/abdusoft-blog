"use client";

import { useEffect, type RefObject } from "react";

/**
 * Elementni ekrandagi klaviatura tepasiga mahkamlaydi (`window.visualViewport`):
 * `bottom = layout-viewport balandligi − ko'rinadigan viewport pastki chegarasi`.
 * iOS va Android'da klaviatura layout viewport'ni qisqartirmaydi — shuning uchun shu formula kerak.
 * DOM'ga to'g'ridan-to'g'ri yoziladi (React qayta render qilinmaydi) — animatsiya paytida jank yo'q.
 */
export function useKeyboardPin(ref: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const el = ref.current;
    const vv = window.visualViewport;
    if (!el || !enabled || !vv) return;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const offset = Math.max(0, window.innerHeight - (vv.offsetTop + vv.height));
        el.style.bottom = `${Math.round(offset)}px`;
        el.dataset.keyboard = offset > 80 ? "open" : "closed";
        // Klaviatura layout viewport'ni qisqartirmaydi — hujjat oxiri uning ostida qolmasligi uchun pastki bo'shliq kengaytiriladi.
        document.documentElement.style.setProperty("--editor-kb", `${Math.round(offset)}px`);
      });
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    update();
    return () => {
      cancelAnimationFrame(raf);
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      el.style.bottom = "";
      document.documentElement.style.removeProperty("--editor-kb");
    };
  }, [ref, enabled]);
}

/** `matchMedia` — SSR-xavfsiz (birinchi renderda false). */
export function mediaQueryMatches(query: string): boolean {
  return typeof window !== "undefined" && window.matchMedia(query).matches;
}
