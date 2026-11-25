import type { CSSProperties } from "react";
import { FONT_STACK, OG_CARD } from "../../theme/tokens.ts";
import { useStage } from "../context.tsx";
import { lerp, progress } from "../motion.ts";
import { estimateLines } from "../../fit.ts";
import { ctaSize, halo, introSize, mixed, periodic, useBox } from "./a1-common.tsx";
import type { ClosingProps, IntroProps } from "./kit.ts";
import { LOOP_FRAMES } from "../../timing.ts";

/**
 * Blueprint: a perspective drafting floor (projected by hand in SVG: lines radiate from a vanishing
 * point, cross lines are spaced by 1/(1+kz)) whose lines draw in, then scroll toward the viewer by exactly
 * one cell per LOOP_FRAMES (seamless loop). The title is built like a drawing: outlined type, crop marks
 * and a ruler draw in, a scan bar sweeps across and the outline resolves into solid type.
 */
const HORIZON = 0.6;

const Floor: React.FC<{ t: number }> = ({ t: clock }) => {
  const t = clock + 18; // starts part-drawn so the first frame is already a composition
  const { layout, theme } = useStage();
  const { width: W, height: H, px } = layout;
  const dark = theme.mode === "dark";
  const line = dark ? theme.accentText : theme.accent;
  const y0 = H * HORIZON;
  const cx = W / 2;
  const depth = (z: number): number => 1 / (1 + z * 0.42);
  const off = (clock % LOOP_FRAMES) / LOOP_FRAMES;
  const rows: React.ReactNode[] = [];
  for (let k = 0; k <= 15; k++) {
    const z = k - off;
    const y = y0 + (H - y0) * depth(z);
    const p = progress(t, 2 + k * 3, 24);
    const half = (W * 1.4 * (y - y0)) / (H - y0);
    const alpha = (dark ? 0.62 : 0.5) * depth(z) ** 0.6 * Math.min(1, Math.max(0, (13 - z) / 2)) * Math.min(1, Math.max(0, z + 1)); // fades in/out at both ends so the one-cell scroll loops without a pop
    if (p <= 0) continue;
    rows.push(<line key={`h${k}`} x1={cx - half} x2={cx + half} y1={y} y2={y} stroke={line} strokeOpacity={alpha} strokeWidth={px(k === 0 ? 2.4 : 2)} pathLength={1} strokeDasharray="1" strokeDashoffset={1 - p} />);
  }
  const cols: React.ReactNode[] = [];
  const gap = W / 9;
  for (let j = -11; j <= 11; j++) {
    const xb = cx + j * gap;
    const p = progress(t, 1 + Math.abs(j) * 2, 30);
    if (p <= 0) continue;
    cols.push(<line key={`v${j}`} x1={cx + (xb - cx) * 0.02} y1={y0 + 1} x2={xb} y2={H + 40} stroke={line} strokeOpacity={(dark ? 0.5 : 0.4) * (1 - Math.abs(j) / 14)} strokeWidth={px(2)} pathLength={1} strokeDasharray="1" strokeDashoffset={1 - p} />);
  }
  const glow = progress(t, 0, 40);
  const mask = `linear-gradient(to bottom, transparent ${HORIZON * 100 - 4}%, black ${HORIZON * 100 + 14}%)`;
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <div style={{ position: "absolute", left: 0, right: 0, top: y0 - H * 0.55, height: H * 0.8, background: `radial-gradient(closest-side at 50% 69%, ${mixed(theme.accent, (dark ? 46 : 15) * (0.6 + 0.4 * glow))}, transparent 100%)` }} />
      <svg width={W} height={H} style={{ position: "absolute", inset: 0, maskImage: mask, WebkitMaskImage: mask }}>
        {cols}
        {rows}
      </svg>
      <div style={{ position: "absolute", left: W * 0.06 * (1 - glow), right: W * 0.06 * (1 - glow), top: y0 - px(1), height: px(2), background: `linear-gradient(90deg, transparent, ${line} 18%, ${line} 82%, transparent)`, opacity: 0.7 * glow }} />
    </div>
  );
};


