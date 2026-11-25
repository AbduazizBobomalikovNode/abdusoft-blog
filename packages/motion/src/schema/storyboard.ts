import { z } from "zod";
import { ENABLED_FORMATS } from "../layout.ts";
import { LIMITS } from "../limits.ts";
import { HEX_PATTERN } from "../theme/tokens.ts";

/**
 * Storyboard = the only input of the engine: pure data, written by an assistant (or a human) and
 * validated here. Every object is strict: an unknown key is an error, never silently dropped.
 *
 * Validation is two-stage. This file is stage one (structure, per-field limits, cross-field checks
 * inside one scene). Stage two (timing: scene durations vs. content, 60 s total) lives in
 * `validate.ts` because it needs the computed timeline.
 */
export const STORYBOARD_VERSION = 1 as const;

const hasControl = (v: string): boolean => [...v].some((c) => {
  const n = c.codePointAt(0) as number;
  return n < 32 || n === 127;
});

/** Single-line display text: no line breaks or control characters. */
const line = (max: number, what: string) =>
  z
    .string()
    .min(1, { error: `${what} must not be empty` })
    .max(max)
    .refine((v) => !hasControl(v), {
      error: `${what} must be a single line without line breaks, tabs or control characters`,
      params: { suggestion: "Join the text into one line; put a second sentence into 'subtitle' or another scene." },
    })
    .refine((v) => v.trim() === v, { error: `${what} must not start or end with whitespace`, params: { suggestion: "Remove the leading or trailing spaces." } });

export const TRANSITIONS = ["cut", "fade", "slide"] as const;
export const THEME_MODES = ["light", "dark"] as const;
export const CODE_LANGUAGES = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "bash",
  "python",
  "go",
  "rust",
  "sql",
  "yaml",
  "html",
  "css",
  "markdown",
  "diff",
  "dockerfile",
  "text",
] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

/** Aliases an author is likely to type; used only to give a precise "did you mean". */
export const LANGUAGE_ALIASES: Record<string, CodeLanguage> = {
  ts: "typescript",
  js: "javascript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  shellscript: "bash",
  console: "bash",
  py: "python",
  yml: "yaml",
  md: "markdown",
  txt: "text",
  plaintext: "text",
  plain: "text",
  golang: "go",
  rs: "rust",
  docker: "dockerfile",
};

export const TONES = ["default", "muted", "success", "error"] as const;

const seconds = (min: number, max: number, what: string) =>
  z
    .number({ error: (iss) => (iss.code === "invalid_type" ? `${what} must be a number of seconds` : undefined) })
    .min(min)
    .max(max)
    .describe(`${what}, ${min}-${max} s`);

const common = {
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, { error: "id must be 1-32 chars of a-z, 0-9 and '-' (lowercase, starts with a letter or digit)" })
    .optional()
    .describe("Optional stable name for this scene; used in messages and still file names"),
  durationSeconds: seconds(LIMITS.minSceneSeconds, LIMITS.maxSceneSeconds, "Scene duration")
    .optional()
    .describe(
      `Omit for an automatic duration derived from the content (reading and typing speed). Set only to hold a scene longer; it can never be shorter than the content needs (${LIMITS.minSceneSeconds}-${LIMITS.maxSceneSeconds} s)`,
    ),
  transition: z
    .enum(TRANSITIONS)
    .optional()
    .describe("How this scene comes in from the previous one; defaults to the storyboard's defaultTransition. Ignored on the first scene"),
};

export const titleSceneSchema = z.strictObject({
  type: z.literal("title"),
  ...common,
  kicker: line(LIMITS.kicker, "kicker").optional().describe(`Small label above the title, max ${LIMITS.kicker} chars`),
  title: line(LIMITS.title, "title").describe(`Main title, max ${LIMITS.title} chars`),
  subtitle: line(LIMITS.subtitle, "subtitle").optional().describe(`One supporting sentence, max ${LIMITS.subtitle} chars`),
  tags: z
    .array(line(LIMITS.tag, "tag"))
    .max(LIMITS.maxTags)
    .optional()
    .describe(`Up to ${LIMITS.maxTags} short pills, each max ${LIMITS.tag} chars`),
});

export const bulletsSceneSchema = z.strictObject({
  type: z.literal("bullets"),
  ...common,
  heading: line(LIMITS.heading, "heading").describe(`Heading above the list, max ${LIMITS.heading} chars`),
  items: z
    .array(line(LIMITS.bullet, "bullet"))
    .min(1, { error: "items must contain at least one bullet" })
    .max(LIMITS.maxBullets)
    .describe(`1-${LIMITS.maxBullets} bullets revealed one by one, each max ${LIMITS.bullet} chars`),
});

