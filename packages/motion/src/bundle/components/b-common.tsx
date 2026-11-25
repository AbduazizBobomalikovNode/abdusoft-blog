import type { CSSProperties } from "react";
import { contrast } from "../../theme/color.ts";
import type { Theme } from "../../theme/tokens.ts";
import { OG_CARD, radius } from "../../theme/tokens.ts";
import { useStage } from "../context.tsx";
import { lerp, progress } from "../motion.ts";

/** Ink (text) colour for a filled accent surface: white unless it would be hard to read on accent or accent2. */
export function inkOn(theme: Theme): string {
  try {
    const worst = Math.min(contrast("#ffffff", theme.accent), contrast("#ffffff", theme.accent2));
    return worst >= 3.4 ? "#ffffff" : "#05050a";
  } catch {
    return "#ffffff";
  }
}

/** Glow text-shadow for neon-like presets (empty for the others). */
export function glowShadow(theme: Theme, size: number): string | undefined {
  return theme.glow ? `0 0 ${size}px ${theme.glow}` : undefined;
}

export const pillBorder = (theme: Theme): string => (theme.mode === "dark" ? OG_CARD.tagBorder : theme.border);

/** Scene heading used by the content scenes. */
export const SceneHeading: React.FC<{ text: string; t: number; at: number; align?: "left" | "center" }> = ({ text, t, at, align = "left" }) => {
  const { layout, theme } = useStage();
  const { px, sp } = layout;
  const p = progress(t, at, 22);
  const size = text.length <= 34 ? 64 : 52;
  return (
    <h2
      style={{
        margin: 0,
        marginBottom: sp(4),
        fontSize: px(size),
        lineHeight: 1.15,
        fontWeight: 600,
        letterSpacing: "-0.03em",
        color: theme.foreground,
        textAlign: align,
        opacity: p,
        transform: `translateY(${lerp(px(24), 0, p)}px)`,
        textWrap: "balance",
        textShadow: glowShadow(theme, px(24)),
      }}
    >
      {text}
    </h2>
  );
};

export function headingHeight(text: string | undefined, px: (n: number) => number, sp: (n: number) => number): number {
  if (!text) return 0;
  const size = text.length <= 34 ? 64 : 52;
  const lines = Math.max(1, Math.ceil((text.length * size * 0.52) / 1664));
  return Math.ceil(px(size) * 1.15 * lines) + sp(4);
}

/** Absolutely positioned box covering the scene's content area. */
export function contentBox(layout: { content: { x: number; y: number; width: number; height: number } }): CSSProperties {
  const c = layout.content;
  return { position: "absolute", left: c.x, top: c.y, width: c.width, height: c.height };
}

export const cardRadius = (sp: (n: number) => number): number => radius("lg", sp(4));

/** Decorative geometric motif for accent panels: concentric rings and a dot grid in the panel ink. */
export const PanelMotif: React.FC<{ width: number; height: number; ink: string; t: number }> = ({ width, height, ink, t }) => {
  const p = progress(t, 0, 40);
  const dots: React.ReactNode[] = [];
  const cols = 6;
  const rows = 5;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      dots.push(<circle key={`${r}-${c}`} cx={40 + c * 40} cy={40 + r * 40} r={3.5} fill={ink} opacity={0.4 * progress(t, 4 + (r + c) * 2, 16)} />);
    }
  const R = Math.min(width, height) * 0.5;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ position: "absolute", inset: 0 }} aria-hidden="true">
      {[0.5, 0.75, 1, 1.3].map((k, i) => (
        <circle key={i} cx={width * 0.95} cy={height * 0.06} r={R * k * p} fill="none" stroke={ink} strokeOpacity={0.22 - i * 0.03} strokeWidth={2} />
      ))}
      {dots}
    </svg>
  );
};