/** Drafting motif on the right: concentric construction circles, crosshair and a diagonal radius, drawn in. */
const Motif: React.FC<{ t: number }> = ({ t }) => {
  const { layout, theme } = useStage();
  const { width: W, height: H, px } = layout;
  const c = theme.mode === "dark" ? theme.accentText : theme.accent;
  const cx = W * 0.77;
  const cy = H * 0.37;
  const R = px(250);
  const d = (at: number, dur: number): number => 1 - progress(t + 14, at, dur);
  const a = theme.mode === "dark" ? 0.5 : 0.42;
  const rot = 1.5 * periodic(t, 1);
  const stroke = { stroke: c, fill: "none", strokeWidth: px(2), pathLength: 1 } as const;
  return (
    <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
      <g transform={`rotate(${rot} ${cx} ${cy})`}>
        <circle cx={cx} cy={cy} r={R} {...stroke} strokeOpacity={a} strokeDasharray="1" strokeDashoffset={d(0, 50)} />
        <circle cx={cx} cy={cy} r={R * 0.62} {...stroke} strokeOpacity={a * 0.8} strokeDasharray="0.02 0.012" strokeDashoffset={0} style={{ opacity: 1 - d(6, 40) }} />
        <circle cx={cx} cy={cy} r={R * 1.18} {...stroke} strokeOpacity={a * 0.45} strokeDasharray="1" strokeDashoffset={d(10, 60)} />
        <line x1={cx - R * 1.35} x2={cx + R * 1.35} y1={cy} y2={cy} {...stroke} strokeOpacity={a * 0.8} strokeDasharray="1" strokeDashoffset={d(4, 40)} />
        <line x1={cx} x2={cx} y1={cy - R * 1.35} y2={cy + R * 1.35} {...stroke} strokeOpacity={a * 0.8} strokeDasharray="1" strokeDashoffset={d(8, 40)} />
        <line x1={cx} y1={cy} x2={cx + R * 0.7071} y2={cy - R * 0.7071} {...stroke} strokeWidth={px(3)} strokeOpacity={a * 1.3} strokeDasharray="1" strokeDashoffset={d(16, 34)} />
        <rect x={cx - px(8)} y={cy - px(8)} width={px(16)} height={px(16)} fill={c} opacity={0.9 * (1 - d(10, 20))} />
      </g>
    </svg>
  );
};

/** Estimated rendered width (px) of a balanced title block, used to size the drawing marks to the text. */
function textWidth(text: string, size: number, maxW: number, unit: number): { box: number; ink: number } {
  const lines = estimateLines([...text].length, size, maxW / unit, 0.52);
  const perLine = Math.ceil([...text].length / lines);
  const ink = Math.min(maxW, perLine * size * 0.56 * unit);
  return { box: Math.min(maxW, ink * 1.12), ink };
}

const mono: CSSProperties = { fontFamily: FONT_STACK.mono, letterSpacing: "0.08em" };

/** Crop marks, drawn from the corners; `p` 0..1. */
const Corners: React.FC<{ p: number; pad: number }> = ({ p, pad }) => {
  const { px, theme } = useBox();
  const len = px(44) * p;
  const common: CSSProperties = { position: "absolute", width: len, height: len, borderColor: theme.accentText, borderStyle: "solid", borderWidth: 0, opacity: 0.9 };
  const w = px(3);
  return (
    <>
      <div style={{ ...common, left: -pad, top: -pad, borderTopWidth: w, borderLeftWidth: w }} />
      <div style={{ ...common, right: -pad, top: -pad, borderTopWidth: w, borderRightWidth: w }} />
      <div style={{ ...common, left: -pad, bottom: -pad, borderBottomWidth: w, borderLeftWidth: w }} />
      <div style={{ ...common, right: -pad, bottom: -pad, borderBottomWidth: w, borderRightWidth: w }} />
    </>
  );
};

