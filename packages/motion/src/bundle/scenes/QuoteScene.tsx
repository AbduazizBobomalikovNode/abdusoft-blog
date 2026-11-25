import { estimateLines } from "../../fit.ts";
import type { QuoteScene as D } from "../../schema/storyboard.ts";
import type { QuoteTiming } from "../../timeline.ts";
import { contentBox, glowShadow } from "../components/b-common.tsx";
import { useStage } from "../context.tsx";
import { lerp, progress } from "../motion.ts";

const SIZES = [88, 80, 72, 64, 56, 52, 48, 44];

export const QuoteScene: React.FC<{ scene: D; timing: QuoteTiming; t: number }> = ({ scene, timing, t }) => {
  const { layout, theme } = useStage();
  const { px, sp } = layout;
  const maxW = Math.min(layout.content.width, px(1360));
  const hasAuthor = scene.author !== undefined || scene.role !== undefined;
  const budget = layout.content.height - sp(16) - (hasAuthor ? sp(14) : 0);
  const size = SIZES.find((s) => estimateLines(scene.quote.length, s, maxW / layout.unit, 0.54) * s * 1.22 <= budget / layout.unit) ?? 44;
  const words = scene.quote.split(/\s+/);
  const mark = progress(t, 0, 26);
  const author = progress(t, timing.authorAt, 22);

  return (
    <div style={{ ...contentBox(layout), display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", paddingBottom: sp(2) }}>
      <svg
        width={px(104)}
        height={px(84)}
        viewBox="0 0 52 42"
        aria-hidden="true"
        style={{ opacity: mark, transform: `translateY(${lerp(px(24), 0, mark)}px) scale(${lerp(0.85, 1, mark)})`, marginBottom: sp(3), filter: theme.glow ? `drop-shadow(0 0 ${px(14)}px ${theme.glow})` : undefined }}
      >
        <defs>
          <linearGradient id="q-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={theme.accentText} />
            <stop offset="1" stopColor={theme.accent2Text} />
          </linearGradient>
        </defs>
        <path d="M0 42V24C0 10 8 2 22 0v8C15 10 12 14 12 20h10v22H0zm28 0V24c0-14 8-22 22-24v8c-7 2-10 6-10 12h10v22H28z" fill="url(#q-grad)" />
      </svg>
      <p
        style={{
          margin: 0,
          maxWidth: maxW,
          textAlign: "center",
          fontSize: px(size),
          lineHeight: 1.22,
          fontWeight: 600,
          letterSpacing: "-0.025em",
          color: theme.foreground,
          textWrap: "balance",
          textShadow: glowShadow(theme, px(26)),
        }}
      >
        {words.map((w, i) => {
          const p = progress(t, timing.quoteAt + i * timing.wordStep, 18);
          return (
            <span key={i} style={{ display: "inline-block", opacity: p, transform: `translateY(${lerp(px(28), 0, p)}px)`, marginRight: i < words.length - 1 ? "0.26em" : 0 }}>
              {w}
            </span>
          );
        })}
      </p>
      {hasAuthor && (
        <div style={{ marginTop: sp(5), display: "flex", flexDirection: "column", alignItems: "center", opacity: author, transform: `translateY(${lerp(px(16), 0, author)}px)` }}>
          <div style={{ height: px(5), width: px(88) * author, borderRadius: px(3), background: theme.gradient, marginBottom: sp(3) }} />
          {scene.author !== undefined && <div style={{ fontSize: px(40), fontWeight: 600, color: theme.foreground }}>{scene.author}</div>}
          {scene.role !== undefined && <div style={{ fontSize: px(30), marginTop: sp(0.5), color: theme.mutedForeground, textAlign: "center" }}>{scene.role}</div>}
        </div>
      )}
    </div>
  );
};
