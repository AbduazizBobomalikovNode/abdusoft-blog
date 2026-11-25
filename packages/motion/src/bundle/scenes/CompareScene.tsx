import { estimateLines } from "../../fit.ts";
import type { CompareScene as D } from "../../schema/storyboard.ts";
import type { CompareTiming } from "../../timeline.ts";
import { cardRadius, contentBox, glowShadow, headingHeight, inkOn, SceneHeading } from "../components/b-common.tsx";
import { useStage } from "../context.tsx";
import { lerp, progress } from "../motion.ts";

const Icon: React.FC<{ kind: "check" | "dash"; color: string; size: number }> = ({ kind, color, size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: "none" }}>
    {kind === "check" ? <path d="M5 12.5l4.5 4.5L19 7.5" /> : <path d="M6 12h12" />}
  </svg>
);

export const CompareScene: React.FC<{ scene: D; timing: CompareTiming; t: number }> = ({ scene, timing, t }) => {
  const { layout, theme } = useStage();
  const { px, sp } = layout;
  const gap = sp(9);
  const colW = (layout.content.width - gap) / 2;
  const padX = sp(4);
  const titleH = sp(9);
  const verdictH = scene.verdict ? sp(11) : 0;
  const maxBodyH = layout.content.height - headingHeight(scene.heading, px, sp) - verdictH - titleH - sp(6);
  // Fit: the largest size (then the roomier row padding) at which both columns fit the available body height.
  const textW = (colW - 2 * padX - px(56)) / layout.unit;
  const colHeight = (items: string[], size: number, rowPad: number): number => items.reduce((a, it) => a + estimateLines(it.length, size, textW, 0.56) * size * 1.25 * layout.unit + 2 * rowPad, 0);
  let fs = 28;
  let rowPad = sp(1);
  search: for (const pad of [sp(1.5), sp(1)]) {
    for (const size of [40, 36, 34, 32, 30, 28]) {
      if (Math.max(colHeight(scene.left.items, size, pad), colHeight(scene.right.items, size, pad)) + 2 * sp(2) <= maxBodyH) {
        fs = size;
        rowPad = pad;
        break search;
      }
    }
  }
  const bodyH = Math.min(maxBodyH, Math.max(colHeight(scene.left.items, fs, rowPad), colHeight(scene.right.items, fs, rowPad)) + 2 * sp(2) + sp(1));
  const ink = inkOn(theme);
  const vs = progress(t, timing.rightTitleAt, 24);
  const verdict = progress(t, timing.verdictAt, 24);

  const Column: React.FC<{ side: "left" | "right" }> = ({ side }) => {
    const data = side === "left" ? scene.left : scene.right;
    const titleAt = side === "left" ? timing.leftTitleAt : timing.rightTitleAt;
    const itemAt = side === "left" ? timing.leftItemAt : timing.rightItemAt;
    const accented = side === "right";
    const enter = progress(t, titleAt, 24);
    return (
      <div
        style={{
          width: colW,
          borderRadius: cardRadius(sp),
          border: `${px(accented ? 3 : 2)}px solid ${accented ? theme.accent : theme.border}`,
          background: accented ? `linear-gradient(180deg, ${theme.accentWash}, ${theme.card} 70%)` : theme.card,
          opacity: enter,
          transform: `translateX(${lerp(side === "left" ? -px(40) : px(40), 0, enter)}px)`,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: accented && theme.glow ? `0 0 ${px(40)}px ${theme.glow}` : theme.mode === "light" ? `0 ${px(8)}px ${px(40)}px rgba(0,0,0,0.06)` : undefined,
        }}
      >
        <div
          style={{
            height: titleH,
            display: "flex",
            alignItems: "center",
            gap: sp(2),
            padding: `0 ${padX}px`,
            fontSize: px(40),
            fontWeight: 600,
            letterSpacing: "-0.02em",
            color: accented ? theme.accentText : theme.mutedForeground,
            borderBottom: `${px(2)}px solid ${accented ? theme.accent : theme.border}`,
            whiteSpace: "nowrap",
            overflow: "hidden",
          }}
        >
          <span style={{ width: px(14), height: px(14), borderRadius: px(4), background: accented ? theme.accent : theme.mutedForeground, flex: "none" }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{data.title}</span>
        </div>
        <div style={{ height: bodyH, padding: `${sp(2)}px ${padX}px`, display: "flex", flexDirection: "column", justifyContent: "flex-start" }}>
          {data.items.map((item, i) => {
            const p = progress(t, itemAt[i] ?? 0, 20);
            return (
              <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: sp(2), padding: `${rowPad}px 0`, opacity: p, transform: `translateY(${lerp(px(20), 0, p)}px)` }}>
                <div style={{ marginTop: px(fs * 0.12) }}>
                  <Icon kind={accented ? "check" : "dash"} color={accented ? theme.accentText : theme.mutedForeground} size={px(fs * 0.95)} />
                </div>
                <span style={{ fontSize: px(fs), lineHeight: 1.25, fontWeight: 500, color: accented ? theme.foreground : theme.mutedForeground, textWrap: "pretty" }}>{item}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const badge = px(96);
  return (
    <div style={{ ...contentBox(layout), display: "flex", flexDirection: "column", justifyContent: "center" }}>
      {scene.heading !== undefined && <SceneHeading text={scene.heading} t={t} at={timing.headingAt} />}
      <div style={{ position: "relative", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <Column side="left" />
        <Column side="right" />
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: (titleH + bodyH) / 2 - badge / 2 + px(10),
            width: badge,
            height: badge,
            marginLeft: -badge / 2,
            borderRadius: "50%",
            background: theme.gradient,
            color: ink,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 700,
            fontSize: px(36),
            letterSpacing: "0.04em",
            opacity: vs,
            transform: `scale(${lerp(0.5, 1, vs)})`,
            boxShadow: `0 0 0 ${px(10)}px ${theme.background}, 0 ${px(8)}px ${px(30)}px rgba(0,0,0,0.25)`,
          }}
        >
          {scene.mode === "beforeAfter" ? (
            <svg width={px(48)} height={px(48)} viewBox="0 0 24 24" fill="none" stroke={ink} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          ) : (
            "VS"
          )}
        </div>
      </div>
      {scene.verdict !== undefined && (
        <div
          style={{
            marginTop: sp(4),
            height: verdictH - sp(4),
            display: "flex",
            alignItems: "center",
            gap: sp(3),
            padding: `0 ${padX}px`,
            borderRadius: cardRadius(sp),
            background: theme.muted,
            borderLeft: `${px(8)}px solid ${theme.accent}`,
            fontSize: px(36),
            fontWeight: 600,
            color: theme.foreground,
            opacity: verdict,
            transform: `translateY(${lerp(px(20), 0, verdict)}px)`,
            textShadow: glowShadow(theme, px(18)),
          }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{scene.verdict}</span>
        </div>
      )}
    </div>
  );
};