/** Ruler: ticks every 24 units, major every 120, drawn left to right. */
const Ruler: React.FC<{ p: number; width: number }> = ({ p, width }) => {
  const { px, theme } = useBox();
  const c = theme.accentText;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: px(16), width, marginTop: px(24), opacity: 0.95 }}>
      <div
        style={{
          height: px(18),
          flex: 1,
          transformOrigin: "left",
          transform: `scaleX(${p})`,
          backgroundImage: `linear-gradient(90deg, ${c} ${px(3)}px, transparent ${px(3)}px), linear-gradient(90deg, ${mixed(c, 70)} ${px(2)}px, transparent ${px(2)}px), linear-gradient(${c}, ${c})`,
          backgroundSize: `${px(120)}px 100%, ${px(24)}px 55%, 100% ${px(2)}px`,
          backgroundPosition: "0 0, 0 100%, 0 50%",
          backgroundRepeat: "repeat-x, repeat-x, no-repeat",
        }}
      />
      <span style={{ ...mono, fontSize: px(28), color: theme.accentText, opacity: p }}>1:1</span>
    </div>
  );
};

/** Outlined type that resolves into solid type behind a scan bar. */
const DrawnText: React.FC<{ text: string; size: number; scan: number; maxW: number; as: "h1" | "h2"; weight: number; track: string; lh: number }> = ({ text, size, scan, maxW, as: Tag, weight, track, lh }) => {
  const { px, theme, unit } = useBox();
  const w = textWidth(text, size, maxW, unit);
  const base: CSSProperties = { margin: 0, width: w.box, fontSize: px(size), lineHeight: lh, fontWeight: weight, letterSpacing: track, textWrap: "balance" };
  const x = scan * w.ink;
  const clip = scan >= 1 ? "none" : `inset(-10% calc(100% - ${x}px) -10% 0)`;
  return (
    <div style={{ position: "relative", width: w.box }}>
      <Tag style={{ ...base, color: mixed(theme.foreground, 16), WebkitTextStroke: `${px(2.5)}px ${theme.accentText}` }}>{text}</Tag>
      <Tag aria-hidden="true" style={{ ...base, position: "absolute", left: 0, top: 0, color: theme.foreground, clipPath: clip, textShadow: theme.glow ? `0 0 ${px(36)}px ${theme.glow}` : undefined }}>
        {text}
      </Tag>
      <div style={{ position: "absolute", top: "-6%", bottom: "-6%", left: x, width: px(4), background: theme.accentText, opacity: scan > 0 && scan < 1 ? 0.95 : 0, boxShadow: `0 0 ${px(18)}px ${theme.accentText}` }} />
    </div>
  );
};

