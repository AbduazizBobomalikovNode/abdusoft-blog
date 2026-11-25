import type { CSSProperties } from "react";
import { FONT_STACK, OG_CARD } from "../../theme/tokens.ts";
import { lerp, progress } from "../motion.ts";
import { ctaSize, halo, introSize, mixed, periodic, useBox, words } from "./a1-common.tsx";
import { ConstellationField } from "./a1-constellation-field.tsx";
import type { ClosingProps, IntroProps } from "./kit.ts";

/** Constellation: a deterministic star network spirals in and frames the title (see a1-constellation-field.tsx). */
const Star: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ display: "block" }}>
    <path d="M12 1 C12.6 8 16 11.4 23 12 C16 12.6 12.6 16 12 23 C11.4 16 8 12.6 1 12 C8 11.4 11.4 8 12 1 Z" fill={color} />
  </svg>
);

const Word: React.FC<{ text: string; p: number; last: boolean }> = ({ text, p, last }) => (
  <span style={{ display: "inline-block", opacity: lerp(0.55, 1, p), transform: `translateY(${lerp(26, 0, p)}px) scale(${lerp(0.96, 1, p)})`, marginRight: last ? 0 : "0.26em" }}>{text}</span>
);

export const ConstellationIntro: React.FC<IntroProps> = ({ scene, timing, t }) => {
  const { box, width, px, sp, theme, unit } = useBox();
  const maxW = Math.min(width * 0.8, px(1380));
  const size = introSize(scene.title.length, maxW / unit);
  const ws = words(scene.title);
  const sub = progress(t, timing.subtitleAt, 24);
  const k = progress(t, timing.kickerAt - 6, 20);
  const shadow = [halo(theme, px), theme.glow ? `0 0 ${px(40)}px ${theme.glow}` : ""].filter(Boolean).join(", ");
  return (
    <>
      <ConstellationField t={t} />
      <div style={{ ...box, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center" }}>
        {scene.kicker !== undefined && (
          <div style={{ display: "flex", alignItems: "center", gap: sp(2), marginBottom: sp(3), opacity: lerp(0.7, 1, k), color: theme.accentText, fontSize: px(28), fontWeight: 500, letterSpacing: "0.16em", textTransform: "uppercase", textShadow: halo(theme, px) }}>
            <Star size={px(26)} color={theme.accentText} />
            {scene.kicker}
          </div>
        )}
        <h1 style={{ margin: 0, maxWidth: maxW, fontSize: px(size), lineHeight: size >= 96 ? 1.06 : 1.12, fontWeight: OG_CARD.titleWeight, letterSpacing: "-0.035em", textWrap: "balance", color: theme.foreground, textShadow: shadow }}>
          {ws.map((w, i) => (
            <Word key={i} text={w} last={i === ws.length - 1} p={progress(t, timing.titleAt + i * timing.wordStep - 12, 26)} />
          ))}
        </h1>
        {scene.subtitle !== undefined && (
          <p style={{ margin: 0, marginTop: sp(3), maxWidth: px(1100), fontSize: px(38), lineHeight: 1.45, color: theme.mutedForeground, opacity: sub, transform: `translateY(${lerp(px(16), 0, sub)}px)`, textShadow: halo(theme, px), textWrap: "pretty" }}>{scene.subtitle}</p>
        )}
        {scene.tags !== undefined && scene.tags.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: sp(2), marginTop: sp(3), maxWidth: maxW }}>
            {scene.tags.map((tag, i) => {
              const p = progress(t, timing.tagAt[i] ?? 0, 18);
              return (
                <span key={i} style={{ fontSize: px(28), padding: `${sp(1)}px ${sp(3)}px`, borderRadius: 999, border: `${px(2)}px solid ${theme.mode === "dark" ? OG_CARD.tagBorder : theme.border}`, background: mixed(theme.card, 80), color: theme.foreground, opacity: p * OG_CARD.tagOpacity, transform: `translateY(${lerp(px(12), 0, p)}px)`, lineHeight: 1.3 }}>
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

export const ConstellationClosing: React.FC<ClosingProps> = ({ scene, timing, t, siteName }) => {
  const { box, width, px, sp, theme } = useBox();
  const maxW = Math.min(width * 0.8, px(1380));
  const size = ctaSize(scene.cta.length);
  const ws = words(scene.cta);
  const mark = progress(t, timing.markAt, 22);
  const url = progress(t, timing.urlAt, 22);
  const twinkle = 0.85 + 0.15 * periodic(t, 2) * progress(t, 76, 8);
  const shadow = [halo(theme, px), theme.glow ? `0 0 ${px(40)}px ${theme.glow}` : ""].filter(Boolean).join(", ");
  const pill: CSSProperties = { display: "flex", alignItems: "center", gap: sp(2), padding: `${sp(2)}px ${sp(4)}px`, borderRadius: 999, border: `${px(2)}px solid ${theme.mode === "dark" ? OG_CARD.tagBorder : theme.border}`, background: mixed(theme.card, 88), fontFamily: FONT_STACK.mono, fontSize: px(40), color: theme.foreground, opacity: url, transform: `translateY(${lerp(px(18), 0, url)}px)`, maxWidth: maxW };
  return (
    <>
      <ConstellationField t={t} />
      <div style={{ ...box, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: sp(2), marginBottom: sp(3), opacity: lerp(0.7, 1, mark), color: theme.foreground, fontSize: px(32), fontWeight: 500, letterSpacing: "0.28em", textTransform: "uppercase", textShadow: halo(theme, px) }}>
          <span style={{ opacity: twinkle }}>
            <Star size={px(30)} color={theme.accentText} />
          </span>
          {siteName}
        </div>
        <h2 style={{ margin: 0, maxWidth: maxW, fontSize: px(size), lineHeight: 1.06, fontWeight: 600, letterSpacing: "-0.035em", textWrap: "balance", color: theme.foreground, textShadow: shadow }}>
          {ws.map((w, i) => (
            <Word key={i} text={w} last={i === ws.length - 1} p={progress(t, timing.ctaAt + i * 3 - 12, 26)} />
          ))}
        </h2>
        <div style={{ ...pill, marginTop: sp(5) }}>
          {scene.url}
          <svg width={px(36)} height={px(36)} viewBox="0 0 24 24" fill="none" stroke={theme.accentText} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </div>
      </div>
    </>
  );
};
