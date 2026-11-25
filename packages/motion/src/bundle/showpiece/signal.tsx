import type { CSSProperties } from "react";
import { FONT_STACK } from "../../theme/tokens.ts";
import { hash01 } from "../../timing.ts";
import { useStage } from "../context.tsx";
import { clamp01, easeOut, lerp, progress } from "../motion.ts";
import { contentBox, Fill, fitTitleBox, glowShadow, TagPills, titleStyle } from "./a2-kit.tsx";
import type { ClosingProps, IntroProps } from "./kit.ts";

/**
 * signal: a "signal lock" reveal. The headline starts as displaced horizontal slices with colour-channel
 * fringes under scanlines, then locks into crisp type; a small indicator (LED, label, level bars) reads
 * SEARCHING and then LOCKED. Motion is stepped (every 3rd frame) and small: no full-frame flashes.
 */

const SLICES = 6;

const SignalText: React.FC<{ text: string; size: number; t: number; amp: number; fringe: number; seed: number; style?: CSSProperties }> = ({ text, size, t, amp, fringe, seed, style }) => {
  const { layout, theme } = useStage();
  const { px } = layout;
  const base: CSSProperties = { ...titleStyle(size, px), color: theme.foreground, textShadow: glowShadow(theme.glow, px(26)), ...style };
  const dx = amp * px(20) + fringe;
  const blend = theme.mode === "dark" ? "screen" : "multiply";
  const layer: CSSProperties = { position: "absolute", left: 0, top: 0, width: "100%" };
  const crisp = amp < 0.02;
  const step = Math.floor(t / 3);
  const slices: React.ReactNode[] = [];
  if (!crisp) {
    // band edges with a little jitter so the slices are not a regular comb
    const edge = (k: number): number => (k === 0 ? 0 : k === SLICES ? 1 : k / SLICES + (hash01(seed + k * 7) - 0.5) * 0.08);
    for (let k = 0; k < SLICES; k++) {
      const hit = hash01(seed * 3 + k * 13 + step * 17) > 0.42;
      const shift = hit ? (hash01(seed + k * 29 + step * 5) - 0.5) * 2 * amp * px(30) : 0;
      slices.push(
        <div key={k} style={{ ...layer, clipPath: `inset(${edge(k) * 100}% 0 ${(1 - edge(k + 1)) * 100}% 0)`, transform: `translateX(${shift}px)`, ...base }}>
          {text}
        </div>,
      );
    }
  }
  return (
    <div style={{ position: "relative", isolation: "isolate" }}>
      <div style={{ ...base, opacity: crisp ? 1 : 0 }}>{text}</div>
      {dx > 0.4 && (
        <>
          <div style={{ ...layer, ...base, textShadow: undefined, color: theme.accentText, mixBlendMode: blend, opacity: 0.9, transform: `translateX(${-dx}px)` }}>{text}</div>
          <div style={{ ...layer, ...base, textShadow: undefined, color: theme.accent2Text, mixBlendMode: blend, opacity: 0.9, transform: `translateX(${dx}px)` }}>{text}</div>
        </>
      )}
      {slices}
    </div>
  );
};

