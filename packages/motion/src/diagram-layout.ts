/**
 * Pure automatic layout of a `diagram` scene: layered (Sugiyama-lite) placement of a small directed
 * graph. Layers are columns for `lr` and rows for `tb`. Cycles are tolerated: an edge that points back
 * to an ancestor in the DFS is a "back edge", ignored for layering and drawn as a return arc.
 * Shared by the schema (limit checks), the timeline (reveal order) and the scene (positions).
 */
export interface DiagramNodeRef {
  id: string;
}
export interface DiagramEdgeRef {
  from: string;
  to: string;
}

export interface DiagramLayout {
  /** Number of layers (columns for lr, rows for tb). */
  layers: number;
  /** Widest layer (most nodes stacked). */
  widest: number;
  /** Per node id: layer, slot inside the layer (0-based) and the layer's node count. */
  place: Record<string, { layer: number; slot: number; count: number }>;
  /** Indexes of edges that point back to an ancestor (drawn as arcs, ignored for layering). */
  backEdges: number[];
  /** Node ids in reveal order (layer by layer, then slot). */
  order: string[];
}

export function layoutDiagram(nodes: readonly DiagramNodeRef[], edges: readonly DiagramEdgeRef[]): DiagramLayout {
  const ids = nodes.map((n) => n.id);
  const known = new Set(ids);
  const out = new Map<string, number[]>(ids.map((id) => [id, []]));
  edges.forEach((e, i) => {
    if (known.has(e.from) && known.has(e.to)) out.get(e.from)?.push(i);
  });

  // DFS from nodes without incoming edges (then from any unvisited node) to find back edges.
  const hasIn = new Set(edges.filter((e) => known.has(e.from) && known.has(e.to)).map((e) => e.to));
  const roots = [...ids.filter((id) => !hasIn.has(id)), ...ids.filter((id) => hasIn.has(id))];
  const state = new Map<string, 0 | 1 | 2>();
  const back = new Set<number>();
  const visit = (id: string): void => {
    state.set(id, 1);
    for (const ei of out.get(id) ?? []) {
      const to = (edges[ei] as DiagramEdgeRef).to;
      const s = state.get(to) ?? 0;
      if (s === 1) back.add(ei);
      else if (s === 0) visit(to);
    }
    state.set(id, 2);
  };
  for (const r of roots) if ((state.get(r) ?? 0) === 0) visit(r);

  // Longest-path layering over the forward edges (a DAG by construction).
  const layerOf = new Map<string, number>(ids.map((id) => [id, 0]));
  let changed = true;
  for (let guard = 0; changed && guard < ids.length + 2; guard++) {
    changed = false;
    edges.forEach((e, i) => {
      if (back.has(i) || !known.has(e.from) || !known.has(e.to)) return;
      const want = (layerOf.get(e.from) as number) + 1;
      if ((layerOf.get(e.to) as number) < want) {
        layerOf.set(e.to, want);
        changed = true;
      }
    });
  }
  const layers = ids.length === 0 ? 0 : Math.max(...layerOf.values()) + 1;

  // Slot order inside a layer: by the mean slot of the predecessors (keeps edges short), then declaration order.
  const slots = new Map<string, number>();
  const byLayer: string[][] = Array.from({ length: layers }, () => []);
  for (let l = 0; l < layers; l++) {
    const members = ids.filter((id) => layerOf.get(id) === l);
    const score = (id: string): number => {
      const preds = edges.filter((e, i) => !back.has(i) && e.to === id && slots.has(e.from)).map((e) => slots.get(e.from) as number);
      return preds.length === 0 ? Number.POSITIVE_INFINITY : preds.reduce((a, b) => a + b, 0) / preds.length;
    };
    const sorted = [...members].sort((a, b) => {
      const d = score(a) - score(b);
      return Number.isNaN(d) || d === 0 ? ids.indexOf(a) - ids.indexOf(b) : d;
    });
    sorted.forEach((id, k) => slots.set(id, k));
    byLayer[l] = sorted;
  }
  const place: DiagramLayout["place"] = {};
  byLayer.forEach((members, l) => members.forEach((id, k) => (place[id] = { layer: l, slot: k, count: members.length })));
  return {
    layers,
    widest: Math.max(0, ...byLayer.map((m) => m.length)),
    place,
    backEdges: [...back].sort((a, b) => a - b),
    order: byLayer.flat(),
  };
}
