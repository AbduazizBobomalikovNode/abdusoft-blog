import type { ReactNode } from "react";
import { FONT_STACK, radius } from "../../theme/tokens.ts";
import { useStage } from "../context.tsx";
import { clamp01, lerp, progress } from "../motion.ts";
import { contentBox, Fill, fitTitleBox, glowShadow, ScrambleText, TagPills, titleStyle } from "./a2-kit.tsx";
import type { ClosingProps, IntroProps } from "./kit.ts";

/**
 * boot: a terminal boot sequence (log lines, a progress bar) over a soft accent glow; the post title is
 * "decrypted" below it, character by character, from a deterministic scramble.
 */

interface Seg {
  text: string;
  color: string;
}

/** Segments cut after `n` characters (typing). */
const Typed: React.FC<{ segs: Seg[]; n: number }> = ({ segs, n }) => {
  let left = Math.max(0, Math.floor(n));
  const out: ReactNode[] = [];
  segs.forEach((s, i) => {
    if (left <= 0) return;
    const chars = [...s.text];
    out.push(
      <span key={i} style={{ color: s.color }}>
        {chars.length <= left ? s.text : chars.slice(0, left).join("")}
      </span>,
    );
    left -= chars.length;
  });
  return <>{out}</>;
};

const LOG_FONT = 28;
const LOG_LH = 1.6;
const PAD_Y = 20;

interface Row {
  segs: Seg[];
  /** Progress bar row: [status] label bar pct */
  bar?: { label: string; pct: number };
}

const Panel: React.FC<{ rows: Row[]; t: number; startOf: (k: number) => number; cps: number; barDoneAt: number; cursor?: boolean }> = ({ rows, t, startOf, cps, barDoneAt, cursor }) => {
  const { layout, theme } = useStage();
  const { px, sp } = layout;
  const fg = theme.code.fg;
  const muted = `color-mix(in srgb, ${fg} 62%, transparent)`;
  const lineH = px(LOG_FONT * LOG_LH);
  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        boxSizing: "border-box",
        padding: `${px(PAD_Y)}px ${sp(3)}px`,
        borderRadius: radius("lg", sp(4)),
        border: `${px(2)}px solid ${theme.border}`,
        background: theme.code.bg,
        fontFamily: FONT_STACK.mono,
        fontSize: px(LOG_FONT),
        lineHeight: `${lineH}px`,
        color: fg,
        overflow: "hidden",
        boxShadow: theme.mode === "light" ? `0 ${px(8)}px ${px(40)}px rgba(0,0,0,0.07)` : undefined,
      }}
    >
      {rows.map((row, k) => {
        const n = (t - startOf(k)) * cps;
        const barP = row.bar ? clamp01(row.bar.pct) : 0;
        const done = row.bar ? t >= barDoneAt : true;
        return (
          <div key={k} style={{ height: lineH, whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis", display: "flex", alignItems: "center", opacity: n > 0 ? 1 : 0 }}>
            {row.bar ? (
              <>
                <span style={{ color: done ? theme.tone.success : theme.accentText }}>{done ? "[ ok ]" : "[ .. ]"}</span>
                <span style={{ color: muted }}>{` ${row.bar.label} `}</span>
                <span style={{ display: "inline-block", width: px(420), height: px(14), borderRadius: px(7), background: `color-mix(in srgb, ${fg} 16%, transparent)`, overflow: "hidden", margin: `0 ${px(16)}px` }}>
                  <span style={{ display: "block", width: `${barP * 100}%`, height: "100%", background: theme.gradient }} />
                </span>
                <span style={{ color: fg }}>{`${String(Math.round(barP * 100)).padStart(3, " ")}%`}</span>
                {cursor && done && <span style={{ marginLeft: px(14), width: px(14), height: px(26), background: theme.accentText }} />}
              </>
            ) : (
              <Typed segs={row.segs} n={n} />
            )}
          </div>
        );
      })}
    </div>
  );
};

