import type { StatScene as D } from "../../schema/storyboard.ts";
import type { StatTiming } from "../../timeline.ts";
import { MONO_ADVANCE } from "../../fit.ts";
import { cardRadius, contentBox, glowShadow, headingHeight, SceneHeading } from "../components/b-common.tsx";
import { useStage } from "../context.tsx";
import { lerp, progress } from "../motion.ts";

/** Grouped integer part with a normal space, fixed decimals, hyphen-minus for negatives. */
export function formatStat(value: number, decimals: number): string {
  const neg = value < 0;
  const [int, frac] = Math.abs(value).toFixed(decimals).split(".") as [string, string | undefined];
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${neg ? "-" : ""}${grouped}${frac !== undefined ? `.${frac}` : ""}`;
}

const SIZES = [180, 160, 140, 120, 104, 92, 80, 72, 64, 56];

export const StatScene: React.FC<{ scene: D; timing: StatTiming; t: number }> = ({ scene, timing, t }) => {
  const { layout, theme } = useStage();
  const { px, sp } = layout;
  const n = scene.stats.length;
  const gap = sp(6);
  const colW = (layout.content.width - gap * (n - 1)) / n;
  const innerW = colW - 2 * sp(4);
  // widest final string decides the size (tabular numerals: about 0.6 em per glyph, affixes at half size)
  const widthAt = (size: number): number =>
    Math.max(
      ...scene.stats.map((s) => {
        const body = formatStat(s.value, s.decimals ?? 0).length * size * MONO_ADVANCE;
        const aff = ((s.prefix?.length ?? 0) + (s.suffix?.length ?? 0)) * size * 0.5 * 0.62;
        return body + aff;
      }),
    );
  const size = SIZES.find((s) => widthAt(s) <= innerW / layout.unit) ?? 56;
  const head = headingHeight(scene.heading, px, sp);

  return (
    <div style={{ ...contentBox(layout), display: "flex", flexDirection: "column", justifyContent: "center", paddingBottom: sp(4) }}>
      {scene.heading !== undefined && <SceneHeading text={scene.heading} t={t} at={timing.headingAt} align={n === 1 ? "center" : "left"} />}
      <div style={{ display: "flex", gap, justifyContent: "center", marginTop: head > 0 ? sp(2) : 0 }}>
        {scene.stats.map((s, i) => {
          const at = timing.statAt[i] ?? 0;
          const enter = progress(t, at, 22);
          const count = progress(t, at + 4, timing.countFrames);
          const dec = s.decimals ?? 0;
          const shown = formatStat(s.value * count, dec);
          const settled = progress(t, at + timing.countFrames, 14);
          return (
            <div
              key={i}
              style={{
                width: n === 1 ? Math.min(colW, px(1100)) : colW,
                padding: `${sp(7)}px ${sp(4)}px ${sp(6)}px`,
                borderRadius: cardRadius(sp),
                border: `${px(2)}px solid ${theme.border}`,
                background: theme.card,
                opacity: enter,
                transform: `translateY(${lerp(px(36), 0, enter)}px)`,
                textAlign: n === 1 ? "center" : "left",
                boxShadow: theme.mode === "light" ? `0 ${px(8)}px ${px(40)}px rgba(0,0,0,0.06)` : undefined,
                position: "relative",
                overflow: "hidden",
              }}
            >
              <div style={{ position: "absolute", left: 0, top: 0, height: px(6), width: `${(0.25 + 0.75 * settled) * 100}%`, background: theme.gradient }} />
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: n === 1 ? "center" : "flex-start",
                  whiteSpace: "nowrap",
                  fontSize: px(size),
                  lineHeight: 1.05,
                  fontWeight: 600,
                  letterSpacing: "-0.03em",
                  fontVariantNumeric: "tabular-nums",
                  color: theme.foreground,
                  textShadow: glowShadow(theme, px(30)),
                }}
              >
                {s.prefix !== undefined && <span style={{ fontSize: px(size * 0.5), color: theme.accentText, marginRight: px(size * 0.06) }}>{s.prefix}</span>}
                <span>{shown}</span>
                {s.suffix !== undefined && <span style={{ fontSize: px(size * 0.5), color: theme.accentText, marginLeft: px(size * 0.06) }}>{s.suffix}</span>}
              </div>
              <div style={{ height: px(4), width: px(96) * settled, background: theme.accent, borderRadius: px(2), margin: `${sp(3)}px ${n === 1 ? "auto" : "0"} ${sp(3)}px` }} />
              <div style={{ fontSize: px(n === 3 ? 36 : 40), fontWeight: 500, lineHeight: 1.25, color: theme.foreground, textWrap: "balance" }}>{s.label}</div>
              {s.note !== undefined && (
                <div style={{ marginTop: sp(1.5), fontSize: px(28), lineHeight: 1.35, color: theme.mutedForeground, opacity: progress(t, at + 30, 18), textWrap: "pretty" }}>{s.note}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
