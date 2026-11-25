import { fitTitle } from "../../fit.ts";
import type { TitleScene as TitleSceneData } from "../../schema/storyboard.ts";
import type { TitleTiming } from "../../timeline.ts";
import { OG_CARD, PROSE, radius } from "../../theme/tokens.ts";
import { useStage } from "../context.tsx";
import { lerp, progress } from "../motion.ts";
import { glowShadow, inkOn, PanelMotif, pillBorder } from "./b-common.tsx";

interface Props {
  scene: TitleSceneData;
  timing: TitleTiming;
  t: number;
}

/** Title block (kicker, words, subtitle, tags) with a text alignment; shared by centered and split. */
const Body: React.FC<Props & { align: "left" | "center"; width: number; kickerInline: boolean }> = ({ scene, timing, t, align, width, kickerInline }) => {
  const { layout, theme } = useStage();
  const { px, sp } = layout;
  const size = fitTitle(scene.title.length, width / layout.unit);
  const words = scene.title.split(/\s+/);
  const kicker = progress(t, timing.kickerAt, 20);
  const sub = progress(t, timing.subtitleAt, 22);
  const center = align === "center";
  return (
    <div style={{ width, display: "flex", flexDirection: "column", alignItems: center ? "center" : "flex-start", textAlign: align }}>
      {kickerInline && scene.kicker !== undefined && (
        <div style={{ display: "flex", alignItems: "center", gap: sp(2), marginBottom: sp(4), opacity: kicker, transform: `translateY(${lerp(px(16), 0, kicker)}px)`, color: theme.accentText, fontSize: px(28), fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase" }}>
          <span style={{ width: px(12), height: px(12), borderRadius: px(3), background: theme.accent, display: "block" }} />
          {scene.kicker}
        </div>
      )}
      <h1
        style={{
          margin: 0,
          maxWidth: width,
          fontSize: px(size),
          lineHeight: size >= 96 ? 1.04 : 1.1,
          fontWeight: OG_CARD.titleWeight,
          letterSpacing: size >= 96 ? "-0.035em" : "-0.025em",
          textWrap: "balance",
          color: theme.foreground,
          textShadow: glowShadow(theme, px(30)),
        }}
      >
        {words.map((w, i) => {
          const p = progress(t, timing.titleAt + i * timing.wordStep, 22);
          return (
            <span key={i} style={{ display: "inline-block", opacity: p, transform: `translateY(${lerp(px(40), 0, p)}px)`, marginRight: i < words.length - 1 ? "0.26em" : 0 }}>
              {w}
            </span>
          );
        })}
      </h1>
      {scene.subtitle !== undefined && (
        <p style={{ margin: 0, marginTop: sp(4), maxWidth: Math.min(width, px(1240)), fontSize: px(center ? 40 : 36), lineHeight: PROSE.bodyLineHeight, color: theme.mutedForeground, opacity: sub, transform: `translateY(${lerp(px(20), 0, sub)}px)`, textWrap: "pretty" }}>
          {scene.subtitle}
        </p>
      )}
      {scene.tags !== undefined && scene.tags.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: sp(2), marginTop: sp(5), justifyContent: center ? "center" : "flex-start" }}>
          {scene.tags.map((tag, i) => {
            const p = progress(t, timing.tagAt[i] ?? 0, 18);
            return (
              <span key={i} style={{ fontSize: px(28), padding: `${sp(1)}px ${sp(3)}px`, borderRadius: 999, border: `${px(2)}px solid ${pillBorder(theme)}`, color: theme.foreground, opacity: p * OG_CARD.tagOpacity, transform: `translateY(${lerp(px(16), 0, p)}px)`, lineHeight: 1.3 }}>
                {tag}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
};

export const TitleCentered: React.FC<Props> = (props) => {
  const { layout, theme } = useStage();
  const { px, sp } = layout;
  const { scene, timing, t } = props;
  const width = Math.min(layout.content.width, px(1400));
  const kicker = progress(t, timing.kickerAt, 20);
  return (
    <div style={{ position: "absolute", left: layout.content.x, top: layout.content.y, width: layout.content.width, height: layout.content.height, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", paddingBottom: sp(4) }}>
      {scene.kicker !== undefined && (
        <div style={{ display: "flex", alignItems: "center", gap: sp(2), marginBottom: sp(4), opacity: kicker, transform: `translateY(${lerp(px(16), 0, kicker)}px)`, color: theme.accentText, fontSize: px(28), fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase" }}>
          <span style={{ width: px(40) * kicker, height: px(3), background: theme.gradient, display: "block" }} />
          {scene.kicker}
          <span style={{ width: px(40) * kicker, height: px(3), background: theme.gradient, display: "block" }} />
        </div>
      )}
      <Body {...props} align="center" width={width} kickerInline={false} />
    </div>
  );
};

export const TitleSplit: React.FC<Props> = (props) => {
  const { layout, theme } = useStage();
  const { px, sp } = layout;
  const { scene, timing, t } = props;
  const c = layout.content;
  const panelW = Math.round(c.width * 0.4);
  const gap = sp(7);
  const bodyW = c.width - panelW - gap;
  const ink = inkOn(theme);
  const panel = progress(t, 0, 30);
  const kicker = progress(t, timing.kickerAt, 22);
  const kSize = (scene.kicker?.length ?? 0) > 18 ? 56 : 72;
  return (
    <div style={{ position: "absolute", left: c.x, top: c.y, width: c.width, height: c.height }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: panelW,
          height: c.height,
          borderRadius: radius("lg", sp(4)),
          background: theme.gradient,
          overflow: "hidden",
          clipPath: `inset(0 ${(1 - panel) * 100}% 0 0)`,
          boxShadow: theme.glow ? `0 0 ${px(60)}px ${theme.glow}` : undefined,
        }}
      >
        <PanelMotif width={panelW} height={c.height} ink={ink} t={t} />
        <div style={{ position: "absolute", left: sp(5), right: sp(5), bottom: sp(6), color: ink, opacity: kicker, transform: `translateY(${lerp(px(24), 0, kicker)}px)` }}>
          <div style={{ width: px(72), height: px(6), borderRadius: px(3), background: ink, marginBottom: sp(3) }} />
          <div style={{ fontSize: px(kSize), fontWeight: 700, lineHeight: 1.05, letterSpacing: "-0.03em", textTransform: "uppercase", textWrap: "balance" }}>{scene.kicker ?? ""}</div>
        </div>
      </div>
      <div style={{ position: "absolute", left: panelW + gap, top: 0, width: bodyW, height: c.height, display: "flex", alignItems: "center" }}>
        <Body {...props} align="left" width={bodyW} kickerInline={false} />
      </div>
    </div>
  );
};
