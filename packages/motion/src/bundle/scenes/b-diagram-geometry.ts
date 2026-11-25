import { type DiagramLayout, layoutDiagram } from "../../diagram-layout.ts";
import { estimateLines } from "../../fit.ts";
import type { DiagramScene } from "../../schema/storyboard.ts";

/** Pure geometry of a diagram: node rectangles, edge polylines and label anchors, all in screen px of the diagram area. */
export interface NodeBox {
  id: string;
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface EdgeGeo {
  index: number;
  /** SVG path in area coordinates. */
  d: string;
  /** Arrow tip and unit direction (screen space). */
  tip: [number, number];
  dir: [number, number];
  label: [number, number];
  back: boolean;
}
export interface DiagramGeometry {
  lay: DiagramLayout;
  nodes: NodeBox[];
  edges: EdgeGeo[];
  labelSize: number;
  detailSize: number;
  /** Widest an edge label pill may get before it wraps (px). */
  labelMaxW: number;
}

type P = [number, number];

/** Polyline with rounded corners (radius r), as an SVG path. */
export function roundedPath(pts: readonly P[], r: number): string {
  if (pts.length < 2) return "";
  let d = `M${pts[0]![0].toFixed(1)} ${pts[0]![1].toFixed(1)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1] as P;
    const b = pts[i] as P;
    const c = pts[i + 1] as P;
    const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const p1: P = [b[0] + ((a[0] - b[0]) / l1) * rr, b[1] + ((a[1] - b[1]) / l1) * rr];
    const p2: P = [b[0] + ((c[0] - b[0]) / l2) * rr, b[1] + ((c[1] - b[1]) / l2) * rr];
    d += ` L${p1[0].toFixed(1)} ${p1[1].toFixed(1)} Q${b[0].toFixed(1)} ${b[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  const e = pts[pts.length - 1] as P;
  return `${d} L${e[0].toFixed(1)} ${e[1].toFixed(1)}`;
}

export function diagramGeometry(scene: DiagramScene, areaW: number, areaH: number, u: number): DiagramGeometry {
  const lay = layoutDiagram(scene.nodes, scene.edges);
  const lr = (scene.direction ?? "lr") === "lr";
  const L = lay.layers;
  const widest = lay.widest;
  const lanePad = 48 * u;
  const UL = lr ? areaW : areaH; // flow length
  const VL = lr ? areaH : areaW; // cross length
  const spacing = (VL - 2 * lanePad) / widest;

  const maxLabelW = Math.max(0, ...scene.edges.map((e) => (e.label ? e.label.length * 24 * u * 0.56 + 36 * u : 0)));
  let nu: number;
  let nv: number;
  let gap: number;
  if (lr) {
    gap = Math.min(240 * u, Math.max(110 * u, maxLabelW * 0.62 + 24 * u));
    nu = (UL - (L - 1) * gap) / L;
    if (nu > 330 * u) {
      nu = 330 * u;
      gap = (UL - L * nu) / (L - 1);
    }
    if (nu < 190 * u) {
      nu = 190 * u;
      gap = (UL - L * nu) / (L - 1);
    }
    nv = Math.min(150 * u, spacing * 0.84);
  } else {
    nu = Math.min(132 * u, (UL - (L - 1) * 72 * u) / L);
    gap = (UL - L * nu) / (L - 1);
    nv = Math.min(520 * u, spacing * 0.88);
  }
  const nodeW = lr ? nu : nv;
  const nodeH = lr ? nv : nu;

  // text sizes: the largest pair where every node's text fits its box
  const pad = 20 * u;
  const pairs: Array<[number, number]> = [
    [36, 28],
    [32, 26],
    [30, 26],
    [28, 24],
    [26, 22],
  ];
  const fits = (ls: number, ds: number): boolean =>
    scene.nodes.every((n) => {
      const innerW = nodeW - 2 * pad;
      const h = estimateLines(n.label.length, ls * u, innerW, 0.6) * ls * u * 1.18 + (n.detail ? estimateLines(n.detail.length, ds * u, innerW, 0.56) * ds * u * 1.3 + 6 * u : 0) + 2 * 14 * u;
      return h <= nodeH;
    });
  const [labelSize, detailSize] = pairs.find(([a, b]) => fits(a, b)) ?? (pairs.at(-1) as [number, number]);

  const toXY = (pu: number, pv: number): P => (lr ? [pu, pv] : [pv, pu]);
  const nodes: NodeBox[] = scene.nodes.map((n, index) => {
    const pl = lay.place[n.id] as { layer: number; slot: number; count: number };
    const cu = pl.layer * (nu + gap) + nu / 2;
    const cv = VL / 2 + (pl.slot - (pl.count - 1) / 2) * spacing;
    const [cx, cy] = toXY(cu, cv);
    return { id: n.id, index, x: cx - nodeW / 2, y: cy - nodeH / 2, w: nodeW, h: nodeH };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // uv helpers
  const cen = (n: NodeBox): P => (lr ? [n.x + n.w / 2, n.y + n.h / 2] : [n.y + n.h / 2, n.x + n.w / 2]);
  const halfU = nu / 2;
  const halfV = nv / 2;
  const radius = 18 * u;

  let backCount = 0;
  let spanCount = 0;
  const maxV = Math.max(...nodes.map((n) => cen(n)[1] + halfV));
  const edges: EdgeGeo[] = scene.edges.map((e, index) => {
    const a = byId.get(e.from) as NodeBox;
    const b = byId.get(e.to) as NodeBox;
    const [ua, va] = cen(a);
    const [ub, vb] = cen(b);
    const la = (lay.place[e.from] as { layer: number }).layer;
    const lb = (lay.place[e.to] as { layer: number }).layer;
    const back = lay.backEdges.includes(index);
    let pts: P[];
    let tipUV: P;
    let dirUV: P;
    let labelUV: P;
    let d: string;
    if (back) {
      const lane = Math.min(VL - 10 * u, maxV + 34 * u + backCount * 22 * u);
      backCount++;
      const uOffA = 0;
      pts = [toXY(ua + uOffA, va + halfV), toXY(ua + uOffA, lane), toXY(ub, lane), toXY(ub, vb + halfV + 6 * u)];
      tipUV = [ub, vb + halfV + 4 * u];
      dirUV = [0, -1];
      labelUV = [(ua + ub) / 2, lane];
      d = roundedPath(pts, radius);
    } else if (lb === la + 1) {
      const u1 = ua + halfU;
      const u2 = ub - halfU - 4 * u;
      tipUV = [u2, vb];
      dirUV = [1, 0];
      labelUV = [(u1 + u2) / 2, (va + vb) / 2];
      if (Math.abs(va - vb) < 1) d = roundedPath([toXY(u1, va), toXY(u2, vb)], 0);
      else {
        const m = (u2 - u1) / 2;
        const p1 = toXY(u1, va);
        const c1 = toXY(u1 + m, va);
        const c2 = toXY(u2 - m, vb);
        const p2 = toXY(u2, vb);
        d = `M${p1[0].toFixed(1)} ${p1[1].toFixed(1)} C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
      }
    } else {
      const mids = nodes.filter((n) => {
        const l = (lay.place[n.id] as { layer: number }).layer;
        return l > la && l < lb;
      });
      const top = Math.min(...mids.map((n) => cen(n)[1] - halfV)) - 30 * u;
      const bottom = Math.max(...mids.map((n) => cen(n)[1] + halfV)) + 30 * u;
      const mean = (va + vb) / 2;
      let lane = Math.abs(mean - top) <= Math.abs(mean - bottom) ? top - spanCount * 16 * u : bottom + spanCount * 16 * u;
      lane = Math.min(VL - 8 * u, Math.max(8 * u, lane));
      spanCount++;
      const u1 = ua + halfU;
      const u2 = ub - halfU - 4 * u;
      const g = gap / 2;
      pts = [toXY(u1, va), toXY(u1 + g, va), toXY(u1 + g, lane), toXY(u2 - g, lane), toXY(u2 - g, vb), toXY(u2, vb)];
      tipUV = [u2, vb];
      dirUV = [1, 0];
      labelUV = [(u1 + u2) / 2, lane];
      d = roundedPath(pts, radius);
    }
    const tip = toXY(tipUV[0], tipUV[1]);
    const dir = toXY(dirUV[0], dirUV[1]);
    return { index, d, tip, dir, label: toXY(labelUV[0], labelUV[1]), back };
  });
  return { lay, nodes, edges, labelSize, detailSize, labelMaxW: lr ? Math.max(90 * u, gap - 20 * u) : 280 * u };
}
