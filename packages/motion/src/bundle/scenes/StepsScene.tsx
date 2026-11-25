import type { StepsScene as D } from "../../schema/storyboard.ts";
import type { StepsTiming } from "../../timeline.ts";
import { contentBox, glowShadow, headingHeight, inkOn, SceneHeading } from "../components/b-common.tsx";
import { useStage } from "../context.tsx";
import { radius } from "../../theme/tokens.ts";
import { easeInOut, lerp, progress } from "../motion.ts";

const Check: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

export const StepsScene: React.FC<{ scene: D; timing: StepsTiming; t: number }> = ({ scene, timing, t }) => {
  const { layout, theme } = useStage();
  const { px, sp } = layout;
  const n = scene.items.length;
  const ink = inkOn(theme);
  const horizontal = (scene.layout ?? "horizontal") === "horizontal";
  const active = timing.activeAt.reduce((acc, at, i) => (t >= at ? i : acc), -1);
  // rail fill measured in steps: 0 at the first node, n-1 at the last
  const fillIdx = active <= 0 ? 0 : active - 1 + progress(t, timing.activeAt[active] ?? 0, 26, easeInOut);
  const circle = horizontal ? px(n <= 3 ? 88 : 76) : px(n <= 4 ? 72 : 64);

  const Node: React.FC<{ i: number }> = ({ i }) => {
    const done = active > i;
    const isActive = active === i;
    const pop = progress(t, (timing.activeAt[i] ?? 0) - 16, 18);
    const ring = isActive ? progress(t, timing.activeAt[i] ?? 0, 18) : 0;
    return (
      <div
        style={{
          width: circle,
          height: circle,
          borderRadius: "50%",
          flex: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "inherit",
          fontSize: circle * 0.42,
          fontWeight: 700,
          fontVariantNumeric: "tabular-nums",
          background: done || isActive ? theme.gradient : theme.card,
          color: done || isActive ? ink : theme.mutedForeground,
          border: done || isActive ? `${px(3)}px solid transparent` : `${px(3)}px solid ${theme.border}`,
          opacity: pop,
          transform: `scale(${lerp(0.6, 1, pop) * (isActive ? lerp(1, 1.08, ring) : 1)})`,
          boxShadow: isActive ? `0 0 0 ${px(8 * ring)}px ${theme.accentWash}${theme.glow ? `, 0 0 ${px(36)}px ${theme.glow}` : ""}` : undefined,
        }}
      >
        {done ? <Check size={circle * 0.5} color={ink} /> : i + 1}
      </div>
    );
  };

  if (horizontal) {
    const colW = layout.content.width / n;
    const titleSize = n <= 3 ? 44 : n === 4 ? 38 : 34;
    const detailSize = n <= 3 ? 32 : 28;
    const railY = circle / 2;
    const x0 = colW / 2;
    const span = (n - 1) * colW;
    return (
      <div style={{ ...contentBox(layout), display: "flex", flexDirection: "column", justifyContent: "center", paddingBottom: sp(4) }}>
        {scene.heading !== undefined && <SceneHeading text={scene.heading} t={t} at={timing.headingAt} />}
        <div style={{ position: "relative", marginTop: headingHeight(scene.heading, px, sp) > 0 ? sp(4) : 0 }}>
          <div style={{ position: "absolute", left: x0, top: railY - px(3), width: span, height: px(6), borderRadius: px(3), background: theme.border }} />
          <div style={{ position: "absolute", left: x0, top: railY - px(3), width: span * (fillIdx / Math.max(1, n - 1)), height: px(6), borderRadius: px(3), background: theme.gradient }} />
          <div style={{ display: "flex" }}>
            {scene.items.map((it, i) => {
              const show = progress(t, (timing.activeAt[i] ?? 0) - 10, 22);
              const isActive = active === i;
              return (
                <div key={i} style={{ width: colW, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: `0 ${sp(2)}px` }}>
                  <Node i={i} />
                  <div
                    style={{
                      marginTop: sp(4),
                      fontSize: px(titleSize),
                      lineHeight: 1.18,
                      fontWeight: 600,
                      letterSpacing: "-0.02em",
                      color: isActive || active > i ? theme.foreground : theme.mutedForeground,
                      opacity: show,
                      transform: `translateY(${lerp(px(20), 0, show)}px)`,
                      textWrap: "balance",
                      textShadow: isActive ? glowShadow(theme, px(18)) : undefined,
                    }}
                  >
                    {it.title}
                  </div>
                  {it.detail !== undefined && (
                    <div style={{ marginTop: sp(1.5), fontSize: px(detailSize), lineHeight: 1.35, color: isActive ? theme.foreground : theme.mutedForeground, opacity: show * (isActive ? 1 : 0.9), textWrap: "pretty" }}>{it.detail}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // vertical list
  const rowH = (layout.content.height - headingHeight(scene.heading, px, sp) - sp(4)) / n;
  const titleSize = n <= 4 ? 44 : 38;
  const detailSize = n <= 4 ? 32 : 28;
  const railX = circle / 2;
  const total = (n - 1) * rowH;
  return (
    <div style={{ ...contentBox(layout), display: "flex", flexDirection: "column", justifyContent: "center", paddingBottom: sp(2) }}>
      {scene.heading !== undefined && <SceneHeading text={scene.heading} t={t} at={timing.headingAt} />}
      <div style={{ position: "relative" }}>
        <div style={{ position: "absolute", left: railX - px(3), top: rowH / 2, width: px(6), height: total, borderRadius: px(3), background: theme.border }} />
        <div style={{ position: "absolute", left: railX - px(3), top: rowH / 2, width: px(6), height: total * (fillIdx / Math.max(1, n - 1)), borderRadius: px(3), background: theme.gradient }} />
        {scene.items.map((it, i) => {
          const show = progress(t, (timing.activeAt[i] ?? 0) - 10, 22);
          const isActive = active === i;
          return (
            <div key={i} style={{ height: rowH, display: "flex", alignItems: "center", gap: sp(4), position: "relative" }}>
              <Node i={i} />
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  boxSizing: "border-box",
                  padding: `${sp(1.25)}px ${sp(3)}px`,
                  borderRadius: radius("lg", sp(4)),
                  border: `${px(2)}px solid ${isActive ? theme.accent : theme.border}`,
                  background: isActive ? theme.accentWash : theme.card,
                  opacity: show,
                  transform: `translateX(${lerp(px(24), 0, show)}px)`,
                  boxShadow: isActive && theme.glow ? `0 0 ${px(30)}px ${theme.glow}` : undefined,
                }}
              >
                <div style={{ fontSize: px(titleSize), lineHeight: 1.18, fontWeight: 600, letterSpacing: "-0.02em", color: isActive || active > i ? theme.foreground : theme.mutedForeground, textShadow: isActive ? glowShadow(theme, px(18)) : undefined }}>{it.title}</div>
                {it.detail !== undefined && <div style={{ marginTop: sp(0.25), fontSize: px(detailSize), lineHeight: 1.3, color: isActive ? theme.foreground : theme.mutedForeground }}>{it.detail}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
