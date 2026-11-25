import { z } from "zod";
import { layoutDiagram } from "../diagram-layout.ts";
import { ENABLED_FORMATS } from "../layout.ts";
import { INPUT_LIMITS, LIMITS } from "../limits.ts";
import { HEX_PATTERN, PRESETS } from "../theme/tokens.ts";

/**
 * Storyboard = the only input of the engine: pure data, written by an assistant (or a human) and
 * validated here. Every object is strict: an unknown key is an error, never silently dropped.
 *
 * Validation is two-stage. This file is stage one (structure, per-field limits, cross-field checks
 * inside one scene). Stage two (timing: scene durations vs. content, 60 s total) lives in
 * `validate.ts` because it needs the computed timeline.
 */
export const STORYBOARD_VERSION = 1 as const;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const hasControl = (v: string): boolean => CONTROL.test(v);

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

export const TRANSITIONS = ["cut", "fade", "slide", "wipe", "push", "zoom"] as const;
/** Intro / closing looks. Every variant exists for both scene types and takes the accent colour. */
export const SHOWPIECE_VARIANTS = ["aurora", "blueprint", "constellation", "boot", "signal", "slam"] as const;
export const TITLE_LAYOUTS = ["left", "centered", "split"] as const;
export const BULLETS_LAYOUTS = ["list", "centered", "split"] as const;
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
  layout: z
    .enum(TITLE_LAYOUTS)
    .optional()
    .describe("left (default) | centered | split (accent panel with the kicker on the left, title on the right)"),
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
  layout: z
    .enum(BULLETS_LAYOUTS)
    .optional()
    .describe("list (default) | centered (heading above a centred column) | split (heading on an accent panel, bullets on the right)"),
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
      .max(INPUT_LIMITS.maxCodeChars, {
        error: `code is far longer than the screen can show (limit ${INPUT_LIMITS.maxCodeChars} characters = ${LIMITS.maxCodeLines} lines of ${LIMITS.maxLineChars})`,
      })
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
  // Oversized text is already reported by the field's own max(); do not walk it line by line.
  if (scene.code.length > INPUT_LIMITS.maxCodeChars) return;
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


/* ------------------------------------------------------------------------------------------------
 * Showpieces: intro and closing
 * ---------------------------------------------------------------------------------------------- */

export const introSceneSchema = z.strictObject({
  type: z.literal("intro"),
  ...common,
  variant: z.enum(SHOWPIECE_VARIANTS).optional().describe(`Look of the opener: ${SHOWPIECE_VARIANTS.join(" | ")} (default aurora)`),
  kicker: line(LIMITS.kicker, "kicker").optional().describe(`Small label above the title, max ${LIMITS.kicker} chars`),
  title: line(LIMITS.title, "title").describe(`Main title, max ${LIMITS.title} chars`),
  subtitle: line(LIMITS.subtitle, "subtitle").optional().describe(`One supporting sentence, max ${LIMITS.subtitle} chars`),
  tags: z
    .array(line(LIMITS.tag, "tag"))
    .max(LIMITS.maxTags)
    .optional()
    .describe(`Up to ${LIMITS.maxTags} short pills, each max ${LIMITS.tag} chars`),
});

export const closingSceneSchema = z.strictObject({
  type: z.literal("closing"),
  ...common,
  variant: z.enum(SHOWPIECE_VARIANTS).optional().describe(`Look of the closer: ${SHOWPIECE_VARIANTS.join(" | ")} (default aurora)`),
  siteName: line(LIMITS.siteName, "siteName").optional().describe("Defaults to the storyboard's siteName"),
  cta: line(LIMITS.cta, "cta").describe(`Call to action, max ${LIMITS.cta} chars`),
  url: line(LIMITS.url, "url")
    .refine((v) => !/\s/.test(v), { error: "url text must not contain spaces", params: { suggestion: "Use a bare domain or short path such as 'blog.abdusoft.uz'." } })
    .describe(`URL shown as text (never fetched or linked), max ${LIMITS.url} chars`),
});

/* ------------------------------------------------------------------------------------------------
 * diagram
 * ---------------------------------------------------------------------------------------------- */

