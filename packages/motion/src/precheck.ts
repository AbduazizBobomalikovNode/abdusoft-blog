import type { StoryboardIssue } from "./schema/issues.ts";

/**
 * Cheap structural limits checked BEFORE the schema runs. A strict schema reports every unknown key of every object, so a
 * 256 KB object with tens of thousands of junk keys costs about a second of CPU on a fast machine (several on a small server).
 * Counting nodes first rejects that in microseconds. The caps are far above a real storyboard (16 scenes, a few hundred nodes).
 */
export const STRUCTURE_LIMITS = {
  /** Every object, array and primitive in the whole document. */
  maxNodes: 6000,
  maxDepth: 12,
  /** Keys of one object (a scene has at most ~25). */
  maxKeys: 48,
  /** Items of one array (16 scenes; code and terminal lines are limited far lower by the schema). */
  maxArrayItems: 128,
} as const;

/** `null` when the structure is acceptable. Iterative (no recursion limit), stops at the first violation, never throws. */
export function structureIssue(input: unknown): StoryboardIssue | null {
  const L = STRUCTURE_LIMITS;
  let nodes = 0;
  const stack: Array<{ value: unknown; depth: number; path: string }> = [{ value: input, depth: 0, path: "$" }];
  const issue = (path: string, what: string, limit: number, actual: number): StoryboardIssue => ({
    path,
    code: "structure_too_large",
    message: `${what} (${actual}); the limit is ${limit}`,
    limit,
    actual,
    suggestion: "A storyboard is at most 16 short scenes with a handful of fields each: remove unknown or repeated fields and nesting.",
  });
  while (stack.length > 0) {
    const { value, depth, path } = stack.pop()!;
    if (++nodes > L.maxNodes) return issue("$", "the storyboard has too many values in total", L.maxNodes, nodes);
    if (value === null || typeof value !== "object") continue;
    if (depth >= L.maxDepth) return issue(path, "the storyboard is nested too deeply", L.maxDepth, depth + 1);
    if (Array.isArray(value)) {
      if (value.length > L.maxArrayItems) return issue(path, "a list has too many items", L.maxArrayItems, value.length);
      for (let i = value.length - 1; i >= 0; i--) stack.push({ value: value[i], depth: depth + 1, path: `${path}[${i}]` });
      continue;
    }
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length > L.maxKeys) return issue(path, "an object has too many fields", L.maxKeys, keys.length);
    for (const key of keys) stack.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1, path: `${path}.${key}` });
  }
  return null;
}