const lineRange = z
  .strictObject({
    from: z.number().int().min(1).describe("First highlighted line (1-based)"),
    to: z.number().int().min(1).describe("Last highlighted line (1-based, inclusive)"),
  })
  .describe("Inclusive 1-based line range to highlight");

export const codeStepSchema = z.strictObject({
  lines: lineRange,
  label: line(LIMITS.stepLabel, "label").optional().describe(`Caption shown under the code while this step is active, max ${LIMITS.stepLabel} chars`),
  durationSeconds: seconds(LIMITS.stepSeconds.min, LIMITS.stepSeconds.max, "Step duration")
    .optional()
    .describe("Omit for automatic timing based on label length and number of lines"),
});

export const codeSceneSchema = z
  .strictObject({
    type: z.literal("code"),
    ...common,
    language: z.enum(CODE_LANGUAGES).describe("Syntax highlighting language"),
    fileName: line(LIMITS.fileName, "fileName").optional().describe(`Shown in the code block header, max ${LIMITS.fileName} chars`),
    code: z
      .string()
      .min(1, { error: "code must not be empty" })
      .describe(`Source text, max ${LIMITS.maxCodeLines} lines of max ${LIMITS.maxLineChars} chars; use spaces, not tabs`),
    steps: z
      .array(codeStepSchema)
      .max(LIMITS.maxCodeSteps)
      .optional()
      .describe(`Up to ${LIMITS.maxCodeSteps} highlight steps shown in order; the rest of the code is dimmed`),
    typing: z.boolean().optional().describe("Type the code out with a caret (default false: the block fades in complete)"),
  })
  .superRefine((scene, ctx) => checkCode(scene, ctx));

/** Count of lines in a code string, ignoring one trailing newline. */
export function codeLines(code: string): string[] {
  const lines = code.replace(/\n$/, "").split("\n");
  return lines;
}

function checkCode(scene: { code: string; steps?: Array<{ lines: { from: number; to: number } }> | undefined }, ctx: z.RefinementCtx): void {
  const lines = codeLines(scene.code);
  if (scene.code.includes("\t")) {
    ctx.addIssue({
      code: "custom",
      path: ["code"],
      message: "code contains a tab character",
      params: { suggestion: "Replace tabs with spaces (2 or 4)." },
    });
  }
  if (scene.code.includes("\r")) {
    ctx.addIssue({ code: "custom", path: ["code"], message: "code contains a carriage return", params: { suggestion: "Use \\n line endings only." } });
  }
  if (lines.length > LIMITS.maxCodeLines) {
    ctx.addIssue({
      code: "custom",
      path: ["code"],
      message: `code has ${lines.length} lines; the limit is ${LIMITS.maxCodeLines}`,
      params: {
        limit: LIMITS.maxCodeLines,
        actual: lines.length,
        suggestion: `Show only the ${LIMITS.maxCodeLines} most relevant lines, or split the walkthrough into two code scenes.`,
      },
    });
  }
  lines.forEach((l, i) => {
    if ([...l].length > LIMITS.maxLineChars) {
      ctx.addIssue({
        code: "custom",
        path: ["code"],
        message: `code line ${i + 1} has ${[...l].length} characters; the limit is ${LIMITS.maxLineChars}`,
        params: {
          limit: LIMITS.maxLineChars,
          actual: [...l].length,
          suggestion: `Break line ${i + 1} into shorter lines (max ${LIMITS.maxLineChars} chars) so it stays readable on screen.`,
        },
      });
    }
  });
  scene.steps?.forEach((s, i) => {
    const { from, to } = s.lines;
    if (from > to) {
      ctx.addIssue({
        code: "custom",
        path: ["steps", i, "lines"],
        message: `lines.from (${from}) is greater than lines.to (${to})`,
        params: { suggestion: `Swap them: { "from": ${to}, "to": ${from} }.` },
      });
    }
    if (to > lines.length) {
      ctx.addIssue({
        code: "custom",
        path: ["steps", i, "lines", "to"],
        message: `lines.to is ${to} but the code has only ${lines.length} lines`,
        params: { limit: lines.length, actual: to, suggestion: `Use a line number between 1 and ${lines.length}.` },
      });
    }
  });
}