export const NODE_TONES = ["default", "accent", "muted", "success", "error"] as const;
export const DIAGRAM_DIRECTIONS = ["lr", "tb"] as const;
export const MAX_DIAGRAM_LAYERS = { lr: 5, tb: 4 } as const;

const nodeId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,23}$/, { error: "node id must be 1-24 chars of a-z, 0-9, '-' or '_' (lowercase, starts with a letter or digit)" });

export const diagramNodeSchema = z.strictObject({
  id: nodeId.describe("Unique node id used by edges and steps"),
  label: line(LIMITS.nodeLabel, "label").describe(`Node title, max ${LIMITS.nodeLabel} chars`),
  detail: line(LIMITS.nodeDetail, "detail").optional().describe(`Second line under the label, max ${LIMITS.nodeDetail} chars`),
  tone: z.enum(NODE_TONES).optional().describe("default | accent | muted | success | error"),
});
export const diagramEdgeSchema = z.strictObject({
  from: nodeId.describe("Source node id"),
  to: nodeId.describe("Target node id"),
  label: line(LIMITS.edgeLabel, "label").optional().describe(`Short label on the arrow, max ${LIMITS.edgeLabel} chars`),
});
export const diagramStepSchema = z.strictObject({
  nodes: z.array(nodeId).min(1, { error: "a diagram step must highlight at least one node" }).max(LIMITS.maxNodes).describe("Node ids highlighted in this step; edges between highlighted nodes light up too"),
  label: line(LIMITS.diagramStepLabel, "label").optional().describe(`Caption while this step is active, max ${LIMITS.diagramStepLabel} chars`),
  durationSeconds: seconds(LIMITS.stepSeconds.min, LIMITS.stepSeconds.max, "Step duration").optional().describe("Omit for automatic timing"),
});

export const diagramSceneSchema = z
  .strictObject({
    type: z.literal("diagram"),
    ...common,
    heading: line(LIMITS.diagramHeading, "heading").optional().describe(`Heading above the diagram, max ${LIMITS.diagramHeading} chars`),
    direction: z.enum(DIAGRAM_DIRECTIONS).optional().describe("lr = left to right (default), tb = top to bottom"),
    nodes: z.array(diagramNodeSchema).min(LIMITS.minNodes, { error: `a diagram needs at least ${LIMITS.minNodes} nodes` }).max(LIMITS.maxNodes).describe(`${LIMITS.minNodes}-${LIMITS.maxNodes} nodes; placed automatically`),
    edges: z.array(diagramEdgeSchema).min(1, { error: "a diagram needs at least one edge" }).max(LIMITS.maxEdges).describe(`1-${LIMITS.maxEdges} arrows, drawn in the order given`),
    steps: z.array(diagramStepSchema).max(LIMITS.maxDiagramSteps).optional().describe(`Up to ${LIMITS.maxDiagramSteps} highlight steps shown in order`),
  })
  .superRefine((scene, ctx) => checkDiagram(scene, ctx));

type DiagramInput = {
  direction?: "lr" | "tb" | undefined;
  nodes: Array<{ id: string }>;
  edges: Array<{ from: string; to: string }>;
  steps?: Array<{ nodes: string[] }> | undefined;
};

