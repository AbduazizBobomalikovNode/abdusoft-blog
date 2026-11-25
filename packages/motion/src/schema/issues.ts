import type { z } from "zod";
import { LIMITS } from "../limits.ts";
import {
  bulletsSceneSchema,
  codeSceneSchema,
  codeStepSchema,
  LANGUAGE_ALIASES,
  outroSceneSchema,
  SCENE_TYPES,
  storyboardSchema,
  terminalSceneSchema,
  titleSceneSchema,
} from "./storyboard.ts";

/**
 * A validation problem written for a machine author: exact path, what was wrong, the limit and the
 * actual value when there is one, and a concrete suggestion for the fix.
 */
export interface StoryboardIssue {
  /** e.g. `scenes[2].items[1]`; `$` for the document root. */
  path: string;
  code: string;
  message: string;
  limit?: number | string;
  actual?: number | string;
  suggestion?: string;
}

export function formatPath(segments: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const s of segments) {
    if (typeof s === "number") out += `[${s}]`;
    else out += out ? `.${String(s)}` : String(s);
  }
  return out === "" ? "$" : out;
}

export function formatIssue(i: StoryboardIssue): string {
  const parts = [`${i.path}: ${i.message}`];
  if (i.suggestion) parts.push(`  fix: ${i.suggestion}`);
  return parts.join("\n");
}

export function formatIssues(issues: readonly StoryboardIssue[]): string {
  return issues.map((i, n) => `${n + 1}. ${formatIssue(i)}`).join("\n");
}

