import { layoutDiagram } from "./diagram-layout.ts";
import { FORMATS } from "./layout.ts";
import type {
  BulletsScene,
  ClosingScene,
  CodeDiffScene,
  CodeScene,
  CompareScene,
  DiagramScene,
  IntroScene,
  OutroScene,
  QuoteScene,
  Scene,
  ShowpieceVariant,
  StatScene,
  Storyboard,
  StepsScene,
  TerminalScene,
  TitleScene,
} from "./schema/storyboard.ts";
import { codeLines, parseDiff } from "./schema/storyboard.ts";
import {
  CODE_TYPE_CPS,
  CODE_TYPE_MAX_SECONDS,
  FPS,
  LOOP_FRAMES,
  readFrames,
  sec,
  TERMINAL_TYPE_CPS,
  TRANSITION_FRAMES,
  typingSchedule,
} from "./timing.ts";

/** Frames the entrance of a scene animation takes; used for "done" bookkeeping. */
const ANIM = 18;
/** Shortest beat a finished scene holds before it may be cut off. */
const MIN_HOLD = sec(0.5);

export type TransitionKind = "cut" | "fade" | "slide" | "wipe" | "push" | "zoom";

/** Content timelines. All frames are relative to the scene's content clock (local frame minus `leadFrames`). */
export interface TitleTiming {
  type: "title";
  kickerAt: number;
  titleAt: number;
  wordStep: number;
  subtitleAt: number;
  tagAt: number[];
}
export interface BulletsTiming {
  type: "bullets";
  headingAt: number;
  itemAt: number[];
}
export interface CodeTiming {
  type: "code";
  cardAt: number;
  /** Per-character appearance frames; null when `typing` is off. */
  typing: { startAt: number; schedule: number[] } | null;
  /** Active highlight windows; `moveFrames` is how long the band takes to travel to the step. */
  steps: Array<{ start: number; end: number; from: number; to: number }>;
  moveFrames: number;
}
export interface TerminalEntryTiming {
  /** Frame the entry starts (typing start for commands, appearance for outputs). */
  startAt: number;
  /** Commands only: per-character schedule relative to startAt. */
  schedule: number[] | null;
  /** Commands only: frame the "enter" is pressed (typing ended + beat). */
  enterAt: number | null;
}
export interface TerminalTiming {
  type: "terminal";
  cardAt: number;
  entries: TerminalEntryTiming[];
}
export interface OutroTiming {
  type: "outro";
  markAt: number;
  ctaAt: number;
  urlAt: number;
}
export interface IntroTiming {
  type: "intro";
  variant: ShowpieceVariant;
  kickerAt: number;
  titleAt: number;
  wordStep: number;
  subtitleAt: number;
  tagAt: number[];
}
export interface ClosingTiming {
  type: "closing";
  variant: ShowpieceVariant;
  markAt: number;
  ctaAt: number;
  urlAt: number;
  /** Ambient motion period in frames; the final hold is one period long. */
  loopFrames: number;
}
export interface DiagramTiming {
  type: "diagram";
  headingAt: number;
  /** Per node (storyboard order): frame it appears. */
  nodeAt: number[];
  /** Per edge (storyboard order): frame its line starts to draw, and how long drawing takes. */
  edgeAt: number[];
  edgeFrames: number;
  steps: Array<{ start: number; end: number; nodes: string[] }>;
}
export interface CompareTiming {
  type: "compare";
  headingAt: number;
  leftTitleAt: number;
  rightTitleAt: number;
  leftItemAt: number[];
  rightItemAt: number[];
  verdictAt: number;
}
export interface StatTiming {
  type: "stat";
  headingAt: number;
  statAt: number[];
  countFrames: number;
}
export interface StepsTiming {
  type: "steps";
  headingAt: number;
  /** Frame step i becomes the active one (it stays active until step i+1 takes over). */
  activeAt: number[];
}
export interface QuoteTiming {
  type: "quote";
  quoteAt: number;
  wordStep: number;
  authorAt: number;
}
export interface CodeDiffTiming {
  type: "codeDiff";
  cardAt: number;
  /** Frame the removed lines get their red mark. */
  removeAt: number;
  /** Per line: frame an added line slides in (null for other lines). */
  addAt: Array<number | null>;
  labelAt: number;
}
export type ContentTiming =
  | TitleTiming
  | BulletsTiming
  | CodeTiming
  | TerminalTiming
  | OutroTiming
  | IntroTiming
  | ClosingTiming
  | DiagramTiming
  | CompareTiming
  | StatTiming
  | StepsTiming
  | QuoteTiming
  | CodeDiffTiming;

