import { fitRows } from "../../fit.ts";
import type { BulletsScene as BulletsSceneData } from "../../schema/storyboard.ts";
import type { BulletsTiming } from "../../timeline.ts";
import { FONT_STACK, radius } from "../../theme/tokens.ts";
import { useStage } from "../context.tsx";
import { lerp, progress } from "../motion.ts";
import { glowShadow, inkOn, PanelMotif } from "./b-common.tsx";

interface Props {
  scene: BulletsSceneData;
  timing: BulletsTiming;
  t: number;
}

const SIZES = [60, 56, 52, 48, 44, 40, 36, 32, 28];

const Row: React.FC<Props & { i: number; width: number; size: number; center: boolean; indexW: number }> = ({ scene, timing, t, i, width, size, center, indexW }) => {
  const { layout, theme } = useStage();
  const { px, sp } = layout;
  const at = timing.itemAt[i] ?? 0;
  const p = progress(t, at, 20);
  const line = progress(t, at, 26);
  const lastShown = timing.itemAt.reduce((acc, a, k) => (t >= a ? k : acc), -1);
  const next = timing.itemAt[i + 1];
  const cooled = next === undefined ? 0 : progress(t, next - 4, 14);
  const active = i === lastShown ? 1 : lastShown > i ? 1 - cooled : 0;
  return (
    <div style={{ position: "relative", width, display: "flex", alignItems: "baseline", justifyContent: center ? "center" : "flex-start", gap: center ? sp(3) : 0, padding: `${sp(3.5)}px 0`, opacity: p, transform: `translateY(${lerp(px(28), 0, p)}px)` }}>
      <div style={{ position: "absolute", left: 0, top: 0, height: px(2), width: "100%", background: theme.border, transformOrigin: center ? "center" : "left", transform: `scaleX(${line})` }} />
      <span style={{ width: center ? undefined : indexW, flex: "none", fontFamily: FONT_STACK.mono, fontSize: px(28), color: active > 0.5 ? theme.accentText : theme.mutedForeground, fontVariantNumeric: "tabular-nums" }}>{String(i + 1).padStart(2, "0")}</span>
      <span style={{ fontSize: px(size), lineHeight: 1.25, fontWeight: 500, letterSpacing: "-0.01em", color: theme.foreground, textAlign: center ? "center" : "left", textShadow: active > 0.5 ? glowShadow(theme, px(18)) : undefined }}>{scene.items[i]}</span>
    </div>
  );
};

export const BulletsCentered: React.FC<Props> = (props) => {
  const { layout, theme } = useStage();
  const { px, sp } = layout;
  const { scene, timing, t } = props;
  const headingSize = scene.heading.length <= 34 ? 72 : 56;
  const head = progress(t, timing.headingAt, 22);
  const colW = Math.min(layout.content.width, px(1360));
  const size = fitRows({
    texts: scene.items,
    width: (colW - sp(10)) / layout.unit,
    height: (layout.content.height - px(headingSize) * 1.15 - sp(7)) / layout.unit,
    sizes: SIZES,
    lineHeight: 1.25,
    rowPadding: () => 2 * 28 + 2,
  });
  return (
    <div style={{ position: "absolute", left: layout.content.x, top: layout.content.y, width: layout.content.width, height: layout.content.height, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      <h2 style={{ margin: 0, marginBottom: sp(4), maxWidth: colW, textAlign: "center", fontSize: px(headingSize), lineHeight: 1.15, fontWeight: 600, letterSpacing: "-0.03em", color: theme.foreground, opacity: head, transform: `translateY(${lerp(px(24), 0, head)}px)`, textWrap: "balance", textShadow: glowShadow(theme, px(24)) }}>
        {scene.heading}
      </h2>
      <div style={{ width: px(88) * head, height: px(5), borderRadius: px(3), background: theme.gradient, marginBottom: sp(2) }} />
      <div>
        {scene.items.map((_, i) => (
          <Row key={i} {...props} i={i} width={colW} size={size} center indexW={0} />
        ))}
      </div>
    </div>
  );
};

export const BulletsSplit: React.FC<Props> = (props) => {
  const { layout, theme } = useStage();
  const { px, sp } = layout;
  const { scene, timing, t } = props;
  const c = layout.content;
  const panelW = Math.round(c.width * 0.38);
  const gap = sp(7);
  const listW = c.width - panelW - gap;
  const ink = inkOn(theme);
  const panel = progress(t, 0, 28);
  const head = progress(t, timing.headingAt, 24);
  const hSize = scene.heading.length <= 24 ? 72 : scene.heading.length <= 40 ? 60 : 52;
  const indexW = sp(10);
  const size = fitRows({
    texts: scene.items,
    width: (listW - indexW) / layout.unit,
    height: c.height / layout.unit,
    sizes: SIZES,
    lineHeight: 1.25,
    rowPadding: () => 2 * 28 + 2,
  });
  return (
    <div style={{ position: "absolute", left: c.x, top: c.y, width: c.width, height: c.height }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: panelW, height: c.height, borderRadius: radius("lg", sp(4)), background: theme.gradient, overflow: "hidden", clipPath: `inset(0 ${(1 - panel) * 100}% 0 0)`, boxShadow: theme.glow ? `0 0 ${px(60)}px ${theme.glow}` : undefined }}>
        <PanelMotif width={panelW} height={c.height} ink={ink} t={t} />
        <div style={{ position: "absolute", left: sp(5), right: sp(5), bottom: sp(6), color: ink, opacity: head, transform: `translateY(${lerp(px(24), 0, head)}px)` }}>
          <div style={{ width: px(72), height: px(6), borderRadius: px(3), background: ink, marginBottom: sp(3) }} />
          <h2 style={{ margin: 0, fontSize: px(hSize), lineHeight: 1.08, fontWeight: 700, letterSpacing: "-0.03em", textWrap: "balance" }}>{scene.heading}</h2>
        </div>
      </div>
      <div style={{ position: "absolute", left: panelW + gap, top: 0, width: listW, height: c.height, display: "flex", flexDirection: "column", justifyContent: "center" }}>
        {scene.items.map((_, i) => (
          <Row key={i} {...props} i={i} width={listW} size={size} center={false} indexW={indexW} />
        ))}
      </div>
    </div>
  );
};