function checkDiagram(scene: DiagramInput, ctx: z.RefinementCtx): void {
  // Structural minimums (nodes, edges) are reported by the array rules; do not pile cross-field noise on top.
  if (scene.nodes.length < LIMITS.minNodes || scene.edges.length < 1) return;
  const ids = scene.nodes.map((n) => n.id);
  const known = new Set<string>();
  scene.nodes.forEach((n, i) => {
    if (known.has(n.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["nodes", i, "id"],
        message: `duplicate node id "${n.id}"`,
        params: { suggestion: "Give every node its own id; edges and steps refer to nodes by id." },
      });
    }
    known.add(n.id);
  });
  const missing = (id: string, path: Array<string | number>): void => {
    const near = nearestId(id, ids);
    ctx.addIssue({
      code: "custom",
      path,
      message: `unknown node id "${id}"; defined ids: ${ids.join(", ")}`,
      params: { suggestion: near ? `Did you mean "${near}"?` : "Use an id from 'nodes'." },
    });
  };
  const used = new Set<string>();
  let refsOk = true;
  scene.edges.forEach((e, i) => {
    for (const end of ["from", "to"] as const) {
      if (!known.has(e[end])) {
        missing(e[end], ["edges", i, end]);
        refsOk = false;
      } else used.add(e[end]);
    }
    if (e.from === e.to) {
      ctx.addIssue({ code: "custom", path: ["edges", i], message: `edge ${i + 1} connects "${e.from}" to itself`, params: { suggestion: "Remove the self-loop; show repetition with a label instead." } });
    }
  });
  scene.steps?.forEach((s, i) =>
    s.nodes.forEach((id, k) => {
      if (!known.has(id)) {
        missing(id, ["steps", i, "nodes", k]);
        refsOk = false;
      }
    }),
  );
  if (!refsOk) return;
  scene.nodes.forEach((n, i) => {
    if (!used.has(n.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["nodes", i],
        message: `node "${n.id}" is not connected to any edge`,
        params: { suggestion: `Add an edge from or to "${n.id}", or remove the node.` },
      });
    }
  });
  const dir = scene.direction ?? "lr";
  const lay = layoutDiagram(scene.nodes, scene.edges);
  const maxLayers = MAX_DIAGRAM_LAYERS[dir];
  if (lay.layers > maxLayers) {
    ctx.addIssue({
      code: "custom",
      path: ["edges"],
      message: `the longest chain has ${lay.layers} nodes; the limit is ${maxLayers} for direction "${dir}"`,
      params: {
        limit: maxLayers,
        actual: lay.layers,
        suggestion: dir === "lr" ? "Shorten the pipeline (merge steps) or split it into two diagram scenes." : `Merge nodes, or split into two diagrams (top-down fits ${MAX_DIAGRAM_LAYERS.tb} rows).`,
      },
    });
  }
  if (lay.widest > LIMITS.maxNodesPerLayer) {
    ctx.addIssue({
      code: "custom",
      path: ["nodes"],
      message: `${lay.widest} nodes would sit side by side in one layer; the limit is ${LIMITS.maxNodesPerLayer}`,
      params: { limit: LIMITS.maxNodesPerLayer, actual: lay.widest, suggestion: "Chain some of the parallel nodes or split the diagram into two scenes." },
    });
  }
}