export interface SceneTiming {
  index: number;
  id: string | null;
  type: Scene["type"];
  startFrame: number;
  endFrame: number;
  durationFrames: number;
  enter: { kind: TransitionKind; frames: number };
  /** Transition into the NEXT scene (overlaps this scene's last frames). */
  exit: { kind: TransitionKind; frames: number };
  /** Frames between scene start and content-clock zero (half of the entering overlap). */
  leadFrames: number;
  /** Content-clock frame at which the last animation has settled. */
  doneAt: number;
  /** Duration the engine would pick on its own (no explicit durationSeconds). */
  autoFrames: number;
  /** Shortest legal duration for this scene's content. */
  minFrames: number;
  explicit: boolean;
  content: ContentTiming;
  /** Absolute frame of the best still for a preview of this scene. */
  previewFrame: number;
  /** Closing scenes: the last LOOP_FRAMES frames of the settled hold; a GIF of exactly this range loops seamlessly. */
  loop: { startFrame: number; frames: number } | null;
}

export interface Timeline {
  fps: number;
  width: number;
  height: number;
  totalFrames: number;
  totalSeconds: number;
  scenes: SceneTiming[];
}

interface ContentPlan {
  content: ContentTiming;
  doneAt: number;
  /** Natural hold after doneAt before the scene may end (reading time). */
  hold: number;
  /** Bounds for the automatic content duration (doneAt + hold), seconds. */
  clampSeconds: [number, number];
  /** Content-clock frame of the preview still. */
  previewAt: number;
}

function planTitle(s: TitleScene): ContentPlan {
  const words = s.title.split(/\s+/).length;
  const wordStep = 3;
  const kickerAt = 0;
  const titleAt = s.kicker ? 8 : 0;
  let t = titleAt + words * wordStep + ANIM - 6;
  const subtitleAt = t;
  if (s.subtitle) t += 14;
  const tagAt: number[] = [];
  for (let i = 0; i < (s.tags?.length ?? 0); i++) tagAt.push(t + i * 5);
  const done = Math.max(subtitleAt + (s.subtitle ? ANIM : 0), (tagAt.at(-1) ?? 0) + ANIM, titleAt + words * wordStep + ANIM);
  const read = readFrames(s.title.length + (s.subtitle?.length ?? 0));
  return {
    content: { type: "title", kickerAt, titleAt, wordStep, subtitleAt, tagAt },
    doneAt: done,
    hold: Math.max(sec(0.9), read - done + sec(0.6)),
    clampSeconds: [3, 8],
    previewAt: done + 4,
  };
}

/** Frames between two bullet reveals: room to read the previous one. */
export function bulletGap(prevChars: number): number {
  return Math.min(72, Math.max(30, 20 + Math.round(readFrames(prevChars) * 0.35)));
}

function planBullets(s: BulletsScene): ContentPlan {
  const itemAt: number[] = [];
  let t = 14;
  s.items.forEach((item, i) => {
    itemAt.push(t);
    t += bulletGap(item.length);
    void i;
  });
  const last = s.items.at(-1) ?? "";
  const done = (itemAt.at(-1) ?? 0) + ANIM;
  return {
    content: { type: "bullets", headingAt: 0, itemAt },
    doneAt: done,
    hold: Math.max(sec(1.2), Math.round(readFrames(last.length) * 0.8)),
    clampSeconds: [4, 24],
    previewAt: done + 6,
  };
}

/**
 * Typing schedule of a code scene (frames from typing start). Rhythm first (jitter, beats after words
 * and lines); if the whole snippet would take longer than CODE_TYPE_MAX_SECONDS the schedule is
 * compressed uniformly, so long snippets type faster instead of dragging on.
 */
export function codeTypingSchedule(code: string): number[] {
  const raw = typingSchedule(code, { cps: CODE_TYPE_CPS, newlinePause: 6, wordPause: 1.5, instantIndent: true, seed: 11 });
  const cap = CODE_TYPE_MAX_SECONDS * FPS;
  const last = raw.at(-1) ?? 0;
  if (last <= cap) return raw;
  const k = cap / last;
  return raw.map((t) => t * k);
}

/** Automatic length of one highlight step in frames. */
export function autoStepFrames(lineCount: number, labelChars: number): number {
  return Math.min(sec(8), Math.max(sec(2), sec(1.4) + sec(0.25) * lineCount + readFrames(labelChars)));
}

