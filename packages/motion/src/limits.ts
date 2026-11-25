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
} as const;

/** GIF is for short clips only; anything longer must be an MP4. */
export const GIF_LIMITS = {
  maxSeconds: 15,
  maxWidth: 800,
  fps: 15,
} as const;