function at(input: unknown, segments: ReadonlyArray<PropertyKey>): unknown {
  let cur: unknown = input;
  for (const s of segments) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[s as string];
  }
  return cur;
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) (dp[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      (dp[i] as number[])[j] = Math.min(
        (dp[i - 1] as number[])[j]! + 1,
        (dp[i] as number[])[j - 1]! + 1,
        (dp[i - 1] as number[])[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return (dp[a.length] as number[])[b.length] as number;
}

export function nearest(word: string, options: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const o of options) {
    const d = distance(word.toLowerCase(), o.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best !== undefined && bestD <= Math.max(1, Math.floor(best.length / 3)) ? best : undefined;
}

const SCENE_SCHEMAS = {
  title: titleSceneSchema,
  bullets: bulletsSceneSchema,
  code: codeSceneSchema,
  terminal: terminalSceneSchema,
  outro: outroSceneSchema,
} as const;

/** Keys the strict object at `segments` accepts, so "unknown key" errors can list them. */
function allowedKeys(segments: ReadonlyArray<PropertyKey>, input: unknown): string[] | undefined {
  if (segments.length === 0) return Object.keys(storyboardSchema.shape);
  const norm = segments.map((s) => (typeof s === "number" ? "[]" : String(s))).join(".");
  const sceneType = segments[0] === "scenes" && typeof segments[1] === "number" ? (at(input, ["scenes", segments[1], "type"]) as string | undefined) : undefined;
  if (norm === "scenes.[]") {
    const sch = sceneType && sceneType in SCENE_SCHEMAS ? SCENE_SCHEMAS[sceneType as keyof typeof SCENE_SCHEMAS] : undefined;
    return sch ? Object.keys(sch.shape) : undefined;
  }
  if (norm === "scenes.[].steps.[]") return Object.keys(codeStepSchema.shape);
  if (norm === "scenes.[].steps.[].lines") return ["from", "to"];
  if (norm === "scenes.[].lines.[]") {
    const kind = at(input, segments) as { kind?: string } | undefined;
    return kind?.kind === "output" ? ["kind", "text", "tone", "waitSeconds"] : ["kind", "text", "waitSeconds"];
  }
  return undefined;
}

/** Human noun for a path: `scenes[1].items[2]` -> `bullet 3`, otherwise the last key. */
function fieldName(segments: ReadonlyArray<PropertyKey>): string {
  const last = segments.at(-1);
  const prev = segments.at(-2);
  if (typeof last === "number") {
    const base = String(prev ?? "item").replace(/s$/, "");
    return `${base === "item" ? "bullet" : base} ${last + 1}`;
  }
  return String(last ?? "value");
}

const SUGGESTIONS: Record<string, string> = {
  title: "Shorten it to the key idea, or move detail into 'subtitle'.",
  kicker: "Use 1-3 words, e.g. a category or series name.",
  subtitle: "Keep one short sentence; put extra points into a 'bullets' scene.",
  tag: "Use a short keyword (a technology or topic name).",
  tags: "Keep the 3-5 most relevant keywords.",
  heading: "Shorten the heading; the bullets carry the detail.",
  bullet: "Rewrite as a short phrase, or split it into two bullets.",
  items: "Keep the key points; move the rest to another bullets scene.",
  label: "State the one idea of this step in a few words.",
  fileName: "Use the base file name (e.g. 'server.ts') instead of the full path.",
  cta: "Keep the call to action to one short sentence.",
  url: "Show the bare domain or short path (e.g. 'abdusoft.uz/post').",
  siteName: "Use the short site name.",
  text: `Keep each terminal line within ${LIMITS.maxLineChars} characters.`,
  lines: `Keep at most ${LIMITS.maxTerminalLines} terminal entries; drop the least informative output lines.`,
  steps: `Merge steps; at most ${LIMITS.maxCodeSteps} highlight steps.`,
  scenes: `Merge or drop scenes; at most ${LIMITS.maxScenes} scenes and ${LIMITS.maxTotalSeconds} s in total.`,
  command: `Shorten the command (max ${LIMITS.maxLineChars} chars) or break it with line continuations.`,
  durationSeconds: `Use a value between ${LIMITS.minSceneSeconds} and ${LIMITS.maxSceneSeconds}, or omit it for automatic timing.`,
};

function suggestionFor(segments: ReadonlyArray<PropertyKey>): string | undefined {
  const keys = segments.filter((s): s is string => typeof s === "string");
  const last = keys.at(-1);
  const isItem = typeof segments.at(-1) === "number";
  if (isItem && last === "items") return SUGGESTIONS.bullet;
  if (isItem && last === "tags") return SUGGESTIONS.tag;
  if (isItem && last === "lines") return SUGGESTIONS.lines;
  return last ? SUGGESTIONS[last] : undefined;
}

type ZIssue = z.core.$ZodIssue;

export function convertZodIssue(issue: ZIssue, input: unknown): StoryboardIssue {
  const segments = issue.path;
  const path = formatPath(segments);
  const value = at(input, segments);
  let name = fieldName(segments);
  if (name === "text" && segments.length > 1) {
    const parent = at(input, segments.slice(0, -1)) as { kind?: unknown } | undefined;
    if (parent?.kind === "command" || parent?.kind === "output") name = `${parent.kind} text`;
  }
  const base = { path, code: issue.code } as const;
  const params = (issue as { params?: Record<string, unknown> }).params;
  switch (issue.code) {
    case "custom": {
      const out: StoryboardIssue = { ...base, message: issue.message ?? "invalid value" };
      if (params?.limit !== undefined) out.limit = params.limit as number;
      if (params?.actual !== undefined) out.actual = params.actual as number;
      const sug = (params?.suggestion as string | undefined) ?? suggestionFor(segments);
      if (sug) out.suggestion = sug;
      return out;
    }
    case "too_big": {
      const max = Number(issue.maximum);
      if (issue.origin === "string") {
        const actual = typeof value === "string" ? [...value].length : undefined;
        return {
          ...base,
          message: `${name} is ${actual ?? "too many"} characters; the limit is ${max}`,
          limit: max,
          ...(actual !== undefined ? { actual } : {}),
          ...sug(segments),
        };
      }
      if (issue.origin === "array") {
        const actual = Array.isArray(value) ? value.length : undefined;
        const what = name === "scenes" ? "scenes" : "entries";
        return { ...base, message: `${name} has ${actual ?? "too many"} ${what}; the limit is ${max}`, limit: max, ...(actual !== undefined ? { actual } : {}), ...sug(segments) };
      }
      return { ...base, message: `${name} is ${String(value)}; the maximum is ${max}`, limit: max, ...(typeof value === "number" ? { actual: value } : {}), ...sug(segments) };
    }
    case "too_small": {
      const min = Number(issue.minimum);
      if (issue.message && !/^(Too small|Invalid)/.test(issue.message)) return { ...base, message: issue.message, limit: min, ...sug(segments) };
      if (issue.origin === "number") return { ...base, message: `${name} is ${String(value)}; the minimum is ${min}`, limit: min, ...(typeof value === "number" ? { actual: value } : {}), ...sug(segments) };
      return { ...base, message: `${name} must have at least ${min} ${issue.origin === "array" ? "entries" : "characters"}`, limit: min, ...sug(segments) };
    }
    case "unrecognized_keys": {
      const keys = issue.keys;
      const allowed = allowedKeys(segments, input);
      const hints = keys.map((k) => (allowed ? nearest(k, allowed) : undefined)).map((n, i) => (n ? `"${keys[i]}" -> "${n}"` : undefined)).filter(Boolean);
      const out: StoryboardIssue = {
        ...base,
        path: path,
        message: `unknown key${keys.length > 1 ? "s" : ""} ${keys.map((k) => `"${k}"`).join(", ")}${allowed ? `; allowed keys: ${allowed.join(", ")}` : ""}`,
      };
      out.suggestion = hints.length ? `Did you mean ${hints.join(", ")}? Remove keys the schema does not define.` : "Remove keys the schema does not define.";
      return out;
    }
    case "invalid_value": {
      const options = issue.values.map(String);
      if (options.length === 1 && name === "version") {
        return { ...base, message: `version must be ${options[0]}; got ${JSON.stringify(value)}`, limit: options[0] as string, suggestion: `Set "version": ${options[0]}.` };
      }
      const got = typeof value === "string" ? value : JSON.stringify(value);
      const alias = typeof value === "string" ? LANGUAGE_ALIASES[value.toLowerCase()] : undefined;
      const near = typeof value === "string" ? (alias ?? nearest(value, options)) : undefined;
      const lastKey = segments.at(-1);
      let message = `${name} must be one of: ${options.join(", ")}; got ${JSON.stringify(got)}`;
      if (lastKey === "format") message = `format "${String(value)}" is not enabled yet; only "landscape" (1920x1080 @ 30 fps) is accepted`;
      return {
        ...base,
        message,
        limit: options.join(" | "),
        actual: String(got),
        suggestion: near ? `Did you mean "${near}"?` : lastKey === "format" ? 'Use "format": "landscape".' : `Use one of: ${options.join(", ")}.`,
      };
    }
    case "invalid_union": {
      const sceneIdx = segments[0] === "scenes" && typeof segments[1] === "number";
      if (sceneIdx && segments.at(-1) === "type") {
        const got = typeof value === "string" ? value : JSON.stringify(value);
        return {
          ...base,
          message: `unknown scene type ${JSON.stringify(got)}; supported types: ${SCENE_TYPES.join(", ")}`,
          actual: String(got),
          limit: SCENE_TYPES.join(" | "),
          suggestion: typeof value === "string" && nearest(value, SCENE_TYPES) ? `Did you mean "${nearest(value, SCENE_TYPES)}"?` : `Use one of: ${SCENE_TYPES.join(", ")}.`,
        };
      }
      if (segments.at(-1) === "kind") {
        return { ...base, message: `terminal entry kind must be "command" or "output"; got ${JSON.stringify(value)}`, suggestion: 'Use "kind": "command" for typed input and "kind": "output" for printed lines.' };
      }
      return { ...base, message: issue.message };
    }
    case "invalid_type": {
      const received = value === undefined ? "missing" : value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      const expected = (issue as { expected?: string }).expected ?? "a different type";
      const message = value === undefined ? `${name} is required but missing (expected ${expected})` : `${name} must be ${expected}; got ${received}`;
      return { ...base, message, ...sug(segments) };
    }
    default:
      return { ...base, message: issue.message, ...sug(segments) };
  }
}

function sug(segments: ReadonlyArray<PropertyKey>): { suggestion?: string } {
  const s = suggestionFor(segments);
  return s ? { suggestion: s } : {};
}