function planCode(s: CodeScene): ContentPlan {
  const cardAt = 0;
  const lines = codeLines(s.code);
  let typing: CodeTiming["typing"] = null;
  let t = 26;
  if (s.typing) {
    const schedule = codeTypingSchedule(s.code);
    typing = { startAt: 14, schedule };
    t = 14 + Math.ceil(schedule.at(-1) ?? 0) + 14;
  }
  const steps: CodeTiming["steps"] = [];
  for (const st of s.steps ?? []) {
    const count = Math.max(1, st.lines.to - st.lines.from + 1);
    const dur = st.durationSeconds !== undefined ? sec(st.durationSeconds) : autoStepFrames(count, st.label?.length ?? 0);
    steps.push({ start: t, end: t + dur, from: st.lines.from, to: Math.min(st.lines.to, lines.length) });
    t += dur;
  }
  let done: number;
  let hold: number;
  let previewAt: number;
  if (steps.length > 0) {
    done = t;
    hold = 0;
    const mid = steps[Math.floor((steps.length - 1) / 2)] as (typeof steps)[number];
    previewAt = mid.start + 24;
  } else {
    done = t;
    hold = sec(1.6) + sec(0.2) * lines.length;
    previewAt = done;
  }
  return {
    content: { type: "code", cardAt, typing, steps, moveFrames: 16 },
    doneAt: done,
    hold,
    clampSeconds: [4, 40],
    previewAt,
  };
}

/** Typing schedule of a terminal command (frames from typing start). */
export function commandTypingSchedule(text: string, seed: number): number[] {
  return typingSchedule(text, { cps: TERMINAL_TYPE_CPS, newlinePause: 0, wordPause: 3, instantIndent: false, seed: 31 + seed });
}

function planTerminal(s: TerminalScene): ContentPlan {
  const entries: TerminalEntryTiming[] = [];
  let t = 14;
  let prevWasOutput = false;
  s.lines.forEach((l, i) => {
    t += l.waitSeconds !== undefined ? sec(l.waitSeconds) : 0;
    if (l.kind === "command") {
      if (prevWasOutput) t += 16;
      const schedule = commandTypingSchedule(l.text, i);
      const enterAt = t + Math.ceil(schedule.at(-1) ?? 0) + 10;
      entries.push({ startAt: t, schedule, enterAt });
      t = enterAt + 12;
      prevWasOutput = false;
    } else {
      entries.push({ startAt: t, schedule: null, enterAt: null });
      t += 6;
      prevWasOutput = true;
    }
  });
  const done = t + 8;
  return {
    content: { type: "terminal", cardAt: 0, entries },
    doneAt: done,
    hold: sec(1.6),
    clampSeconds: [4, 40],
    previewAt: done,
  };
}

function planOutro(_s: OutroScene): ContentPlan {
  void _s;
  const done = 28 + ANIM;
  return {
    content: { type: "outro", markAt: 0, ctaAt: 10, urlAt: 28 },
    doneAt: done,
    hold: sec(2.2),
    clampSeconds: [3, 8],
    previewAt: done + 6,
  };
}


function planIntro(s: IntroScene): ContentPlan {
  const words = s.title.split(/\s+/).length;
  const kickerAt = 6;
  const titleAt = 14;
  const wordStep = 4;
  const titleDone = titleAt + words * wordStep + 22;
  const subtitleAt = titleDone - 6;
  let t = s.subtitle ? subtitleAt + 22 : titleDone - 4;
  const tagAt: number[] = [];
  for (let i = 0; i < (s.tags?.length ?? 0); i++) tagAt.push(t + i * 5);
  t = (tagAt.at(-1) ?? t) + 18;
  const done = Math.max(78, t);
  const read = readFrames(s.title.length + (s.subtitle?.length ?? 0));
  return {
    content: { type: "intro", variant: s.variant ?? "aurora", kickerAt, titleAt, wordStep, subtitleAt, tagAt },
    doneAt: done,
    hold: Math.max(sec(1.2), read - done + sec(0.6)),
    clampSeconds: [3.5, 8],
    previewAt: done + 4,
  };
}

function planClosing(s: ClosingScene): ContentPlan {
  const done = 76;
  return {
    content: { type: "closing", variant: s.variant ?? "aurora", markAt: 0, ctaAt: 16, urlAt: 46, loopFrames: LOOP_FRAMES },
    doneAt: done,
    hold: LOOP_FRAMES,
    clampSeconds: [3.5, 8],
    previewAt: done + 8,
  };
}

/** Frames a diagram edge takes to draw. */
const EDGE_FRAMES = 20;