const Glow: React.FC = () => {
  const { layout, theme } = useStage();
  return (
    <Fill
      style={{
        width: layout.width,
        height: layout.height,
        background: `repeating-linear-gradient(0deg, transparent 0 5px, color-mix(in srgb, ${theme.foreground} ${theme.mode === "dark" ? 3 : 2}%, transparent) 5px 6px), radial-gradient(900px 620px at 88% 8%, color-mix(in srgb, ${theme.accent} ${theme.mode === "dark" ? 24 : 12}%, transparent), transparent 70%), radial-gradient(700px 500px at 0% 100%, color-mix(in srgb, ${theme.accent2} ${theme.mode === "dark" ? 12 : 7}%, transparent), transparent 70%)`,
      }}
    />
  );
};

export const BootIntro: React.FC<IntroProps> = ({ scene, timing, t }) => {
  const { layout, theme, siteName } = useStage();
  const { px, sp, unit, content } = layout;
  const ok = theme.tone.success;
  const fg = theme.code.fg;
  const tags = scene.tags ?? [];
  const rows: Row[] = [
    { segs: [{ text: "$ ", color: theme.accentText }, { text: `${siteName.toLowerCase()} boot --post`, color: fg }] },
    scene.kicker
      ? { segs: [{ text: "[ ok ]", color: ok }, { text: " kicker   ", color: `color-mix(in srgb, ${fg} 62%, transparent)` }, { text: scene.kicker, color: fg }] }
      : { segs: [{ text: "[ ok ]", color: ok }, { text: " runtime  ", color: `color-mix(in srgb, ${fg} 62%, transparent)` }, { text: "geist, geist-mono", color: fg }] },
    tags.length > 0
      ? { segs: [{ text: "[ ok ]", color: ok }, { text: " tags     ", color: `color-mix(in srgb, ${fg} 62%, transparent)` }, { text: tags.join(" · "), color: fg }] }
      : { segs: [{ text: "[ ok ]", color: ok }, { text: " theme    ", color: `color-mix(in srgb, ${fg} 62%, transparent)` }, { text: theme.mode, color: fg }] },
    { segs: [], bar: { label: "decode   ", pct: clamp01((t + 14) / 66) } },
  ];
  const panelU = rows.length * LOG_FONT * LOG_LH + 2 * PAD_Y;
  const subU = scene.subtitle ? 36 * 1.4 * Math.min(2, Math.ceil(scene.subtitle.length / 62)) + 20 : 0;
  const tagsU = tags.length > 0 ? 52 + 28 : 0;
  const budget = content.height / unit - panelU - 32 - subU - tagsU - 8;
  const size = fitTitleBox([...scene.title].length, content.width / unit, Math.max(160, budget));
  const n = [...scene.title].length;
  const speed = Math.min(2.2, 66 / n);
  const base = timing.titleAt - 26;
  const sub = progress(t, timing.subtitleAt, 20);
  const cursorOn = Math.floor(t / 8) % 2 === 0;

  return (
    <>
      <Glow />
      <div style={{ ...contentBox(content), display: "flex", flexDirection: "column", justifyContent: "center", gap: sp(4) }}>
        <Panel rows={rows} t={t} startOf={(k) => -20 + k * 6} cps={3.5} barDoneAt={52} cursor={cursorOn} />
        <div style={{ position: "relative" }}>
          <ScrambleText
            text={scene.title}
            t={t}
            resolveAt={(i) => base + i * speed}
            showFrom={-20}
            seed={11}
            glyphColor={theme.accentText}
            style={{ ...titleStyle(size, px), color: theme.foreground, textShadow: glowShadow(theme.glow, px(28)) }}
          />
        </div>
        {scene.subtitle !== undefined && (
          <p style={{ margin: 0, maxWidth: px(1300), fontSize: px(36), lineHeight: 1.4, color: theme.mutedForeground, opacity: sub, transform: `translateY(${lerp(px(16), 0, sub)}px)`, textWrap: "pretty" }}>{scene.subtitle}</p>
        )}
        {tags.length > 0 && <TagPills tags={tags} t={t} at={timing.tagAt} />}
      </div>
    </>
  );
};

