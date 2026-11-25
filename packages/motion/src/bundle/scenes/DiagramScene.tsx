import { estimateLines } from "../../fit.ts";
import type { DiagramScene as D } from "../../schema/storyboard.ts";
import type { DiagramTiming } from "../../timeline.ts";
import { FONT_STACK, radius } from "../../theme/tokens.ts";
import { contentBox, glowShadow, headingHeight, SceneHeading } from "../components/b-common.tsx";
import { useStage } from "../context.tsx";
import { clamp01, easeInOut, lerp, progress } from "../motion.ts";
import { diagramGeometry } from "./b-diagram-geometry.ts";

const DIM = 0.38;

export const DiagramScene: React.FC<{ scene: D; timing: DiagramTiming; t: number }> = ({ scene, timing, t }) => {
  const { layout, theme } = useStage();
  const { px, sp, unit } = layout;
  const hasCaption = (scene.steps ?? []).some((s) => s.label !== undefined);
  const captionH = hasCaption ? sp(9) : 0;
  const head = headingHeight(scene.heading, px, sp);
  const areaW = layout.content.width;
  const areaH = layout.content.height - head - captionH - sp(2);
  const geo = diagramGeometry(scene, areaW, areaH, unit);

  // step highlighting: smooth blend from the previous step's lit set to the current one
  const steps = timing.steps;
  const k = steps.reduce((acc, s, i) => (t >= s.start ? i : acc), -1);
  const mixP = k >= 0 ? progress(t, (steps[k] as (typeof steps)[number]).start, 14, easeInOut) : 1;
  const litNode = (id: string, step: number): number => (step < 0 ? 1 : (steps[step] as (typeof steps)[number]).nodes.includes(id) ? 1 : 0);
  const nodeLit = (id: string): number => (k < 0 ? 1 : lerp(litNode(id, k - 1), litNode(id, k), mixP));
  const edgeLit = (from: string, to: string): number => (k < 0 ? 1 : lerp(litNode(from, k - 1) * litNode(to, k - 1), litNode(from, k) * litNode(to, k), mixP));
  const spot = (id: string): number => (k < 0 ? 0 : litNode(id, k) * mixP);

  const r = radius("lg", sp(4));
  const toneOf = (tone: string | undefined): { border: string; bg: string; fg: string; sub: string } => {
    switch (tone) {
      case "accent":
        return { border: theme.accent, bg: theme.accentWash, fg: theme.foreground, sub: theme.mutedForeground };
      case "muted":
        return { border: theme.border, bg: theme.muted, fg: theme.mutedForeground, sub: theme.mutedForeground };
      case "success":
        return { border: theme.tone.success, bg: `color-mix(in srgb, ${theme.tone.success} 14%, transparent)`, fg: theme.foreground, sub: theme.mutedForeground };
      case "error":
        return { border: theme.tone.error, bg: `color-mix(in srgb, ${theme.tone.error} 14%, transparent)`, fg: theme.foreground, sub: theme.mutedForeground };
      default:
        return { border: theme.border, bg: "transparent", fg: theme.foreground, sub: theme.mutedForeground };
    }
  };

  const arrow = (tip: [number, number], dir: [number, number], size: number): string => {
    const perp: [number, number] = [-dir[1], dir[0]];
    const bx = tip[0] - dir[0] * size;
    const by = tip[1] - dir[1] * size;
    return `M${tip[0].toFixed(1)} ${tip[1].toFixed(1)} L${(bx + perp[0] * size * 0.55).toFixed(1)} ${(by + perp[1] * size * 0.55).toFixed(1)} L${(bx - perp[0] * size * 0.55).toFixed(1)} ${(by - perp[1] * size * 0.55).toFixed(1)} Z`;
  };

  return (
    <div style={{ ...contentBox(layout), display: "flex", flexDirection: "column" }}>
      {scene.heading !== undefined && <SceneHeading text={scene.heading} t={t} at={timing.headingAt} />}
      <div style={{ position: "relative", width: areaW, height: areaH, marginTop: head > 0 ? sp(2) : sp(2) }}>
        <svg width={areaW} height={areaH} viewBox={`0 0 ${areaW} ${areaH}`} style={{ position: "absolute", inset: 0, overflow: "visible" }} aria-hidden="true">
          {geo.edges.map((e) => {
            const ed = scene.edges[e.index] as D["edges"][number];
            const p = progress(t, timing.edgeAt[e.index] ?? 0, timing.edgeFrames, easeInOut);
            if (p <= 0) return null;
            const lit = edgeLit(ed.from, ed.to);
            const on = k >= 0 && lit > 0.5;
            const color = on ? theme.accentText : theme.mutedForeground;
            const op = lerp(DIM, 1, lit);
            return (
              <g key={e.index} opacity={op}>
                <path d={e.d} pathLength={1} fill="none" stroke={color} strokeWidth={px(on ? 4 : 3)} strokeLinecap="round" strokeDasharray={1} strokeDashoffset={1 - p} style={theme.glow && on ? { filter: `drop-shadow(0 0 ${px(6)}px ${theme.glow})` } : undefined} />
                <path d={arrow(e.tip, e.dir, px(18))} fill={color} opacity={clamp01((p - 0.8) / 0.2)} />
              </g>
            );
          })}
        </svg>
        {geo.edges.map((e) => {
          const ed = scene.edges[e.index] as D["edges"][number];
          if (!ed.label) return null;
          const p = progress(t, (timing.edgeAt[e.index] ?? 0) + timing.edgeFrames * 0.5, 14);
          const op = lerp(DIM, 1, edgeLit(ed.from, ed.to)) * p;
          return (
            <span
              key={e.index}
              style={{
                position: "absolute",
                left: e.label[0],
                top: e.label[1],
                transform: "translate(-50%, -50%)",
                padding: `${px(5)}px ${px(14)}px`,
                borderRadius: 999,
                background: theme.background,
                border: `${px(2)}px solid ${theme.border}`,
                color: theme.mutedForeground,
                fontSize: px(24),
                lineHeight: 1.2,
                maxWidth: geo.labelMaxW,
                textAlign: "center",
                opacity: op,
              }}
            >
              {ed.label}
            </span>
          );
        })}
        {geo.nodes.map((nb) => {
          const n = scene.nodes[nb.index] as D["nodes"][number];
          const p = progress(t, timing.nodeAt[nb.index] ?? 0, 18);
          const tone = toneOf(n.tone);
          const hl = spot(n.id);
          const lit = nodeLit(n.id);
          const border = hl > 0.01 ? theme.accent : tone.border;
          // line budget so text can never spill out of the card (last resort: ellipsis)
          const innerW = nb.w - 2 * px(20);
          const avail = nb.h - 2 * px(14) - px(8);
          const ls = px(geo.labelSize);
          const ds = px(geo.detailSize);
          const wantL = estimateLines(n.label.length, ls, innerW, 0.6);
          const wantD = n.detail ? estimateLines(n.detail.length, ds, innerW, 0.56) : 0;
          const needL = wantL * ls * 1.18;
          const needD = wantD * ds * 1.3;
          const fitsAll = needL + needD <= avail;
          const maxL = fitsAll ? wantL : Math.max(1, Math.min(wantL, Math.floor((avail - (n.detail ? ds * 1.3 : 0)) / (ls * 1.18))));
          const maxD = n.detail ? (fitsAll ? wantD : Math.max(1, Math.floor((avail - maxL * ls * 1.18) / (ds * 1.3)))) : 0;
          const clamp = (lines: number): React.CSSProperties => ({ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: lines, overflow: "hidden" });
          return (
            <div
              key={nb.id}
              style={{
                position: "absolute",
                left: nb.x,
                top: nb.y,
                width: nb.w,
                height: nb.h,
                boxSizing: "border-box",
                borderRadius: r,
                border: `${px(hl > 0.5 ? 4 : 2)}px solid ${border}`,
                background: theme.card,
                backgroundImage: `linear-gradient(${tone.bg}, ${tone.bg})`,
                opacity: p * lerp(DIM, 1, lit),
                transform: `translateY(${lerp(px(18), 0, p)}px) scale(${lerp(0.94, 1, p) * (1 + 0.025 * hl)})`,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                textAlign: "center",
                padding: `${px(14)}px ${px(20)}px`,
                overflow: "hidden",
                boxShadow: hl > 0.5 ? `0 0 0 ${px(8)}px ${theme.accentWash}${theme.glow ? `, 0 0 ${px(36)}px ${theme.glow}` : ""}` : theme.mode === "light" ? `0 ${px(6)}px ${px(26)}px rgba(0,0,0,0.06)` : undefined,
              }}
            >
              <div style={{ fontSize: px(geo.labelSize), fontWeight: 600, lineHeight: 1.18, letterSpacing: "-0.01em", color: tone.fg, textWrap: "balance", textShadow: hl > 0.5 ? glowShadow(theme, px(16)) : undefined, ...clamp(maxL) }}>{n.label}</div>
              {n.detail !== undefined && <div style={{ marginTop: px(6), fontSize: px(geo.detailSize), lineHeight: 1.3, color: tone.sub, textWrap: "balance", ...clamp(maxD) }}>{n.detail}</div>}
            </div>
          );
        })}
      </div>
      {hasCaption && (
        <div style={{ position: "relative", height: captionH, flex: "none" }}>
          {steps.map((st, i) => {
            const label = scene.steps?.[i]?.label;
            if (label === undefined) return null;
            const inP = progress(t, st.start + 4, 12);
            const outP = progress(t, st.end - 10, 10);
            return (
              <div key={i} style={{ position: "absolute", left: 0, right: 0, top: sp(1.5), display: "flex", alignItems: "baseline", justifyContent: "center", gap: sp(2), fontSize: px(32), opacity: clamp01(inP) * (1 - outP), transform: `translateY(${lerp(px(8), 0, inP)}px)`, whiteSpace: "nowrap" }}>
                <span style={{ fontFamily: FONT_STACK.mono, fontSize: px(26), color: theme.accentText }}>{`${i + 1}/${steps.length}`}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", color: theme.foreground }}>{label}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