function nearestId(id: string, options: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const o of options) {
    const a = id.toLowerCase();
    const b = o.toLowerCase();
    // cheap edit distance without importing issues.ts (which imports this module)
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) (dp[0] as number[])[j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        (dp[i] as number[])[j] = Math.min((dp[i - 1] as number[])[j]! + 1, (dp[i] as number[])[j - 1]! + 1, (dp[i - 1] as number[])[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    const d = (dp[a.length] as number[])[b.length] as number;
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best !== undefined && bestD <= Math.max(1, Math.floor(best.length / 3)) ? best : undefined;
}

/* ------------------------------------------------------------------------------------------------
 * compare
 * ---------------------------------------------------------------------------------------------- */

export const COMPARE_MODES = ["versus", "beforeAfter"] as const;
const compareSide = z.strictObject({
  title: line(LIMITS.compareTitle, "title").describe(`Column title, max ${LIMITS.compareTitle} chars`),
  items: z
    .array(line(LIMITS.compareItem, "item"))
    .min(1, { error: "items must contain at least one entry" })
    .max(LIMITS.maxCompareItems)
    .describe(`1-${LIMITS.maxCompareItems} short points, each max ${LIMITS.compareItem} chars`),
});
export const compareSceneSchema = z
  .strictObject({
    type: z.literal("compare"),
    ...common,
    heading: line(LIMITS.compareHeading, "heading").optional().describe(`Heading above the columns, max ${LIMITS.compareHeading} chars`),
    mode: z.enum(COMPARE_MODES).optional().describe("versus (A vs B, default) | beforeAfter (left becomes right)"),
    left: compareSide.describe("Left column (A / before)"),
    right: compareSide.describe("Right column (B / after); drawn with the accent"),
    verdict: line(LIMITS.verdict, "verdict").optional().describe(`One-line conclusion shown last, max ${LIMITS.verdict} chars`),
  })
  .superRefine((scene, ctx) => {
    const a = scene.left.items.length;
    const b = scene.right.items.length;
    if (Math.abs(a - b) > 2) {
      ctx.addIssue({
        code: "custom",
        path: ["right", "items"],
        message: `the columns are unbalanced: left has ${a} items, right has ${b}`,
        params: { limit: 2, actual: Math.abs(a - b), suggestion: "Keep the item counts within 2 of each other so the columns read as a pair." },
      });
    }
  });

/* ------------------------------------------------------------------------------------------------
 * stat
 * ---------------------------------------------------------------------------------------------- */

export const statItemSchema = z.strictObject({
  value: z
    .number({ error: (iss) => (iss.code === "invalid_type" ? "value must be a finite number" : undefined) })
    .finite({ error: "value must be a finite number" })
    .min(-LIMITS.statMaxAbs)
    .max(LIMITS.statMaxAbs)
    .describe(`Number counted up from 0, |value| <= ${LIMITS.statMaxAbs}`),
  decimals: z.number().int().min(0).max(LIMITS.maxStatDecimals).optional().describe(`Digits after the decimal point, 0-${LIMITS.maxStatDecimals} (default 0)`),
  prefix: line(LIMITS.statAffix, "prefix").optional().describe(`Shown before the number (e.g. "$"), max ${LIMITS.statAffix} chars`),
  suffix: line(LIMITS.statAffix, "suffix").optional().describe(`Shown after the number (e.g. "%", "ms", "x"), max ${LIMITS.statAffix} chars`),
  label: line(LIMITS.statLabel, "label").describe(`What the number is, max ${LIMITS.statLabel} chars`),
  note: line(LIMITS.statNote, "note").optional().describe(`Small supporting line, max ${LIMITS.statNote} chars`),
});
export const statSceneSchema = z
  .strictObject({
    type: z.literal("stat"),
    ...common,
    heading: line(LIMITS.statHeading, "heading").optional().describe(`Heading above the numbers, max ${LIMITS.statHeading} chars`),
    stats: z.array(statItemSchema).min(1, { error: "stats must contain at least one number" }).max(LIMITS.maxStats).describe(`1-${LIMITS.maxStats} numbers that count up side by side`),
  })
  .superRefine((scene, ctx) => {
    scene.stats.forEach((s, i) => {
      const dec = s.decimals ?? 0;
      const scaled = Math.abs(s.value) * 10 ** dec;
      if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
        ctx.addIssue({
          code: "custom",
          path: ["stats", i, "value"],
          message: `value ${s.value} has more decimals than decimals: ${dec} can show`,
          params: { suggestion: `Set "decimals": ${Math.min(LIMITS.maxStatDecimals, dec + 1)} (or round the value).` },
        });
      }
    });
  });

/* ------------------------------------------------------------------------------------------------
 * steps
 * ---------------------------------------------------------------------------------------------- */

export const STEPS_LAYOUTS = ["horizontal", "vertical"] as const;
export const stepItemSchema = z.strictObject({
  title: line(LIMITS.stepTitle, "title").describe(`Step title, max ${LIMITS.stepTitle} chars`),
  detail: line(LIMITS.stepDetail, "detail").optional().describe(`One short sentence, max ${LIMITS.stepDetail} chars`),
});
export const stepsSceneSchema = z
  .strictObject({
    type: z.literal("steps"),
    ...common,
    heading: line(LIMITS.stepsHeading, "heading").optional().describe(`Heading above the sequence, max ${LIMITS.stepsHeading} chars`),
    layout: z.enum(STEPS_LAYOUTS).optional().describe(`horizontal timeline (default, up to ${LIMITS.maxStepsHorizontal} steps) | vertical list`),
    items: z.array(stepItemSchema).min(LIMITS.minSteps, { error: `steps needs at least ${LIMITS.minSteps} items` }).max(LIMITS.maxSteps).describe(`${LIMITS.minSteps}-${LIMITS.maxSteps} numbered steps; the active one advances`),
  })
  .superRefine((scene, ctx) => {
    if ((scene.layout ?? "horizontal") === "horizontal" && scene.items.length > LIMITS.maxStepsHorizontal) {
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: `a horizontal timeline holds at most ${LIMITS.maxStepsHorizontal} steps; got ${scene.items.length}`,
        params: { limit: LIMITS.maxStepsHorizontal, actual: scene.items.length, suggestion: `Set "layout": "vertical" (up to ${LIMITS.maxSteps} steps) or merge two steps.` },
      });
    }
  });