/** Indicator row: LED, label, level bars. `lock` 0..1, `breathe` adds periodic motion to a locked bar set. */
const Indicator: React.FC<{ t: number; lock: number; label: string; lockedLabel: string; breathe: number; loop: number; blink: boolean }> = ({ t, lock, label, lockedLabel, breathe, loop, blink }) => {
  const { layout, theme } = useStage();
  const { px, sp } = layout;
  const locked = lock >= 0.999;
  const col = locked ? theme.tone.success : theme.accent2Text;
  const dots = ".".repeat((((Math.floor(t / 6) % 4) + 4) % 4));
  const ledOn = !blink || Math.floor(t / 15) % 2 === 0;
  const bars = Array.from({ length: 7 }, (_, i) => {
    const noisy = 8 + hash01(i * 17 + Math.floor(t / 2) * 5) * 30;
    const stair = 8 + i * 4.6;
    const wave = breathe * Math.sin((2 * Math.PI * t) / loop + i * 0.9) * 3;
    return lerp(noisy, stair, easeOut(lock)) + wave;
  });
  return (
    <div style={{ display: "flex", alignItems: "center", gap: sp(2), fontFamily: FONT_STACK.mono, fontSize: px(28), letterSpacing: "0.16em", color: col, height: px(48) }}>
      <span style={{ width: px(16), height: px(16), borderRadius: 999, background: col, opacity: ledOn ? 1 : 0.25 }} />
      <span style={{ minWidth: px(300), whiteSpace: "nowrap" }}>{locked ? lockedLabel : `${label}${dots}`}</span>
      <span style={{ display: "flex", alignItems: "flex-end", gap: px(6), height: px(40) }}>
        {bars.map((h, i) => (
          <span key={i} style={{ width: px(10), height: px(h), borderRadius: px(2), background: col, opacity: 0.55 + 0.45 * lock }} />
        ))}
      </span>
    </div>
  );
};

const Scanlines: React.FC<{ t: number; amp: number; loopSweep?: number }> = ({ t, amp, loopSweep }) => {
  const { layout, theme } = useStage();
  const { px } = layout;
  const dark = theme.mode === "dark";
  const H = layout.height;
  const y = loopSweep ? (((t % loopSweep) / loopSweep) * (H + px(480))) - px(240) : ((t * 9) % (H + px(480))) - px(240);
  return (
    <>
      <Fill
        style={{
          width: layout.width,
          height: layout.height,
          backgroundImage: `repeating-linear-gradient(0deg, ${dark ? "rgba(255,255,255,0.045)" : "rgba(0,0,0,0.05)"} 0 ${px(1.5)}px, transparent ${px(1.5)}px ${px(4)}px)`,
          opacity: 0.5 + 0.5 * amp,
        }}
      />
      <div style={{ position: "absolute", left: 0, width: layout.width, top: y, height: px(240), background: `linear-gradient(180deg, transparent, color-mix(in srgb, ${theme.accent} ${dark ? 13 : 8}%, transparent) 50%, transparent)` }} />
    </>
  );
};

/** Viewfinder corner marks around the content box. */
const Marks: React.FC<{ opacity: number }> = ({ opacity }) => {
  const { layout, theme } = useStage();
  const { px, content } = layout;
  const m = px(18);
  const L = px(44);
  const c = `color-mix(in srgb, ${theme.accentText} 70%, transparent)`;
  const mk = (left: boolean, top: boolean): React.ReactNode => (
    <div
      key={`${left}${top}`}
      style={{
        position: "absolute",
        width: L,
        height: L,
        [left ? "left" : "right"]: m,
        [top ? "top" : "bottom"]: m,
        [`border${top ? "Top" : "Bottom"}`]: `${px(3)}px solid ${c}`,
        [`border${left ? "Left" : "Right"}`]: `${px(3)}px solid ${c}`,
      }}
    />
  );
  return (
    <div style={{ ...contentBox(content), opacity, pointerEvents: "none" }}>
      {mk(true, true)}
      {mk(false, true)}
      {mk(true, false)}
      {mk(false, false)}
    </div>
  );
};

