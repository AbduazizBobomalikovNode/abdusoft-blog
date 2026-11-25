import { LIMITS } from "./limits.ts";
import { convertZodIssue, formatIssues, type StoryboardIssue } from "./schema/issues.ts";
import { type Storyboard, storyboardSchema } from "./schema/storyboard.ts";
import { computeTimeline, type Timeline } from "./timeline.ts";
import { FPS } from "./timing.ts";

export type ValidationResult =
  | { ok: true; storyboard: Storyboard; timeline: Timeline }
  | { ok: false; issues: StoryboardIssue[] };

const roundUp1 = (s: number): number => Math.ceil(s * 10) / 10;
const fmt = (s: number): string => `${(Math.round(s * 10) / 10).toString()} s`;

/**
 * Stage two: limits that depend on the computed timeline. Runs only on a structurally valid
 * storyboard, so every number here is real.
 */
export function timelineIssues(sb: Storyboard, tl: Timeline): StoryboardIssue[] {
  const issues: StoryboardIssue[] = [];
  tl.scenes.forEach((t) => {
    const scene = sb.scenes[t.index];
    if (!scene) return;
    const minSeconds = roundUp1(t.minFrames / FPS);
    if (t.explicit && t.durationFrames < t.minFrames) {
      issues.push({
        path: `scenes[${t.index}].durationSeconds`,
        code: "duration_too_short",
        message: `durationSeconds ${scene.durationSeconds} is shorter than this ${scene.type} scene needs: its animation only finishes after ${fmt(minSeconds)}`,
        limit: minSeconds,
        actual: scene.durationSeconds as number,
        suggestion: `Remove durationSeconds (automatic length: ${fmt(roundUp1(t.autoFrames / FPS))}) or set it to ${minSeconds} or more. To make the scene shorter, remove content (fewer bullets, steps or terminal lines).`,
      });
    }
    if (!t.explicit && t.durationFrames / FPS > LIMITS.maxSceneSeconds) {
      issues.push({
        path: `scenes[${t.index}]`,
        code: "scene_too_long",
        message: `this ${scene.type} scene needs ${fmt(t.durationFrames / FPS)} automatically; the limit per scene is ${LIMITS.maxSceneSeconds} s`,
        limit: LIMITS.maxSceneSeconds,
        actual: Math.round((t.durationFrames / FPS) * 10) / 10,
        suggestion: "Shorten the content (fewer code steps or terminal lines) or split it into two scenes.",
      });
    }
  });
  if (tl.totalSeconds > LIMITS.maxTotalSeconds + 1e-9) {
    const longest = [...tl.scenes]
      .sort((a, b) => b.durationFrames - a.durationFrames)
      .slice(0, 3)
      .map((t) => `scenes[${t.index}] (${t.type}${t.explicit ? ", explicit" : ""}) ${fmt(t.durationFrames / FPS)}`);
    issues.push({
      path: "scenes",
      code: "total_too_long",
      message: `total duration is ${fmt(tl.totalSeconds)}; the limit is ${LIMITS.maxTotalSeconds} s`,
      limit: LIMITS.maxTotalSeconds,
      actual: Math.round(tl.totalSeconds * 10) / 10,
      suggestion: `Cut about ${fmt(tl.totalSeconds - LIMITS.maxTotalSeconds)}. Longest scenes: ${longest.join("; ")}. Remove or merge scenes, drop bullets or code steps, or remove explicit durationSeconds.`,
    });
  }
  return issues;
}

/** Validate an already-parsed JSON value. Never throws. */
export function validateStoryboard(input: unknown): ValidationResult {
  const parsed = storyboardSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => convertZodIssue(i, input)) };
  }
  const timeline = computeTimeline(parsed.data);
  const issues = timelineIssues(parsed.data, timeline);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, storyboard: parsed.data, timeline };
}

/** Validate JSON text; a syntax error is reported like any other issue. */
export function validateStoryboardJson(text: string): ValidationResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, issues: [{ path: "$", code: "invalid_json", message: `not valid JSON: ${message}`, suggestion: "Send a single JSON object with double-quoted keys and no trailing commas or comments." }] };
  }
  return validateStoryboard(value);
}

export class StoryboardValidationError extends Error {
  readonly issues: StoryboardIssue[];
  constructor(issues: StoryboardIssue[]) {
    super(`Invalid storyboard:\n${formatIssues(issues)}`);
    this.name = "StoryboardValidationError";
    this.issues = issues;
  }
}

/** Validate or throw a StoryboardValidationError carrying the issue list. */
export function assertStoryboard(input: unknown): { storyboard: Storyboard; timeline: Timeline } {
  const r = validateStoryboard(input);
  if (!r.ok) throw new StoryboardValidationError(r.issues);
  return { storyboard: r.storyboard, timeline: r.timeline };
}
