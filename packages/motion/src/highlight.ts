import { z } from "zod";

/**
 * Syntax-highlighted code as plain data: shiki tokens computed on the Node side (prepare.ts) and drawn
 * as React elements by the bundle. Storyboard text never becomes HTML anywhere.
 */
export const tokenSchema = z.strictObject({
  content: z.string(),
  color: z.string().optional(),
  /** shiki FontStyle bit flags: 1 italic, 2 bold, 4 underline. */
  fontStyle: z.number().int().optional(),
});
export const highlightedLinesSchema = z.array(z.array(tokenSchema));

export type Token = z.infer<typeof tokenSchema>;
export type HighlightedLines = z.infer<typeof highlightedLinesSchema>;

/** Highlight data for a whole storyboard, keyed by scene index (as strings: JSON object keys). */
export const highlightsSchema = z.strictObject({
  /** code scenes: lines of tokens */
  code: z.record(z.string(), highlightedLinesSchema),
  /** terminal scenes: per entry index, the tokens of a command line (outputs are not tokenized) */
  terminal: z.record(z.string(), z.record(z.string(), z.array(tokenSchema))),
});
export type Highlights = z.infer<typeof highlightsSchema>;

/** Plain, unhighlighted fallback (language "text" and the tests). */
export function plainLines(code: string): HighlightedLines {
  return code.split("\n").map((l) => (l.length > 0 ? [{ content: l }] : []));
}
