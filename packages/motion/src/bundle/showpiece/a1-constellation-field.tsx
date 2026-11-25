import { hash01 } from "../../timing.ts";
import { useStage } from "../context.tsx";
import { progress } from "../motion.ts";
import { mixed, periodic, periodicCos, TAU } from "./a1-common.tsx";

/**
 * Deterministic constellation: ~64 linked points spiral in from far away and settle on an elliptical
 * frame around the title, plus ~30 unlinked background stars. Everything is a pure function of the frame
 * (seeded hash01); after the points settle the only motion is a tiny orbit/twinkle with period
 * LOOP_FRAMES, so the closing hold loops seamlessly.
 */
interface Pt {
  /** Target as polar coordinates on the frame (radius fraction of the ellipse, angle). */
  rr: number;
  ang: number;
  /** Start offset: radius multiplier and angle shift. */
  r0: number;
  a0: number;
  delay: number;
  size: number;
  tone: 0 | 1 | 2;
  halo: boolean;
  phase: number;
}
interface Star {
  x: number;
  y: number;
  size: number;
  phase: number;
  cycles: number;
}

const RING = 46;
const INNER = 26;
const STARS = 30;
const h = (i: number, k: number): number => hash01(i * 131 + k * 7919 + 17);

function buildPoints(): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < RING + INNER; i++) {
    const ring = i < RING;
    // inner points keep to the top and bottom sectors so none lands at the ends of the title line
    const ang = ring ? (TAU * (i + (h(i, 1) - 0.5) * 0.7)) / RING : (i % 2 === 0 ? -1 : 1) * Math.PI * (0.2 + 0.6 * h(i, 1));
    pts.push({
      rr: ring ? 0.94 + h(i, 2) * 0.12 : 0.5 + h(i, 2) * 0.4,
      ang,
      r0: 1.3 + h(i, 3) * 0.9,
      a0: (h(i, 4) - 0.5) * 2.6,
      delay: h(i, 5) * 22,
      size: i < RING && i % 9 === 4 ? 9 + h(i, 6) * 3 : 3.5 + h(i, 6) * 4.5,
      tone: h(i, 7) < 0.55 ? 0 : h(i, 7) < 0.85 ? 1 : 2,
      halo: h(i, 8) < 0.4 || (i < RING && i % 9 === 4),
      phase: h(i, 9) * TAU,
    });
  }
  return pts;
}
const POINTS = buildPoints();
const STAR_LIST: Star[] = Array.from({ length: STARS }, (_v, i) => ({ x: h(i + 200, 1), y: h(i + 200, 2), size: 1.6 + h(i + 200, 3) * 2.4, phase: h(i + 200, 4) * TAU, cycles: 1 + Math.floor(h(i + 200, 5) * 2) }));

/** Links between each point and its two nearest neighbours (by target position), computed once. */
function buildLinks(pts: Pt[]): Array<[number, number]> {
  const pos = pts.map((p) => [p.rr * Math.cos(p.ang), p.rr * Math.sin(p.ang) * 0.5] as const);
  const seen = new Set<string>();
  const out: Array<[number, number]> = [];
  pos.forEach((a, i) => {
    const d = pos.map((b, j) => ({ j, d: j === i ? Infinity : Math.hypot(a[0] - b[0], a[1] - b[1]) })).sort((x, y) => x.d - y.d);
    for (const n of d.slice(0, 3)) {
      const key = i < n.j ? `${i}-${n.j}` : `${n.j}-${i}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(i < n.j ? [i, n.j] : [n.j, i]);
      }
    }
  });
  return out;
}
const LINKS = buildLinks(POINTS);

export const ConstellationField: React.FC<{ t: number }> = ({ t }) => {
  const { layout, theme } = useStage();
  const { width: W, height: H, content, px } = layout;
  const dark = theme.mode === "dark";
  const cx = W / 2;
  const cy = content.y + content.height / 2 - px(10);
  const rx = (content.width / 2) * 0.98;
  const ry = (content.height / 2) * 0.96;
  const clock = t + 28; // the first frame is already a mostly built figure
  const tone = [dark ? theme.accentText : theme.accent, dark ? theme.accent2Text : theme.accent2, dark ? theme.foreground : theme.foreground] as const;
  const state = POINTS.map((p, i) => {
    const e = progress(clock, p.delay, 52);
    const r = p.rr * (1 + (p.r0 - 1) * (1 - e));
    const a = p.ang + p.a0 * (1 - e);
    const orbit = px(5) * (0.4 + 0.6 * p.size / 8);
    const x = cx + rx * r * Math.cos(a) + orbit * periodic(t, 1, p.phase);
    const y = cy + ry * r * Math.sin(a) + orbit * periodicCos(t, 1, p.phase + i);
    return { x: Math.min(W - px(24), Math.max(px(24), x)), y: Math.min(H - px(24), Math.max(px(24), y)), e };
  });
  return (
    <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
      <defs>
        <radialGradient id="a1c-core" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={theme.accent} stopOpacity={dark ? 0.34 : 0.16} />
          <stop offset="100%" stopColor={theme.accent} stopOpacity={0} />
        </radialGradient>
      </defs>
      <ellipse cx={cx} cy={cy} rx={rx * 0.9} ry={ry * 0.8} fill="url(#a1c-core)" />
      {STAR_LIST.map((s, i) => (
        <circle key={`s${i}`} cx={s.x * W} cy={s.y * H} r={px(s.size)} fill={tone[0]} opacity={(0.25 + 0.3 * (0.5 + 0.5 * periodic(t, s.cycles, s.phase))) * (dark ? 1 : 0.8)} />
      ))}
      {LINKS.map(([i, j], k) => {
        const a = state[i];
        const b = state[j];
        if (!a || !b) return null;
        const e = Math.min(a.e, b.e) ** 2;
        if (e < 0.02) return null;
        const quiet = i >= RING || j >= RING ? 0.55 : 1; // lines through the text area stay faint
        return <line key={`l${k}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={tone[0]} strokeOpacity={e * quiet * (dark ? 0.62 : 0.5)} strokeWidth={px(2.4)} />;
      })}
      {POINTS.map((p, i) => {
        const s = state[i];
        if (!s) return null;
        const tw = 0.8 + 0.2 * periodic(t, 1 + (i % 2), p.phase);
        const r = px(p.size) * (0.7 + 0.3 * s.e);
        return (
          <g key={`p${i}`} opacity={tw * (i >= RING ? 0.6 : 1)}>
            {p.halo && <circle cx={s.x} cy={s.y} r={r * 3.4} fill={mixed(tone[p.tone], dark ? 22 : 14)} />}
            <circle cx={s.x} cy={s.y} r={r} fill={tone[p.tone]} />
          </g>
        );
      })}
    </svg>
  );
};