export const SignalIntro: React.FC<IntroProps> = ({ scene, timing, t }) => {
  const { layout, theme } = useStage();
  const { px, sp, unit, content } = layout;
  const tags = scene.tags ?? [];
  const lockT = 54;
  const lock = clamp01(0.35 + 0.65 * easeOut(clamp01(t / lockT)));
  const amp = t >= lockT ? 0 : 1 - lock;
  const subU = scene.subtitle ? 36 * 1.4 * Math.min(2, Math.ceil(scene.subtitle.length / 62)) + 20 : 0;
  const tagsU = tags.length > 0 ? 52 + 28 : 0;
  const kickU = scene.kicker ? 28 * 1.4 + 20 : 0;
  const budget = content.height / unit - 48 - kickU - subU - tagsU - 4 * 32 - 60;
  const size = fitTitleBox([...scene.title].length, (content.width - 2 * px(48)) / unit, Math.max(160, budget));
  const kick = progress(t, timing.kickerAt, 16);
  const sub = progress(t, timing.subtitleAt, 20);
  return (
    <>
      <Scanlines t={t} amp={amp} />
      <Marks opacity={progress(t, 0, 20) * 0.9} />
      <div style={{ ...contentBox(content), boxSizing: "border-box", padding: `0 ${px(48)}px`, display: "flex", flexDirection: "column", justifyContent: "center", gap: sp(3) }}>
        <Indicator t={t} lock={t >= lockT ? 1 : lock} label="SEARCHING" lockedLabel="SIGNAL LOCKED" breathe={0} loop={60} blink={false} />
        {scene.kicker !== undefined && (
          <div style={{ color: theme.accentText, fontSize: px(28), fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase", opacity: kick, transform: `translateX(${lerp(-px(24), 0, kick)}px)` }}>{scene.kicker}</div>
        )}
        <SignalText text={scene.title} size={size} t={t} amp={amp} fringe={0} seed={5} />
        {scene.subtitle !== undefined && (
          <p style={{ margin: 0, maxWidth: px(1300), fontSize: px(36), lineHeight: 1.4, color: theme.mutedForeground, opacity: sub, transform: `translateY(${lerp(px(16), 0, sub)}px)`, textWrap: "pretty" }}>{scene.subtitle}</p>
        )}
        {tags.length > 0 && <TagPills tags={tags} t={t} at={timing.tagAt} />}
      </div>
    </>
  );
};

export const SignalClosing: React.FC<ClosingProps> = ({ scene, timing, t, siteName }) => {
  const { layout, theme } = useStage();
  const { px, sp, unit, content } = layout;
  const loop = timing.loopFrames;
  const lockT = 58;
  const lock = clamp01(0.3 + 0.7 * easeOut(clamp01(t / lockT)));
  const amp = t >= lockT ? 0 : 1 - lock;
  const env = clamp01((t - 50) / 10);
  const fringe = env * px(1.6) * (0.6 + 0.4 * Math.sin((2 * Math.PI * t) / loop));
  const budget = content.height / unit - 48 - 80 - 3 * 32 - 60;
  const size = fitTitleBox([...scene.cta].length, (content.width - 2 * px(48)) / unit, Math.max(160, budget));
  const url = progress(t, timing.urlAt, 20);
  return (
    <>
      <Scanlines t={t} amp={amp} loopSweep={loop} />
      <Marks opacity={progress(t, 0, 20) * 0.9} />
      <div style={{ ...contentBox(content), boxSizing: "border-box", padding: `0 ${px(48)}px`, display: "flex", flexDirection: "column", justifyContent: "center", gap: sp(3) }}>
        <Indicator t={t} lock={t >= lockT ? 1 : lock} label="TUNING" lockedLabel={`ON AIR ${siteName.toUpperCase()}`} breathe={env} loop={loop} blink={t >= lockT} />
        <SignalText text={scene.cta} size={size} t={t} amp={amp} fringe={fringe} seed={9} />
        <div
          style={{
            alignSelf: "flex-start",
            maxWidth: "100%",
            display: "flex",
            alignItems: "center",
            gap: sp(2),
            padding: `${sp(1.5)}px ${sp(4)}px`,
            borderRadius: 999,
            border: `${px(2)}px solid ${theme.accentText}`,
            background: theme.card,
            fontFamily: FONT_STACK.mono,
            fontSize: px(40),
            color: theme.foreground,
            opacity: url,
            transform: `translateX(${lerp(-px(40), 0, url)}px)`,
            boxSizing: "border-box",
          }}
        >
          <svg width={px(30)} height={px(30)} viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 3l15 9-15 9z" fill={theme.accentText} />
          </svg>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{scene.url}</span>
        </div>
      </div>
    </>
  );
};