function planDiagram(s: DiagramScene): ContentPlan {
  const lay = layoutDiagram(s.nodes, s.edges);
  const edgeAt: number[] = [];
  s.edges.forEach((_e, i) => edgeAt.push(18 + i * 22));
  const nodeAt = s.nodes.map((n) => {
    const incoming = s.edges.map((e, i) => (e.to === n.id && !lay.backEdges.includes(i) ? i : -1)).filter((i) => i >= 0);
    if (incoming.length === 0) return 4 + (lay.place[n.id]?.slot ?? 0) * 4;
    return Math.min(...incoming.map((i) => (edgeAt[i] as number) + EDGE_FRAMES - 4));
  });
  const drawn = (edgeAt.at(-1) ?? 0) + EDGE_FRAMES + 10;
  let t = drawn;
  const steps: DiagramTiming["steps"] = [];
  for (const st of s.steps ?? []) {
    const dur = st.durationSeconds !== undefined ? sec(st.durationSeconds) : Math.min(sec(7), Math.max(sec(2.2), sec(1.4) + readFrames(st.label?.length ?? 0)));
    steps.push({ start: t, end: t + dur, nodes: st.nodes });
    t += dur;
  }
  const done = t;
  return {
    content: { type: "diagram", headingAt: 0, nodeAt, edgeAt, edgeFrames: EDGE_FRAMES, steps },
    doneAt: done,
    hold: steps.length > 0 ? 0 : sec(1.8) + sec(0.1) * s.edges.length,
    clampSeconds: [4, 30],
    previewAt: steps.length > 0 ? (steps[Math.floor((steps.length - 1) / 2)] as (typeof steps)[number]).start + 24 : done + 6,
  };
}

function planCompare(s: CompareScene): ContentPlan {
  const n = Math.max(s.left.items.length, s.right.items.length);
  const leftTitleAt = 8;
  const rightTitleAt = 18;
  const leftItemAt: number[] = [];
  const rightItemAt: number[] = [];
  for (let i = 0; i < n; i++) {
    leftItemAt.push(34 + i * 22);
    rightItemAt.push(34 + i * 22 + 11);
  }
  const lastItem = Math.max(leftItemAt[s.left.items.length - 1] ?? 0, rightItemAt[s.right.items.length - 1] ?? 0);
  const verdictAt = lastItem + 26;
  const done = (s.verdict ? verdictAt : lastItem) + ANIM + 4;
  return {
    content: { type: "compare", headingAt: 0, leftTitleAt, rightTitleAt, leftItemAt, rightItemAt, verdictAt },
    doneAt: done,
    hold: Math.max(sec(1.6), readFrames(s.verdict?.length ?? 24)),
    clampSeconds: [4, 20],
    previewAt: done + 6,
  };
}

/** Frames a stat number takes to count up. */
const COUNT_FRAMES = 54;

function planStat(s: StatScene): ContentPlan {
  const statAt = s.stats.map((_x, i) => 14 + i * 16);
  const done = (statAt.at(-1) ?? 0) + COUNT_FRAMES + 8;
  return {
    content: { type: "stat", headingAt: 0, statAt, countFrames: COUNT_FRAMES },
    doneAt: done,
    hold: sec(1.8),
    clampSeconds: [4, 12],
    previewAt: done + 4,
  };
}

function planSteps(s: StepsScene): ContentPlan {
  const activeAt: number[] = [];
  let t = 20;
  s.items.forEach((it) => {
    activeAt.push(t);
    t += Math.min(100, Math.max(48, readFrames(it.title.length + (it.detail?.length ?? 0)) + 24));
  });
  const last = s.items.at(-1);
  const done = (activeAt.at(-1) ?? 0) + 26;
  return {
    content: { type: "steps", headingAt: 0, activeAt },
    doneAt: done,
    hold: Math.max(sec(1.4), Math.round(readFrames((last?.title.length ?? 0) + (last?.detail?.length ?? 0)) * 0.8)),
    clampSeconds: [4, 24],
    previewAt: (activeAt[Math.floor((activeAt.length - 1) / 2)] ?? 0) + 24,
  };
}

function planQuote(s: QuoteScene): ContentPlan {
  const words = s.quote.split(/\s+/).length;
  const quoteAt = 10;
  const wordStep = 2;
  const wordsDone = quoteAt + words * wordStep + 20;
  const authorAt = wordsDone - 6;
  const done = authorAt + (s.author ?? s.role ? ANIM + 6 : 0) + 6;
  return {
    content: { type: "quote", quoteAt, wordStep, authorAt },
    doneAt: Math.max(done, wordsDone),
    hold: Math.max(sec(1.6), Math.round(readFrames(s.quote.length) * 0.7)),
    clampSeconds: [4, 14],
    previewAt: Math.max(done, wordsDone) + 4,
  };
}