export const BlueprintIntro: React.FC<IntroProps> = ({ scene, timing, t }) => {
  const { box, width, px, sp, theme, unit } = useBox();
  const maxW = Math.min(width * 0.92, px(1500));
  const size = introSize(scene.title.length, maxW / unit);
  const scan = progress(t, 18, 46, (n) => n * n * (3 - 2 * n));
  const marks = progress(t, 0, 26);
  const sub = progress(t, timing.subtitleAt, 22);
  const k = progress(t, timing.kickerAt - 6, 18);
  return (
    <>
      <Floor t={t} />
      <Motif t={t} />
      <div style={{ ...box, display: "flex", flexDirection: "column", justifyContent: "center", paddingBottom: px(150) }}>
        {scene.kicker !== undefined && (
          <div style={{ ...mono, display: "flex", alignItems: "center", gap: sp(2), marginBottom: sp(4), color: theme.accentText, fontSize: px(28), fontWeight: 500, textTransform: "uppercase", opacity: lerp(0.7, 1, k), textShadow: halo(theme, px) }}>
            <span style={{ width: px(28), height: px(28), border: `${px(3)}px solid ${theme.accentText}`, display: "block", transform: `rotate(${lerp(45, 0, k)}deg)` }} />
            {scene.kicker}
          </div>
        )}
        <div style={{ position: "relative", alignSelf: "flex-start" }}>
          <Corners p={marks} pad={px(28)} />
          <DrawnText text={scene.title} size={size} scan={scan} maxW={maxW} as="h1" weight={OG_CARD.titleWeight} track="-0.03em" lh={size >= 96 ? 1.06 : 1.12} />
        </div>
        <Ruler p={progress(t, 8, 40)} width={Math.min(maxW, px(900))} />
        {scene.subtitle !== undefined && (
          <p style={{ margin: 0, marginTop: sp(3), maxWidth: px(1180), fontSize: px(38), lineHeight: 1.45, color: theme.mutedForeground, opacity: sub, transform: `translateY(${lerp(px(16), 0, sub)}px)`, textShadow: halo(theme, px), textWrap: "pretty" }}>{scene.subtitle}</p>
        )}
        {scene.tags !== undefined && scene.tags.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: sp(2), marginTop: sp(3), maxWidth: maxW }}>
            {scene.tags.map((tag, i) => {
              const p = progress(t, timing.tagAt[i] ?? 0, 18);
              return (
                <span key={i} style={{ ...mono, fontSize: px(28), padding: `${sp(1)}px ${sp(2.5)}px`, border: `${px(2)}px dashed ${theme.accentText}`, background: mixed(theme.background, 80), color: theme.foreground, opacity: p, transform: `translateY(${lerp(px(12), 0, p)}px)`, lineHeight: 1.3 }}>
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

export const BlueprintClosing: React.FC<ClosingProps> = ({ scene, timing, t, siteName }) => {
  const { box, width, px, sp, theme } = useBox();
  const maxW = Math.min(width * 0.92, px(1500));
  const size = ctaSize(scene.cta.length);
  const scan = progress(t, timing.ctaAt, 40, (n) => n * n * (3 - 2 * n));
  const marks = progress(t, 0, 26);
  const mark = progress(t, timing.markAt, 20);
  const url = progress(t, timing.urlAt, 22);
  const pulse = 0.5 + 0.5 * periodic(t, 1) * progress(t, 76, 8);
  const cell: CSSProperties = { ...mono, display: "flex", alignItems: "center", gap: sp(2), padding: `${sp(2)}px ${sp(3)}px`, color: theme.foreground, fontSize: px(36) };
  const border = `${px(3)}px solid ${theme.accentText}`;
  return (
    <>
      <Floor t={t} />
      <Motif t={t} />
      <div style={{ ...box, display: "flex", flexDirection: "column", justifyContent: "center", paddingBottom: px(150) }}>
        <div style={{ ...mono, display: "flex", alignItems: "center", gap: sp(2), marginBottom: sp(4), color: theme.accentText, fontSize: px(28), fontWeight: 500, textTransform: "uppercase", opacity: lerp(0.7, 1, mark), textShadow: halo(theme, px) }}>
          <span style={{ width: px(28), height: px(28), border: `${px(3)}px solid ${theme.accentText}`, display: "block", background: mixed(theme.accent, 40 + 40 * pulse) }} />
          {siteName}
        </div>
        <div style={{ position: "relative", alignSelf: "flex-start" }}>
          <Corners p={marks} pad={px(28)} />
          <DrawnText text={scene.cta} size={size} scan={scan} maxW={maxW} as="h2" weight={600} track="-0.035em" lh={1.06} />
        </div>
        <Ruler p={progress(t, 8, 40)} width={Math.min(maxW, px(900))} />
        <div style={{ marginTop: sp(4), alignSelf: "flex-start", display: "flex", border, background: mixed(theme.background, 82), opacity: url, transform: `translateY(${lerp(px(16), 0, url)}px)`, maxWidth: maxW }}>
          <div style={{ ...cell, borderRight: border, minWidth: 0 }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{scene.url}</span>
          </div>
          <div style={{ ...cell, color: theme.accentText }}>
            <svg width={px(36)} height={px(36)} viewBox="0 0 24 24" fill="none" stroke={theme.accentText} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </div>
        </div>
      </div>
    </>
  );
};
