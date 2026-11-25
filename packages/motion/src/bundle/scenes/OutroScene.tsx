import type { OutroScene as OutroSceneData } from "../../schema/storyboard.ts";
import type { OutroTiming } from "../../timeline.ts";
import { FONT_STACK, OG_CARD } from "../../theme/tokens.ts";
import { useStage } from "../context.tsx";
import { lerp, progress } from "../motion.ts";

export const OutroScene: React.FC<{ scene: OutroSceneData; timing: OutroTiming; t: number }> = ({ scene, timing, t }) => {
  const { layout, theme, siteName } = useStage();
  const { px, sp } = layout;
  const name = scene.siteName ?? siteName;
  const mark = progress(t, timing.markAt, 22);
  const cta = progress(t, timing.ctaAt, 24);
  const url = progress(t, timing.urlAt, 22);
  const bar = progress(t, timing.markAt + 4, 28);
  const size = scene.cta.length <= 24 ? 120 : scene.cta.length <= 36 ? 104 : scene.cta.length <= 48 ? 88 : 72;

  return (
    <div
      style={{
        position: "absolute",
        left: layout.content.x,
        top: layout.content.y,
        width: layout.content.width,
        height: layout.content.height,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        paddingBottom: sp(4),
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: sp(2),
          marginBottom: sp(4),
          opacity: mark,
          transform: `translateY(${lerp(px(16), 0, mark)}px)`,
          color: theme.foreground,
          fontSize: px(32),
          fontWeight: 500,
          letterSpacing: `${OG_CARD.wordmarkLetterSpacingEm * 2}em`,
          textTransform: "uppercase",
        }}
      >
        <span style={{ width: px(16), height: px(16), borderRadius: px(4), background: theme.accent, display: "block" }} />
        {name}
      </div>
      <h2
        style={{
          margin: 0,
          maxWidth: px(1440),
          fontSize: px(size),
          lineHeight: 1.06,
          fontWeight: 600,
          letterSpacing: "-0.035em",
          textWrap: "balance",
          color: theme.foreground,
          opacity: cta,
          transform: `translateY(${lerp(px(40), 0, cta)}px)`,
        }}
      >
        {scene.cta}
      </h2>
      <div style={{ height: px(6), width: px(96) * bar, background: theme.accent, borderRadius: px(3), marginTop: sp(5) }} />
      <div
        style={{
          marginTop: sp(5),
          alignSelf: "flex-start",
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
          opacity: url,
          transform: `translateY(${lerp(px(24), 0, url)}px)`,
        }}
      >
        {scene.url}
        <svg width={px(36)} height={px(36)} viewBox="0 0 24 24" fill="none" stroke={theme.accentText} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </div>
    </div>
  );
};
