/**
 * Hard limits that keep a storyboard legible and short. Every number a validation message quotes
 * comes from here, so the schema, the messages and the README cannot drift apart.
 */
export const LIMITS = {
  /** Whole video, after transitions overlap. */
  maxTotalSeconds: 60,
  maxScenes: 16,
  minSceneSeconds: 1,
  maxSceneSeconds: 30,

  storyboardTitle: 100,
  siteName: 24,

  kicker: 32,
  title: 80,
  subtitle: 120,
  maxTags: 5,
  tag: 24,

  heading: 60,
  maxBullets: 6,
  bullet: 80,

  fileName: 48,
  maxCodeLines: 14,
  maxLineChars: 72,
  maxCodeSteps: 8,
  stepLabel: 80,
  stepSeconds: { min: 1, max: 10 },

  terminalTitle: 32,
  maxTerminalLines: 12,
  maxWaitSeconds: 5,

  cta: 60,
  url: 48,

  /** diagram */
  diagramHeading: 60,
  minNodes: 2,
  maxNodes: 8,
  nodeLabel: 24,
  nodeDetail: 40,
  maxEdges: 12,
  edgeLabel: 20,
  maxDiagramSteps: 6,
  diagramStepLabel: 60,
  /** Longest chain of nodes (columns in a left-to-right diagram) and widest layer. */
  maxDiagramLayers: 5,
  maxNodesPerLayer: 4,

  /** compare */
  compareHeading: 60,
  compareTitle: 28,
  compareItem: 60,
  maxCompareItems: 5,
  verdict: 90,

  /** stat */
  statHeading: 60,
  maxStats: 3,
  statLabel: 40,
  statNote: 60,
  statAffix: 6,
  statMaxAbs: 999_999_999,
  maxStatDecimals: 2,

  /** steps */
  stepsHeading: 60,
  minSteps: 2,
  maxSteps: 6,
  maxStepsHorizontal: 5,
  stepTitle: 40,
  stepDetail: 80,

  /** quote */
  quote: 200,
  quoteAuthor: 40,
  quoteRole: 60,

  /** codeDiff */
  maxDiffLines: 14,
  diffLabel: 80,
} as const;

/** GIF is for short clips only; anything longer must be an MP4. */
export const GIF_LIMITS = {
  maxSeconds: 15,
  maxWidth: 800,
  fps: 15,
} as const;

/**
 * Input-size guards for untrusted storyboards (an assistant or a stranger writes them). Every cap is derived
 * from the display limits above, so a string that cannot possibly fit on screen is refused in O(1) before any
 * line-by-line check runs.
 */
export const INPUT_LIMITS = {
  /**
   * Raw JSON text, in bytes, refused before it is parsed. A full 16-scene storyboard is a few KiB;
   * 256 KiB leaves ample room for Uzbek (2-byte letters) and escapes.
   */
  maxStoryboardBytes: 256 * 1024,
  /** Characters (UTF-16 units, so astral glyphs count 2) a code string may have: every line at its limit, doubled for astral glyphs. */
  maxCodeChars: LIMITS.maxCodeLines * (LIMITS.maxLineChars * 2 + 1),
  /** Same for a diff: one extra character per line for the +/-/space marker. */
  maxDiffChars: LIMITS.maxDiffLines * (LIMITS.maxLineChars * 2 + 2),
  /** Validation stops reporting after this many problems (the list ends with a "more problems" note). */
  maxIssues: 40,
} as const;