const terminalCommand = z.strictObject({
  kind: z.literal("command"),
  text: line(LIMITS.maxLineChars, "command").describe(`Typed after the prompt, max ${LIMITS.maxLineChars} chars`),
  waitSeconds: seconds(0, LIMITS.maxWaitSeconds, "Pause before typing").optional(),
});
const terminalOutput = z.strictObject({
  kind: z.literal("output"),
  text: z
    .string()
    .max(LIMITS.maxLineChars)
    .describe(`One output line, max ${LIMITS.maxLineChars} chars (may be empty for a blank line)`)
    .refine((v) => !hasControl(v), {
      error: "output must be a single line without line breaks, tabs or control characters",
      params: { suggestion: "Send one entry per output line." },
    }),
  tone: z.enum(TONES).optional().describe("default | muted | success | error"),
  waitSeconds: seconds(0, LIMITS.maxWaitSeconds, "Pause before the line appears").optional(),
});

export const terminalSceneSchema = z
  .strictObject({
    type: z.literal("terminal"),
    ...common,
    title: line(LIMITS.terminalTitle, "title").optional().describe(`Window title, max ${LIMITS.terminalTitle} chars`),
    lines: z
      .array(z.discriminatedUnion("kind", [terminalCommand, terminalOutput]))
      .min(1, { error: "lines must contain at least one entry" })
      .max(LIMITS.maxTerminalLines)
      .describe(`Commands are typed, outputs appear; at most ${LIMITS.maxTerminalLines} entries in total`),
  })
  .superRefine((scene, ctx) => {
    if (!scene.lines.some((l) => l.kind === "command")) {
      ctx.addIssue({
        code: "custom",
        path: ["lines"],
        message: "a terminal scene needs at least one command",
        params: { suggestion: 'Add an entry like { "kind": "command", "text": "pnpm install" }.' },
      });
    }
  });

export const outroSceneSchema = z.strictObject({
  type: z.literal("outro"),
  ...common,
  siteName: line(LIMITS.siteName, "siteName").optional().describe("Defaults to the storyboard's siteName"),
  cta: line(LIMITS.cta, "cta").describe(`Call to action, max ${LIMITS.cta} chars`),
  url: line(LIMITS.url, "url")
    .refine((v) => !/\s/.test(v), { error: "url text must not contain spaces", params: { suggestion: "Use a bare domain or short path such as 'blog.abdusoft.uz'." } })
    .describe(`URL shown as text (never fetched or linked), max ${LIMITS.url} chars`),
});

export const sceneSchema = z.discriminatedUnion("type", [
  titleSceneSchema,
  bulletsSceneSchema,
  codeSceneSchema,
  terminalSceneSchema,
  outroSceneSchema,
]);

export const SCENE_TYPES = ["title", "bullets", "code", "terminal", "outro"] as const;

export const storyboardSchema = z.strictObject({
  version: z.literal(STORYBOARD_VERSION).describe("Schema version; currently 1"),
  title: line(LIMITS.storyboardTitle, "title").describe("Storyboard title (metadata and file names; not drawn)"),
  theme: z.enum(THEME_MODES).describe("light | dark, matching the blog's two themes"),
  accent: z
    .string()
    .regex(HEX_PATTERN, { error: "accent must be a hex colour like #6366f1 or #63f" })
    .optional()
    .describe("Optional accent colour as #RGB or #RRGGBB; defaults to the blog's blue-violet. Used sparingly"),
  siteName: line(LIMITS.siteName, "siteName").default("abdusoft").describe("Wordmark shown in the corner; default 'abdusoft'"),
  format: z
    .enum(ENABLED_FORMATS, { error: `format must be one of: ${ENABLED_FORMATS.join(", ")} ('vertical' and 'square' are not enabled yet)` })
    .default("landscape")
    .describe("Only 'landscape' (1920x1080, 30 fps) is accepted for now"),
  defaultTransition: z.enum(TRANSITIONS).default("fade").describe("Transition used by scenes that do not set their own"),
  scenes: z
    .array(sceneSchema)
    .min(1, { error: "scenes must contain at least one scene" })
    .max(LIMITS.maxScenes)
    .describe(`Ordered scenes, 1-${LIMITS.maxScenes}; total video at most ${LIMITS.maxTotalSeconds} s`),
});

export type Storyboard = z.output<typeof storyboardSchema>;
export type StoryboardInput = z.input<typeof storyboardSchema>;
export type Scene = Storyboard["scenes"][number];
export type TitleScene = z.output<typeof titleSceneSchema>;
export type BulletsScene = z.output<typeof bulletsSceneSchema>;
export type CodeScene = z.output<typeof codeSceneSchema>;
export type TerminalScene = z.output<typeof terminalSceneSchema>;
export type OutroScene = z.output<typeof outroSceneSchema>;
export type SceneType = Scene["type"];
