import type { CSSProperties } from "react";
import { OG_CARD, FONT_STACK } from "../../theme/tokens.ts";
import { useStage } from "../context.tsx";
import { lerp, progress } from "../motion.ts";
import { ctaSize, introSize, mixed, periodic, periodicCos, textGradient, useBox, words } from "./a1-common.tsx";
import type { ClosingProps, IntroProps } from "./kit.ts";

/**
 * Aurora: a gradient-mesh light field (accent + accent2) built from a few large radial-gradient ellipses
 * drifting on periodic paths (period = LOOP_FRAMES, so a closing hold loops seamlessly), with kinetic
 * typography: every word rises through its own mask. No filters, no canvas: gradients and transforms only.
 */
const AuroraField: React.FC<{ t: number; intensity: number }> = ({ t, intensity }) => {
  const { layout, theme } = useStage();
  const { width: W, height: H, unit } = layout;
  const dark = theme.mode === "dark";
  const a = (pct: number): number => pct * intensity * (dark ? 1 : 0.5);
  const bands: Array<{ cx: number; cy: number; w: number; h: number; rot: number; color: string; pct: number; ph: number; k: number }> = [
    { cx: 0.2, cy: 0.18, w: 1.5, h: 0.62, rot: -16, color: theme.accent, pct: 62, ph: 0, k: 1 },
    { cx: 0.82, cy: 0.88, w: 1.45, h: 0.55, rot: -12, color: theme.accent2, pct: 55, ph: 1.7, k: 1 },
    { cx: 0.62, cy: 0.38, w: 1.1, h: 0.2, rot: 14, color: dark ? theme.accentText : theme.accent, pct: 34, ph: 3.1, k: 2 },
    { cx: 0.3, cy: 0.78, w: 1.2, h: 0.24, rot: 10, color: dark ? theme.accent2Text : theme.accent2, pct: 30, ph: 4.4, k: 1 },
    { cx: 0.5, cy: 0.52, w: 0.9, h: 0.1, rot: -8, color: dark ? "#ffffff" : theme.accent, pct: dark ? 10 : 16, ph: 2.2, k: 2 },
  ];
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      {bands.map((b, i) => {
        const w = b.w * W;
        const h = b.h * W * 0.62;
        const x = b.cx * W + 70 * unit * periodic(t, b.k, b.ph);
        const y = b.cy * H + 46 * unit * periodicCos(t, b.k, b.ph + 0.8);
        const rot = b.rot + 3 * periodic(t, 1, b.ph + 2);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x - w / 2,
              top: y - h / 2,
              width: w,
              height: h,
              transform: `rotate(${rot}deg)`,
              background: `radial-gradient(closest-side, ${mixed(b.color, a(b.pct))} 0%, ${mixed(b.color, a(b.pct) * 0.35)} 55%, transparent 100%)`,
            }}
          />
        );
      })}
    </div>
  );
};

/** A word that rises through its own mask; `p` 0..1. Starts mostly visible so the first frame reads. */
const MaskWord: React.FC<{ text: string; p: number; fill?: CSSProperties; last: boolean }> = ({ text, p, fill, last }) => (
  <span style={{ display: "inline-block", overflow: "hidden", paddingTop: "0.1em", marginTop: "-0.1em", paddingBottom: "0.16em", marginBottom: "-0.16em", verticalAlign: "bottom", marginRight: last ? 0 : "0.26em" }}>
    <span style={{ display: "inline-block", transform: `translateY(${lerp(30, 0, p)}%)`, opacity: lerp(0.5, 1, p), ...fill }}>{text}</span>
  </span>
);

const Kicker: React.FC<{ label: string; p: number }> = ({ label, p }) => {
  const { box, px, sp, theme } = useBox();
  void box;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: sp(2),
        marginBottom: sp(4),
        opacity: lerp(0.7, 1, p),
        transform: `translateY(${lerp(px(10), 0, p)}px)`,
        color: theme.accentText,
        fontSize: px(28),
        fontWeight: 500,
        letterSpacing: "0.16em",
        textTransform: "uppercase",
      }}
    >
      <span style={{ width: px(36) * p + px(12), height: px(4), borderRadius: px(2), background: theme.gradient, display: "block" }} />
      {label}
    </div>
  );
};

