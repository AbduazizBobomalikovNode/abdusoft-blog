import type { CSSProperties } from "react";
import { fitTitle } from "../../fit.ts";
import type { TitleScene as TitleSceneData } from "../../schema/storyboard.ts";
import type { TitleTiming } from "../../timeline.ts";
import { OG_CARD, PROSE } from "../../theme/tokens.ts";
import { useStage } from "../context.tsx";
import { lerp, progress } from "../motion.ts";

export const TitleScene: React.FC<{ scene: TitleSceneData; timing: TitleTiming; t: number }> = ({ scene, timing, t }) => {
  const { layout, theme } = useStage();
  const { px, sp } = layout;
  const maxW = Math.min(layout.content.width, px(1440));
  const size = fitTitle(scene.title.length, maxW / layout.unit);
  const words = scene.title.split(/\s+/);

  const kicker = progress(t, timing.kickerAt, 20);
  const sub = progress(t, timing.subtitleAt, 22);

  const container: CSSProperties = {
    position: "absolute",
    left: layout.content.x,
    top: layout.content.y,
    width: layout.content.width,
    height: layout.content.height,
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    paddingBottom: sp(4), // optical centre sits above the geometric one
  };

  return (
    <div style={container}>
      {scene.kicker !== undefined && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: sp(2),
            marginBottom: sp(4),
            opacity: kicker,
            transform: `translateY(${lerp(px(16), 0, kicker)}px)`,
            color: theme.accentText,
            fontSize: px(28),
            fontWeight: 500,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
          }}
        >
          <span style={{ width: px(12), height: px(12), borderRadius: px(3), background: theme.accent, display: "block" }} />
          {scene.kicker}
        </div>
      )}
      <h1
        style={{
          margin: 0,
          maxWidth: maxW,
          fontSize: px(size),
          lineHeight: size >= 96 ? 1.04 : 1.1,
          fontWeight: OG_CARD.titleWeight,
          letterSpacing: size >= 96 ? "-0.035em" : "-0.025em",
          textWrap: "balance",
          color: theme.foreground,
        }}
      >
        {words.map((w, i) => {
          const p = progress(t, timing.titleAt + i * timing.wordStep, 22);
          return (
            <span
              key={i}
              style={{
                display: "inline-block",
                opacity: p,
                transform: `translateY(${lerp(px(40), 0, p)}px)`,
                marginRight: i < words.length - 1 ? "0.26em" : 0,
              }}
            >
              {w}
            </span>
          );
        })}
      </h1>
      {scene.subtitle !== undefined && (
        <p
          style={{
            margin: 0,
            marginTop: sp(4),
            maxWidth: px(1240),
            fontSize: px(40),
            lineHeight: PROSE.bodyLineHeight,
            color: theme.mutedForeground,
            opacity: sub,
            transform: `translateY(${lerp(px(20), 0, sub)}px)`,
            textWrap: "pretty",
          }}
        >
          {scene.subtitle}
        </p>
      )}
      {scene.tags !== undefined && scene.tags.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: sp(2), marginTop: sp(5) }}>
          {scene.tags.map((tag, i) => {
            const p = progress(t, timing.tagAt[i] ?? 0, 18);
            return (
              <span
                key={i}
                style={{
                  fontSize: px(28),
                  padding: `${sp(1)}px ${sp(3)}px`,
                  borderRadius: 999,
                  border: `${px(2)}px solid ${theme.mode === "dark" ? OG_CARD.tagBorder : theme.border}`,
                  color: theme.foreground,
                  opacity: p * OG_CARD.tagOpacity,
                  transform: `translateY(${lerp(px(16), 0, p)}px)`,
                  lineHeight: 1.3,
                }}
              >
                {tag}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
};
