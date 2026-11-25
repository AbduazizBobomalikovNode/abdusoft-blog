import type { CSSProperties } from "react";
import { FONT_STACK, OG_CARD } from "../../theme/tokens.ts";
import { useStage } from "../context.tsx";
import { clamp01, easeOut, lerp, progress } from "../motion.ts";
import { contentBox, easeOutBack, Fill, fitTitleBox, glowShadow, TagPills, titleStyle } from "./a2-kit.tsx";
import type { ClosingProps, IntroProps } from "./kit.ts";

/**
 * slam: large kinetic type. Every word is masked and slams up into place with overshoot and a small
 * scale-down; the last landing sends a shock ring with radial lines through the scene. An accent bar
 * sweeps under the title, a skewed accent panel and an outlined ghost glyph sit behind.
 */

const SLAM = 16;

const MaskLine: React.FC<{ p: number; children: React.ReactNode; style?: CSSProperties }> = ({ p, children, style }) => (
  <div style={{ overflow: "hidden", paddingBottom: "0.12em", marginBottom: "-0.12em", ...style }}>
    <div style={{ transform: `translateY(${(1 - clamp01(p)) * 105}%)`, opacity: p > 0 ? 1 : 0 }}>{children}</div>
  </div>
);

const SlamWords: React.FC<{ text: string; size: number; t: number; startOf: (i: number) => number; shake: number }> = ({ text, size, t, startOf, shake }) => {
  const { layout, theme } = useStage();
  const { px } = layout;
  const words = text.split(" ");
  return (
    <h1 style={{ ...titleStyle(size, px), color: theme.foreground, textShadow: glowShadow(theme.glow, px(30)), transform: `translateY(${shake}px)` }}>
      {words.map((w, i) => {
        const p = clamp01((t - startOf(i)) / SLAM);
        const y = (1 - easeOutBack(p, 2.2)) * 105; // goes slightly negative: overshoot
        const sc = 1 + (1 - easeOut(p)) * 0.2;
        return (
          <span
            key={i}
            style={{ display: "inline-block", overflow: "hidden", verticalAlign: "top", padding: "0.12em 0.04em 0.16em", margin: "-0.12em -0.04em -0.16em", marginRight: i < words.length - 1 ? "0.18em" : "-0.04em" }}
          >
            <span style={{ display: "inline-block", transform: `translateY(${y}%) scale(${sc})`, transformOrigin: "0 100%", opacity: p > 0 ? 1 : 0 }}>{w}</span>
          </span>
        );
      })}
    </h1>
  );
};

/** Shock ring with radial lines, centred in the content box, launched at frame `at`. */
const Shock: React.FC<{ t: number; at: number }> = ({ t, at }) => {
  const { layout, theme } = useStage();
  const { px, content } = layout;
  const p = clamp01((t - at) / 26);
  if (p <= 0 || p >= 1) return null;
  const e = easeOut(p);
  const cx = content.width * 0.5;
  const cy = content.height * 0.5;
  const r = px(120) + e * px(900);
  const rays = Array.from({ length: 14 }, (_, i) => {
    const a = (i / 14) * Math.PI * 2 + 0.2;
    const r0 = r * 0.72;
    const r1 = r * 0.94;
    return <line key={i} x1={cx + Math.cos(a) * r0} y1={cy + Math.sin(a) * r0} x2={cx + Math.cos(a) * r1} y2={cy + Math.sin(a) * r1} />;
  });
  return (
    <svg width={content.width} height={content.height} style={{ position: "absolute", left: content.x, top: content.y, overflow: "visible", opacity: (1 - p) * 0.55 }} aria-hidden="true">
      <g stroke={theme.accentText} strokeWidth={px(3)} fill="none" strokeLinecap="round">
        <circle cx={cx} cy={cy} r={r} strokeWidth={px(4) * (1 - p) + px(1)} />
        {rays}
      </g>
    </svg>
  );
};

