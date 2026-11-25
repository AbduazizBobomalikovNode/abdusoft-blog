import { fitRows } from "../../fit.ts";
import type { BulletsScene as BulletsSceneData } from "../../schema/storyboard.ts";
import type { BulletsTiming } from "../../timeline.ts";
import { FONT_STACK } from "../../theme/tokens.ts";
import { useStage } from "../context.tsx";
import { lerp, progress } from "../motion.ts";

export const BulletsScene: React.FC<{ scene: BulletsSceneData; timing: BulletsTiming; t: number }> = ({ scene, timing, t }) => {
  const { layout, theme } = useStage();
  const { px, sp } = layout;
  const headingSize = scene.heading.length <= 34 ? 72 : 56;
  const head = progress(t, timing.headingAt, 22);
  const indexW = sp(12);
  const textW = layout.content.width - indexW;
  const headingBlock = px(headingSize) * 1.15 + sp(5);
  const size = fitRows({
    texts: scene.items,
    width: textW / layout.unit,
    height: (layout.content.height - headingBlock - sp(2)) / layout.unit,
    sizes: [60, 56, 52, 48, 44, 40, 36, 32, 28],
    lineHeight: 1.25,
    rowPadding: () => 2 * 28 + 2,
  });
  const lastShown = timing.itemAt.reduce((acc, at, i) => (t >= at ? i : acc), -1);

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
      }}
    >
      <h2
        style={{
          margin: 0,
          marginBottom: sp(5),
          fontSize: px(headingSize),
          lineHeight: 1.15,
          fontWeight: 600,
          letterSpacing: "-0.03em",
          color: theme.foreground,
          opacity: head,
          transform: `translateY(${lerp(px(24), 0, head)}px)`,
          textWrap: "balance",
        }}
      >
        {scene.heading}
      </h2>
      <div>
        {scene.items.map((item, i) => {
          const at = timing.itemAt[i] ?? 0;
          const p = progress(t, at, 20);
          const line = progress(t, at, 26);
          const isNewest = i === lastShown;
          const next = timing.itemAt[i + 1];
          const cooled = next === undefined ? 0 : progress(t, next - 4, 14);
          const active = isNewest ? 1 : lastShown > i ? 1 - cooled : 0;
          return (
            <div
              key={i}
              style={{
                position: "relative",
                display: "flex",
                alignItems: "baseline",
                padding: `${sp(3.5)}px 0`,
                opacity: p,
                transform: `translateY(${lerp(px(28), 0, p)}px)`,
              }}
            >
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  height: px(2),
                  width: "100%",
                  background: theme.border,
                  transformOrigin: "left",
                  transform: `scaleX(${line})`,
                }}
              />
              <span
                style={{
                  width: indexW,
                  flex: "none",
                  fontFamily: FONT_STACK.mono,
                  fontSize: px(28),
                  color: active > 0.5 ? theme.accentText : theme.mutedForeground,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {String(i + 1).padStart(2, "0")}
              </span>
              <span style={{ fontSize: px(size), lineHeight: 1.25, fontWeight: 500, letterSpacing: "-0.01em", color: theme.foreground }}>{item}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