export const AuroraIntro: React.FC<IntroProps> = ({ scene, timing, t }) => {
  const { box, width, px, sp, theme, unit } = useBox();
  const maxW = Math.min(width, px(1500));
  const size = introSize(scene.title.length, maxW / unit);
  const ws = words(scene.title);
  const tagBorder = theme.mode === "dark" ? OG_CARD.tagBorder : theme.border;
  const sub = progress(t, timing.subtitleAt, 24);
  const k = progress(t, timing.kickerAt - 6, 20);
  return (
    <>
      <AuroraField t={t} intensity={lerp(0.7, 1, progress(t, 0, 50))} />
      <div style={{ ...box, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", paddingBottom: sp(3) }}>
        {scene.kicker !== undefined && <Kicker label={scene.kicker} p={k} />}
        <h1
          style={{
            margin: 0,
            maxWidth: maxW,
            fontSize: px(size),
            lineHeight: size >= 96 ? 1.06 : 1.12,
            fontWeight: OG_CARD.titleWeight,
            letterSpacing: "-0.035em",
            textWrap: "balance",
            color: theme.foreground,
            textShadow: theme.glow ? `0 0 ${px(40)}px ${theme.glow}` : undefined,
          }}
        >
          {ws.map((w, i) => (
            <MaskWord key={i} text={w} last={i === ws.length - 1} p={progress(t, timing.titleAt + i * timing.wordStep - 12, 26)} {...(ws.length > 1 && i === ws.length - 1 ? { fill: textGradient(theme) } : {})} />
          ))}
        </h1>
        {scene.subtitle !== undefined && (
          <p style={{ margin: 0, marginTop: sp(4), maxWidth: px(1240), fontSize: px(40), lineHeight: 1.5, color: theme.mutedForeground, opacity: sub, transform: `translateY(${lerp(px(18), 0, sub)}px)`, textWrap: "pretty" }}>{scene.subtitle}</p>
        )}
        {scene.tags !== undefined && scene.tags.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: sp(2), marginTop: sp(5), maxWidth: maxW }}>
            {scene.tags.map((tag, i) => {
              const p = progress(t, timing.tagAt[i] ?? 0, 18);
              return (
                <span key={i} style={{ fontSize: px(28), padding: `${sp(1)}px ${sp(3)}px`, borderRadius: 999, border: `${px(2)}px solid ${tagBorder}`, background: mixed(theme.card, 70), color: theme.foreground, opacity: p * OG_CARD.tagOpacity, transform: `translateY(${lerp(px(14), 0, p)}px)`, lineHeight: 1.3 }}>
                  {tag}
                </span>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
};

export const AuroraClosing: React.FC<ClosingProps> = ({ scene, timing, t, siteName }) => {
  const { box, width, px, sp, theme } = useBox();
  const maxW = Math.min(width, px(1500));
  const size = ctaSize(scene.cta.length);
  const ws = words(scene.cta);
  const mark = progress(t, timing.markAt, 22);
  const url = progress(t, timing.urlAt, 22);
  const bar = progress(t, timing.ctaAt + 20, 34);
  const nudge = periodic(t, 1) * px(5) * progress(t, 76, 8);
  const pill: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: sp(2),
    padding: `${sp(2)}px ${sp(4)}px`,
    borderRadius: 999,
    border: `${px(2)}px solid ${theme.mode === "dark" ? OG_CARD.tagBorder : theme.border}`,
    background: mixed(theme.card, 78),
    fontFamily: FONT_STACK.mono,
    fontSize: px(40),
    color: theme.foreground,
    opacity: url,
    transform: `translateY(${lerp(px(20), 0, url)}px)`,
    maxWidth: maxW,
  };
  return (
    <>
      <AuroraField t={t} intensity={lerp(0.75, 1, progress(t, 0, 50))} />
      <div style={{ ...box, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", paddingBottom: sp(3) }}>
        <div style={{ display: "flex", alignItems: "center", gap: sp(2), marginBottom: sp(4), opacity: lerp(0.7, 1, mark), color: theme.foreground, fontSize: px(32), fontWeight: 500, letterSpacing: "0.28em", textTransform: "uppercase" }}>
          <span style={{ width: px(16), height: px(16), borderRadius: px(4), background: theme.gradient, display: "block" }} />
          {siteName}
        </div>
        <h2 style={{ margin: 0, maxWidth: maxW, fontSize: px(size), lineHeight: 1.06, fontWeight: 600, letterSpacing: "-0.035em", textWrap: "balance", color: theme.foreground, textShadow: theme.glow ? `0 0 ${px(40)}px ${theme.glow}` : undefined }}>
          {ws.map((w, i) => (
            <MaskWord key={i} text={w} last={i === ws.length - 1} p={progress(t, timing.ctaAt + i * 3 - 12, 26)} {...(ws.length > 1 && i === ws.length - 1 ? { fill: textGradient(theme) } : {})} />
          ))}
        </h2>
        <div style={{ height: px(6), width: px(120) * bar, background: theme.gradient, borderRadius: px(3), marginTop: sp(5) }} />
        <div style={{ ...pill, marginTop: sp(5) }}>
          {scene.url}
          <svg width={px(36)} height={px(36)} viewBox="0 0 24 24" fill="none" stroke={theme.accentText} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: `translateX(${nudge}px)` }}>
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </div>
      </div>
    </>
  );
};