/** Panel, ghost glyph and left bar behind the type. */
const Backplate: React.FC<{ t: number; ghost: string }> = ({ t, ghost }) => {
  const { layout, theme } = useStage();
  const { px } = layout;
  const dark = theme.mode === "dark";
  const slide = easeOut(progress(t, -10, 34, (n) => n));
  return (
    <>
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          right: 0,
          width: layout.width * 0.4,
          background: theme.gradient,
          opacity: dark ? 0.16 : 0.1,
          clipPath: "polygon(30% 0, 100% 0, 100% 100%, 0 100%)",
          transform: `translateX(${(1 - slide) * 100}%)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          right: px(60),
          bottom: -px(150),
          fontSize: px(900),
          lineHeight: 1,
          fontWeight: 700,
          color: "transparent",
          WebkitTextStroke: `${px(3)}px color-mix(in srgb, ${theme.accentText} ${dark ? 30 : 26}%, transparent)`,
          opacity: slide,
          letterSpacing: "-0.05em",
          userSelect: "none",
        }}
      >
        {ghost}
      </div>
    </>
  );
};

const Bar: React.FC<{ p: number; shimmer?: number }> = ({ p, shimmer }) => {
  const { layout, theme } = useStage();
  const { px } = layout;
  return (
    <div style={{ position: "relative", height: px(10), width: px(520), borderRadius: px(5), overflow: "hidden", transformOrigin: "left", transform: `scaleX(${easeOut(p)})`, background: theme.gradient }}>
      {shimmer !== undefined && (
        <div style={{ position: "absolute", top: 0, bottom: 0, width: "30%", left: `${lerp(-30, 100, shimmer)}%`, background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.55), transparent)" }} />
      )}
    </div>
  );
};

const Wordmark: React.FC<{ p: number; label: string }> = ({ p, label }) => {
  const { layout, theme } = useStage();
  const { px, sp } = layout;
  return (
    <MaskLine p={p}>
      <div style={{ display: "flex", alignItems: "center", gap: sp(2), color: theme.foreground, fontSize: px(32), fontWeight: 500, letterSpacing: `${OG_CARD.wordmarkLetterSpacingEm * 2}em`, textTransform: "uppercase" }}>
        <span style={{ width: px(16), height: px(16), borderRadius: px(4), background: theme.accent, display: "block" }} />
        {label}
      </div>
    </MaskLine>
  );
};

const shakeAt = (t: number, land: number, amp: number): number => {
  const d = t - land;
  return d < 0 || d > 8 ? 0 : Math.sin(d * 2.6) * amp * (1 - d / 8);
};

export const SlamIntro: React.FC<IntroProps> = ({ scene, timing, t }) => {
  const { layout, theme } = useStage();
  const { px, sp, unit, content } = layout;
  const tags = scene.tags ?? [];
  const words = scene.title.split(" ").length;
  const startOf = (i: number): number => timing.titleAt - 34 + i * timing.wordStep;
  const land = startOf(words - 1) + SLAM * 0.6;
  const subU = scene.subtitle ? 36 * 1.4 * Math.min(2, Math.ceil(scene.subtitle.length / 62)) + 20 : 0;
  const tagsU = tags.length > 0 ? 52 + 28 : 0;
  const kickU = scene.kicker ? 28 * 1.4 + 20 : 0;
  const budget = content.height / unit - kickU - subU - tagsU - 10 - 4 * 32 - 20;
  const size = fitTitleBox([...scene.title].length, content.width / unit, Math.max(160, budget));
  const kick = progress(t, timing.kickerAt - 22, 16);
  const sub = progress(t, timing.subtitleAt, 18);
  const bar = progress(t, land, 22);
  return (
    <>
      <Backplate t={t} ghost={[...scene.title][0] as string} />
      <Shock t={t} at={land} />
      <div style={{ ...contentBox(content), display: "flex", flexDirection: "column", justifyContent: "center", gap: sp(3) }}>
        {scene.kicker !== undefined && (
          <MaskLine p={kick}>
            <div style={{ display: "flex", alignItems: "center", gap: sp(2), color: theme.accentText, fontSize: px(28), fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase" }}>
              <span style={{ width: px(12), height: px(12), borderRadius: px(3), background: theme.accent, display: "block" }} />
              {scene.kicker}
            </div>
          </MaskLine>
        )}
        <SlamWords text={scene.title} size={size} t={t} startOf={startOf} shake={shakeAt(t, land, px(5))} />
        <Bar p={bar} />
        {scene.subtitle !== undefined && (
          <MaskLine p={sub} style={{ maxWidth: px(1300) }}>
            <p style={{ margin: 0, fontSize: px(36), lineHeight: 1.4, color: theme.mutedForeground, textWrap: "pretty" }}>{scene.subtitle}</p>
          </MaskLine>
        )}
        {tags.length > 0 && <TagPills tags={tags} t={t} at={timing.tagAt} pop />}
      </div>
    </>
  );
};

export const SlamClosing: React.FC<ClosingProps> = ({ scene, timing, t, siteName }) => {
  const { layout, theme } = useStage();
  const { px, sp, unit, content } = layout;
  const loop = timing.loopFrames;
  const words = scene.cta.split(" ").length;
  const startOf = (i: number): number => timing.ctaAt - 18 + i * 3;
  const land = startOf(words - 1) + SLAM * 0.6;
  const budget = content.height / unit - 32 - 10 - 80 - 4 * 32 - 20;
  const size = fitTitleBox([...scene.cta].length, content.width / unit, Math.max(160, budget));
  const mark = progress(t, timing.markAt, 18);
  const bar = progress(t, land, 22);
  const url = progress(t, timing.urlAt, 22);
  const env = progress(t, 54, 12);
  const phase = (t % loop) / loop;
  const ringR = px(240) + phase * px(520);
  const ring = env * 0.3 * Math.sin(Math.PI * phase);
  return (
    <>
      <Backplate t={t} ghost={[...scene.cta][0] as string} />
      <Shock t={t} at={land} />
      <Fill style={{ left: content.x, top: content.y, width: content.width, height: content.height, right: "auto", bottom: "auto", overflow: "visible" }}>
        <svg width={content.width} height={content.height} style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }} aria-hidden="true">
          <circle cx={content.width * 0.5} cy={content.height * 0.5} r={ringR} fill="none" stroke={theme.accentText} strokeWidth={px(3)} opacity={ring} />
        </svg>
      </Fill>
      <div style={{ ...contentBox(content), display: "flex", flexDirection: "column", justifyContent: "center", gap: sp(3) }}>
        <Wordmark p={mark} label={siteName} />
        <SlamWords text={scene.cta} size={size} t={t} startOf={startOf} shake={shakeAt(t, land, px(5))} />
        <Bar p={bar} shimmer={env > 0.99 ? phase : undefined} />
        <div
          style={{
            alignSelf: "flex-start",
            maxWidth: "100%",
            display: "flex",
            alignItems: "center",
            gap: sp(2),
            padding: `${sp(2)}px ${sp(4)}px`,
            borderRadius: 999,
            border: `${px(2)}px solid ${theme.mode === "dark" ? OG_CARD.tagBorder : theme.border}`,
            background: theme.card,
            fontFamily: FONT_STACK.mono,
            fontSize: px(40),
            color: theme.foreground,
            boxSizing: "border-box",
            clipPath: `inset(0 ${(1 - easeOut(url)) * 100}% 0 0 round 999px)`,
            opacity: url > 0 ? 1 : 0,
          }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{scene.url}</span>
          <svg width={px(36)} height={px(36)} viewBox="0 0 24 24" fill="none" stroke={theme.accentText} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </div>
      </div>
    </>
  );
};
