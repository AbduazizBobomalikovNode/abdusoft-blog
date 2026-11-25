import type { CSSProperties, ReactNode } from "react";
import { estimateLines } from "../../fit.ts";
import { hash01 } from "../../timing.ts";
import { OG_CARD } from "../../theme/tokens.ts";
import { useStage } from "../context.tsx";
import { clamp01, lerp, progress } from "../motion.ts";

/** Helpers shared by the boot, signal and slam variants (fork A2). All pure functions of the frame. */

/** Largest title size (design units) whose estimated line count fits `heightUnits`. */
export function fitTitleBox(chars: number, widthUnits: number, heightUnits: number, lineHeight = 1.06): number {
  const sizes = [144, 120, 104, 96, 88, 80, 72, 64, 56, 48];
  for (const s of sizes) {
    if (estimateLines(chars, s, widthUnits, 0.55) * s * lineHeight <= heightUnits) return s;
  }
  return 48;
}

/** Overshooting ease-out (back). `s` is the overshoot strength. */
export function easeOutBack(x: number, s = 1.9): number {
  const c = clamp01(x) - 1;
  return 1 + (s + 1) * c * c * c + s * c * c;
}

export const sizeFor = (chars: number): number => (chars <= 24 ? 120 : chars <= 36 ? 104 : chars <= 48 ? 88 : 72);

export function titleStyle(size: number, px: (n: number) => number): CSSProperties {
  return {
    margin: 0,
    fontSize: px(size),
    lineHeight: 1.06,
    fontWeight: OG_CARD.titleWeight,
    letterSpacing: size >= 96 ? "-0.035em" : "-0.025em",
    textWrap: "balance",
  };
}

const POOL = "0123456789#$%&*+<>=/\\|~?!xzvcu";
export function scrambleGlyph(i: number, frame: number, seed: number): string {
  const k = Math.floor(hash01(i * 977 + Math.floor(frame / 2) * 31 + seed) * POOL.length);
  return POOL[k] as string;
}

/**
 * Text whose characters "decrypt" left to right. The real text is always laid out (so wrapping never
 * changes); unresolved characters are hidden and a scramble glyph is drawn centred on the same cell.
 */
export const ScrambleText: React.FC<{
  text: string;
  t: number;
  /** Frame at which character `i` becomes final. */
  resolveAt: (i: number) => number;
  /** Frame the scramble glyphs start to show. */
  showFrom: number;
  seed: number;
  glyphColor: string;
  style?: CSSProperties;
}> = ({ text, t, resolveAt, showFrom, seed, glyphColor, style }) => {
  const words = text.split(" ");
  let i = 0;
  const appear = clamp01((t - showFrom) / 8);
  return (
    <div style={style}>
      {words.map((w, wi) => {
        const chars = [...w];
        const spans = chars.map((ch, ci) => {
          const idx = i + ci;
          const done = t >= resolveAt(idx);
          return (
            <span key={ci} style={{ position: "relative", display: "inline-block" }}>
              <span style={{ opacity: done ? 1 : 0 }}>{ch}</span>
              {!done && (
                <span style={{ position: "absolute", left: 0, right: 0, top: 0, overflow: "hidden", textAlign: "center", fontSize: "0.82em", color: glyphColor, opacity: appear * 0.7, fontWeight: 400 }}>
                  {scrambleGlyph(idx, t, seed)}
                </span>
              )}
            </span>
          );
        });
        i += chars.length + 1;
        return (
          <span key={wi} style={{ display: "inline-block", whiteSpace: "nowrap", marginRight: wi < words.length - 1 ? "0.26em" : 0 }}>
            {spans}
          </span>
        );
      })}
    </div>
  );
};

export const TagPills: React.FC<{ tags: readonly string[]; t: number; at: readonly number[]; pop?: boolean }> = ({ tags, t, at, pop }) => {
  const { layout, theme } = useStage();
  const { px, sp } = layout;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: sp(2) }}>
      {tags.map((tag, i) => {
        const p = progress(t, at[i] ?? 0, 16);
        const sc = pop ? lerp(0.7, 1, Math.min(1.12, easeOutBack(progress(t, at[i] ?? 0, 18, (n) => n), 2.4))) : 1;
        return (
          <span
            key={i}
            style={{
              fontSize: px(28),
              padding: `${sp(1)}px ${sp(3)}px`,
              borderRadius: 999,
              border: `${px(2)}px solid ${theme.mode === "dark" ? OG_CARD.tagBorder : theme.border}`,
              background: theme.mode === "dark" ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.6)",
              color: theme.foreground,
              opacity: p,
              transform: `translateY(${lerp(px(16), 0, p)}px) scale(${sc})`,
              lineHeight: 1.3,
            }}
          >
            {tag}
          </span>
        );
      })}
    </div>
  );
};

/** Neon glow for headline text (theme.glow is null outside the neon preset). */
export const glowShadow = (glow: string | null, size: number): string | undefined => (glow ? `0 0 ${size}px ${glow}` : undefined);

/** Position of the content box as inline style. */
export const contentBox = (c: { x: number; y: number; width: number; height: number }): CSSProperties => ({
  position: "absolute",
  left: c.x,
  top: c.y,
  width: c.width,
  height: c.height,
});

export const Fill: React.FC<{ children?: ReactNode; style?: CSSProperties }> = ({ children, style }) => (
  <div style={{ position: "absolute", inset: 0, ...style }}>{children}</div>
);
