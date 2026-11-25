import type { SceneTiming, Timeline } from "./timeline.ts";

/**
 * Resolve a user-supplied scene reference to a scene of the timeline: a scene `id`, or its 1-based
 * position ("3"). Pure, so the CLI and the programmatic API report identical errors.
 */
export function resolveScene(timeline: Timeline, ref: string): SceneTiming {
  const byId = timeline.scenes.find((s) => s.id === ref);
  if (byId) return byId;
  if (/^\d+$/.test(ref)) {
    const n = Number(ref);
    const byIndex = timeline.scenes[n - 1];
    if (byIndex) return byIndex;
    throw new Error(`scene ${n} does not exist: the storyboard has ${timeline.scenes.length} scenes (use 1-${timeline.scenes.length} or a scene id)`);
  }
  const ids = timeline.scenes.map((s, i) => `${i + 1}${s.id ? `=${s.id}` : ""} (${s.type})`).join(", ");
  throw new Error(`no scene with id "${ref}"; scenes: ${ids}`);
}

/** Frames of a scene on the whole-video clock: its own start to the frame before the next scene takes over. */
export function sceneFrameRange(s: SceneTiming): { startFrame: number; endFrame: number } {
  return { startFrame: s.startFrame, endFrame: s.endFrame - 1 };
}

/** Review frames of a scene: start of its content, about a third, two thirds, and the settled end. */
export function sceneReviewFrames(s: SceneTiming): Array<{ label: string; frame: number }> {
  const first = s.startFrame + s.leadFrames;
  const last = Math.max(first, s.endFrame - s.exit.frames - 1);
  const span = last - first;
  return [
    { label: "start", frame: first },
    { label: "early", frame: first + Math.round(span * 0.3) },
    { label: "middle", frame: first + Math.round(span * 0.6) },
    { label: "end", frame: last },
  ];
}
