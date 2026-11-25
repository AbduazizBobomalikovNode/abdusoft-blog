import { INPUT_LIMITS, LIMITS } from "./limits.ts";
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

/** Keep the first `maxIssues` problems and say how many were left out; a hostile input cannot make the list grow without bound. */
export function capIssues(issues: StoryboardIssue[]): StoryboardIssue[] {
  if (issues.length <= INPUT_LIMITS.maxIssues) return issues;
  const kept = issues.slice(0, INPUT_LIMITS.maxIssues);
  kept.push({
    path: "$",
    code: "too_many_issues",
    message: `${issues.length - INPUT_LIMITS.maxIssues} more problems are not listed`,
    suggestion: "Fix the problems above first, then validate again.",
  });
  return kept;
}

function internalFailure(err: unknown): ValidationResult {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, issues: [{ path: "$", code: "validation_failed", message: `the storyboard could not be validated: ${message.slice(0, 200)}`, suggestion: "Check that the input is a plain JSON object that follows the schema." }] };
}

/** Validate an already-parsed JSON value. Never throws. */
export function validateStoryboard(input: unknown): ValidationResult {
  try {
    const parsed = storyboardSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, issues: capIssues(parsed.error.issues.slice(0, INPUT_LIMITS.maxIssues + 1).map((i) => convertZodIssue(i, input))) };
    }
    const timeline = computeTimeline(parsed.data);
    const issues = timelineIssues(parsed.data, timeline);
    if (issues.length > 0) return { ok: false, issues: capIssues(issues) };
    return { ok: true, storyboard: parsed.data, timeline };
  } catch (err) {
    return internalFailure(err);
  }
}

/** Reject text that is too big to be a storyboard BEFORE parsing it. `null` when the size is fine. */
export function oversizeIssue(byteLength: number): StoryboardIssue | null {
  if (byteLength <= INPUT_LIMITS.maxStoryboardBytes) return null;
  return {
    path: "$",
    code: "input_too_large",
    message: `the storyboard is ${byteLength} bytes; the limit is ${INPUT_LIMITS.maxStoryboardBytes} bytes`,
    limit: INPUT_LIMITS.maxStoryboardBytes,
    actual: byteLength,
    suggestion: `A storyboard is at most ${LIMITS.maxScenes} short scenes: remove text that cannot fit on screen anyway.`,
  };
}

/** Validate JSON text; a syntax error or an oversized input is reported like any other issue. Never throws. */
export function validateStoryboardJson(text: string): ValidationResult {
  // UTF-8 bytes are at most 3x the UTF-16 length, so a cheap length test settles most cases without a byte count.
  const tooBig = oversizeIssue(text.length * 3 <= INPUT_LIMITS.maxStoryboardBytes ? 0 : Buffer.byteLength(text, "utf8"));
  if (tooBig) return { ok: false, issues: [tooBig] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, issues: [{ path: "$", code: "invalid_json", message: `not valid JSON: ${message.slice(0, 200)}`, suggestion: "Send a single JSON object with double-quoted keys and no trailing commas or comments." }] };
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