/* ------------------------------------------------------------------------------------------------
 * quote
 * ---------------------------------------------------------------------------------------------- */

export const quoteSceneSchema = z.strictObject({
  type: z.literal("quote"),
  ...common,
  quote: line(LIMITS.quote, "quote").describe(`The quotation without quote marks, max ${LIMITS.quote} chars`),
  author: line(LIMITS.quoteAuthor, "author").optional().describe(`Who said it, max ${LIMITS.quoteAuthor} chars`),
  role: line(LIMITS.quoteRole, "role").optional().describe(`Author's role or source, max ${LIMITS.quoteRole} chars`),
});

/* ------------------------------------------------------------------------------------------------
 * codeDiff
 * ---------------------------------------------------------------------------------------------- */

export type DiffOp = "add" | "remove" | "context";
export interface DiffLine {
  op: DiffOp;
  text: string;
}

/** Parse the unified-style `diff` text: every line starts with "+", "-" or " " (a blank line is blank context). */
export function parseDiff(diff: string): DiffLine[] {
  return diff
    .replace(/\n$/, "")
    .split("\n")
    .map((raw) => {
      const c = raw[0];
      if (c === "+") return { op: "add" as const, text: raw.slice(1) };
      if (c === "-") return { op: "remove" as const, text: raw.slice(1) };
      if (c === " ") return { op: "context" as const, text: raw.slice(1) };
      return { op: "context" as const, text: raw };
    });
}

export const codeDiffSceneSchema = z
  .strictObject({
    type: z.literal("codeDiff"),
    ...common,
    language: z.enum(CODE_LANGUAGES).describe("Syntax highlighting language"),
    fileName: line(LIMITS.fileName, "fileName").optional().describe(`Shown in the block header, max ${LIMITS.fileName} chars`),
    diff: z
      .string()
      .min(1, { error: "diff must not be empty" })
      .max(INPUT_LIMITS.maxDiffChars, {
        error: `diff is far longer than the screen can show (limit ${INPUT_LIMITS.maxDiffChars} characters = ${LIMITS.maxDiffLines} lines of ${LIMITS.maxLineChars})`,
      })
      .describe(`Unified-style lines: '+' added, '-' removed, ' ' (space) unchanged. Max ${LIMITS.maxDiffLines} lines of max ${LIMITS.maxLineChars} chars after the marker; use spaces, not tabs`),
    label: line(LIMITS.diffLabel, "label").optional().describe(`Caption under the diff, max ${LIMITS.diffLabel} chars`),
  })
  .superRefine((scene, ctx) => checkDiff(scene.diff, ctx));

function checkDiff(diff: string, ctx: z.RefinementCtx): void {
  if (diff.length > INPUT_LIMITS.maxDiffChars) return; // reported by the field's max()
  if (diff.includes("\t")) {
    ctx.addIssue({ code: "custom", path: ["diff"], message: "diff contains a tab character", params: { suggestion: "Replace tabs with spaces (2 or 4)." } });
  }
  if (diff.includes("\r")) {
    ctx.addIssue({ code: "custom", path: ["diff"], message: "diff contains a carriage return", params: { suggestion: "Use \\n line endings only." } });
  }
  const raw = diff.replace(/\n$/, "").split("\n");
  if (raw.length > LIMITS.maxDiffLines) {
    ctx.addIssue({
      code: "custom",
      path: ["diff"],
      message: `diff has ${raw.length} lines; the limit is ${LIMITS.maxDiffLines}`,
      params: { limit: LIMITS.maxDiffLines, actual: raw.length, suggestion: `Show only the changed lines plus 1-2 lines of context (max ${LIMITS.maxDiffLines}).` },
    });
  }
  raw.forEach((l, i) => {
    if (l.length > 0 && !"+- ".includes(l[0] as string)) {
      ctx.addIssue({
        code: "custom",
        path: ["diff"],
        message: `diff line ${i + 1} starts with ${JSON.stringify(l[0])}; every line must start with "+", "-" or a space`,
        params: { suggestion: `Prefix line ${i + 1} with "+" (added), "-" (removed) or a single space (unchanged).` },
      });
    } else if ([...l.slice(1)].length > LIMITS.maxLineChars) {
      ctx.addIssue({
        code: "custom",
        path: ["diff"],
        message: `diff line ${i + 1} has ${[...l.slice(1)].length} characters after the marker; the limit is ${LIMITS.maxLineChars}`,
        params: { limit: LIMITS.maxLineChars, actual: [...l.slice(1)].length, suggestion: `Break line ${i + 1} into shorter lines (max ${LIMITS.maxLineChars} chars).` },
      });
    }
  });
  const parsed = parseDiff(diff);
  if (!parsed.some((d) => d.op === "add") && !parsed.some((d) => d.op === "remove")) {
    ctx.addIssue({
      code: "custom",
      path: ["diff"],
      message: "diff has no added or removed lines",
      params: { suggestion: 'Mark changed lines with "+" or "-" at the start of the line, e.g. "-const a = 1;\\n+const a = 2;".' },
    });
  }
}