export const BootClosing: React.FC<ClosingProps> = ({ scene, timing, t, siteName }) => {
  const { layout, theme } = useStage();
  const { px, sp, unit, content } = layout;
  const ok = theme.tone.success;
  const fg = theme.code.fg;
  const muted = `color-mix(in srgb, ${fg} 62%, transparent)`;
  // The LED pulses with the loop period so the final hold repeats exactly.
  const led = 0.65 + 0.35 * Math.sin((2 * Math.PI * t) / timing.loopFrames);
  const rows: Row[] = [
    { segs: [{ text: "$ ", color: theme.accentText }, { text: `${siteName.toLowerCase()} deploy --prod`, color: fg }] },
    { segs: [{ text: "[ ok ]", color: ok }, { text: " build    ", color: muted }, { text: "passed", color: fg }] },
    { segs: [{ text: "[ ok ]", color: ok }, { text: " publish  ", color: muted }, { text: siteName, color: fg }] },
    { segs: [], bar: { label: "ship     ", pct: clamp01((t + 4) / 44) } },
  ];
  const panelU = rows.length * LOG_FONT * LOG_LH + 2 * PAD_Y;
  const urlU = 40 * 1.5 + 28;
  const budget = content.height / unit - panelU - 32 - urlU - 8;
  const n = [...scene.cta].length;
  const size = fitTitleBox(n, content.width / unit, Math.max(160, budget));
  const speed = Math.min(1.6, 40 / n);
  const url = progress(t, timing.urlAt, 20);
  const typedUrl = Math.floor(clamp01((t - timing.urlAt) / 22) * [...scene.url].length);
  const cursorOn = t > 50 && Math.floor(t / 15) % 2 === 0; // period 30 divides the loop
  const urlChars = [...scene.url];

  return (
    <>
      <Glow />
      <div style={{ ...contentBox(content), display: "flex", flexDirection: "column", justifyContent: "center", gap: sp(4) }}>
        <div style={{ position: "relative" }}>
          <Panel rows={rows} t={t} startOf={(k) => k * 6} cps={3.5} barDoneAt={40} />
          <span style={{ position: "absolute", right: sp(3), top: px(PAD_Y + 12), width: px(14), height: px(14), borderRadius: 999, background: ok, opacity: t < 40 ? 0.35 : led }} />
        </div>
        <ScrambleText
          text={scene.cta}
          t={t}
          resolveAt={(i) => timing.ctaAt + i * speed}
          showFrom={0}
          seed={23}
          glyphColor={theme.accentText}
          style={{ ...titleStyle(size, px), color: theme.foreground, textShadow: glowShadow(theme.glow, px(28)) }}
        />
        <div
          style={{
            alignSelf: "flex-start",
            maxWidth: "100%",
            display: "flex",
            alignItems: "center",
            gap: px(12),
            padding: `${sp(1.5)}px ${sp(3)}px`,
            borderRadius: radius("lg", sp(4)),
            border: `${px(2)}px solid ${theme.border}`,
            background: theme.code.bg,
            fontFamily: FONT_STACK.mono,
            fontSize: px(40),
            color: fg,
            opacity: url,
            transform: `translateY(${lerp(px(20), 0, url)}px)`,
            boxSizing: "border-box",
            whiteSpace: "pre",
          }}
        >
          <span style={{ color: theme.accentText }}>$ open</span>
          <span style={{ overflow: "hidden" }}>{urlChars.slice(0, typedUrl).join("")}</span>
          <span style={{ width: px(20), height: px(40), background: theme.accentText, opacity: cursorOn || t < 50 ? 1 : 0 }} />
        </div>
      </div>
    </>
  );
};