function planCodeDiff(s: CodeDiffScene): ContentPlan {
  const parsed = parseDiff(s.diff);
  const cardAt = 0;
  const removeAt = parsed.some((l) => l.op === "remove") ? 40 : 28;
  let t = parsed.some((l) => l.op === "remove") ? removeAt + 30 : removeAt;
  const addAt = parsed.map((l) => {
    if (l.op !== "add") return null;
    const at = t;
    t += 9;
    return at;
  });
  const labelAt = t + 6;
  const done = (s.label ? labelAt + ANIM : t + ANIM) + 6;
  return {
    content: { type: "codeDiff", cardAt, removeAt, addAt, labelAt },
    doneAt: done,
    hold: sec(1.8) + sec(0.1) * parsed.length + (s.label ? readFrames(s.label.length) : 0),
    clampSeconds: [4, 20],
    previewAt: done,
  };
}

export function planScene(scene: Scene): ContentPlan {
  switch (scene.type) {
    case "title":
      return planTitle(scene);
    case "bullets":
      return planBullets(scene);
    case "code":
      return planCode(scene);
    case "terminal":
      return planTerminal(scene);
    case "outro":
      return planOutro(scene);
    case "intro":
      return planIntro(scene);
    case "closing":
      return planClosing(scene);
    case "diagram":
      return planDiagram(scene);
    case "compare":
      return planCompare(scene);
    case "stat":
      return planStat(scene);
    case "steps":
      return planSteps(scene);
    case "quote":
      return planQuote(scene);
    case "codeDiff":
      return planCodeDiff(scene);
  }
}

function enterKindOf(sb: Storyboard, i: number): TransitionKind {
  if (i === 0) return "cut";
  return (sb.scenes[i] as Scene).transition ?? sb.defaultTransition;
}

function loopRange(content: ContentTiming, startFrame: number, lead: number, doneAt: number, endFrame: number, exit: number): SceneTiming["loop"] {
  if (content.type !== "closing") return null;
  const frames = content.loopFrames;
  const from = endFrame - exit - frames;
  return from >= startFrame + lead + doneAt ? { startFrame: from, frames } : null;
}

/**
 * Pure timeline: per-scene start/end frames and the total length, no rendering. Does NOT enforce
 * limits (validate.ts does); it computes whatever the storyboard says so errors can quote numbers.
 */
export function computeTimeline(sb: Storyboard): Timeline {
  const format = FORMATS[sb.format];
  const scenes: SceneTiming[] = [];
  let prevEnd = 0;
  sb.scenes.forEach((scene, i) => {
    const enterKind = enterKindOf(sb, i);
    const enterFrames = TRANSITION_FRAMES[enterKind];
    const nextKind = i + 1 < sb.scenes.length ? enterKindOf(sb, i + 1) : "cut";
    const exitFrames = TRANSITION_FRAMES[nextKind];
    const leadFrames = Math.round(enterFrames / 2);
    const plan = planScene(scene);
    const [minS, maxS] = plan.clampSeconds;
    const contentAuto = Math.min(sec(maxS), Math.max(sec(minS), plan.doneAt + plan.hold));
    const autoFrames = leadFrames + contentAuto + exitFrames;
    const minFrames = leadFrames + plan.doneAt + MIN_HOLD + exitFrames;
    const explicit = scene.durationSeconds !== undefined;
    const durationFrames = explicit ? sec(scene.durationSeconds as number) : Math.max(autoFrames, minFrames);
    const startFrame = i === 0 ? 0 : prevEnd - enterFrames;
    const endFrame = startFrame + durationFrames;
    const previewFrame = Math.min(endFrame - exitFrames - 1, startFrame + leadFrames + plan.previewAt);
    scenes.push({
      index: i,
      id: scene.id ?? null,
      type: scene.type,
      startFrame,
      endFrame,
      durationFrames,
      enter: { kind: enterKind, frames: enterFrames },
      exit: { kind: nextKind, frames: exitFrames },
      leadFrames,
      doneAt: plan.doneAt,
      autoFrames: Math.max(autoFrames, minFrames),
      minFrames,
      explicit,
      content: plan.content,
      previewFrame: Math.max(startFrame, previewFrame),
      loop: loopRange(plan.content, startFrame, leadFrames, plan.doneAt, endFrame, exitFrames),
    });
    prevEnd = endFrame;
  });
  const totalFrames = prevEnd;
  return {
    fps: FPS,
    width: format.width,
    height: format.height,
    totalFrames,
    totalSeconds: totalFrames / FPS,
    scenes,
  };
}