export const sceneSchema = z.discriminatedUnion("type", [
  titleSceneSchema,
  bulletsSceneSchema,
  codeSceneSchema,
  terminalSceneSchema,
  outroSceneSchema,
  introSceneSchema,
  closingSceneSchema,
  diagramSceneSchema,
  compareSceneSchema,
  statSceneSchema,
  stepsSceneSchema,
  quoteSceneSchema,
  codeDiffSceneSchema,
]);

export const SCENE_TYPES = ["title", "bullets", "code", "terminal", "outro", "intro", "closing", "diagram", "compare", "stat", "steps", "quote", "codeDiff"] as const;

export const storyboardSchema = z.strictObject({
  version: z.literal(STORYBOARD_VERSION).describe("Schema version; currently 1"),
  title: line(LIMITS.storyboardTitle, "title").describe("Storyboard title (metadata and file names; not drawn)"),
  theme: z.enum(THEME_MODES).describe("light | dark, matching the blog's two themes"),
  accent: z
    .string()
    .regex(HEX_PATTERN, { error: "accent must be a hex colour like #6366f1 or #63f" })
    .optional()
    .describe("Optional accent colour as #RGB or #RRGGBB; defaults to the blog's blue-violet. Used sparingly"),
  preset: z.enum(PRESETS).optional().describe(`Style preset: ${PRESETS.join(" | ")} (default = the blog's own minimal look). Every scene follows it; fonts and code colours stay the blog's`),
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
}).superRefine((sb, ctx) => {
  const seen = new Map<string, number>();
  sb.scenes.forEach((scene, i) => {
    if (scene.id === undefined) return;
    const first = seen.get(scene.id);
    if (first === undefined) seen.set(scene.id, i);
    else {
      ctx.addIssue({
        code: "custom",
        path: ["scenes", i, "id"],
        message: `scene id "${scene.id}" is already used by scene ${first + 1}; ids must be unique`,
        params: { suggestion: `Rename this scene's id (for example "${scene.id}-2") or remove it.` },
      });
    }
  });
});

export type Storyboard = z.output<typeof storyboardSchema>;
export type StoryboardInput = z.input<typeof storyboardSchema>;
export type Scene = Storyboard["scenes"][number];
export type TitleScene = z.output<typeof titleSceneSchema>;
export type BulletsScene = z.output<typeof bulletsSceneSchema>;
export type CodeScene = z.output<typeof codeSceneSchema>;
export type TerminalScene = z.output<typeof terminalSceneSchema>;
export type OutroScene = z.output<typeof outroSceneSchema>;
export type IntroScene = z.output<typeof introSceneSchema>;
export type ClosingScene = z.output<typeof closingSceneSchema>;
export type DiagramScene = z.output<typeof diagramSceneSchema>;
export type CompareScene = z.output<typeof compareSceneSchema>;
export type StatScene = z.output<typeof statSceneSchema>;
export type StepsScene = z.output<typeof stepsSceneSchema>;
export type QuoteScene = z.output<typeof quoteSceneSchema>;
export type CodeDiffScene = z.output<typeof codeDiffSceneSchema>;
export type ShowpieceVariant = (typeof SHOWPIECE_VARIANTS)[number];
export type SceneType = Scene["type"];
