import { cn } from "@/lib/utils";

/**
 * Abdusoft belgisi — "Terminal A": poyasiz `Λ` + terminal kursori (`Λ_`).
 * Geometriya `public/brand/*.svg` bilan bir xil. Ikkalasi ham bezak (`aria-hidden`):
 * havolaning accessible name'i yoniga yozilgan matndan olinadi.
 */
const INK = "#0B1220";
const ACCENT = "#3B9EFF";
const LEGS = "M13.5 46 L23.5 18 L33.5 46";
const CURSOR = "M44.5 46 H51.5";
const STROKE = { fill: "none", strokeWidth: 6, strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** Plitka (ilova ikonkasi) — to'q fon, oq `Λ`, ko'k kursor. Quyuq temada ingichka kontur qo'shiladi. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false" className={cn("brand-mark shrink-0", className)}>
      <rect width="64" height="64" rx="14" fill={INK} />
      <rect
        x=".5"
        y=".5"
        width="63"
        height="63"
        rx="13.5"
        fill="none"
        stroke="#fff"
        strokeOpacity=".16"
        className="opacity-0 dark:opacity-100"
      />
      <path d={LEGS} stroke="#fff" {...STROKE} />
      <path d={CURSOR} stroke={ACCENT} className="brand-cursor" {...STROKE} />
    </svg>
  );
}

/** Plitkasiz variant: `Λ` — `currentColor`, kursor — ko'k (och temada to'qroq ohang kontrast uchun). */
export function LogoGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="8.5 13 48 38" aria-hidden="true" focusable="false" className={cn("brand-mark shrink-0", className)}>
      <path d={LEGS} stroke="currentColor" {...STROKE} />
      <path d={CURSOR} className="brand-cursor stroke-[#1F7AE0] dark:stroke-[#3B9EFF]" {...STROKE} />
    </svg>
  );
}
