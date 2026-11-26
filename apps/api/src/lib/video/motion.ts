import { pathToFileURL } from "node:url";
import path from "node:path";
import { motionDir } from "./paths.js";

/**
 * `@blog/motion`ning FAQAT tekshiruv qismi (zod sxema, vaqt jadvali, cheklovlar) — Remotion, brauzer, React yuklanmaydi. U
 * birinchi chaqiruvda dinamik import qilinadi (bayroq o'chiq bo'lsa umuman yuklanmaydi); render kodi API jarayoniga HECH QACHON kirmaydi.
 * Turlar bu yerda qo'lda e'lon qilingan: `@blog/motion` manbasi (`.ts` kengaytmali importlar) API'ning `tsc` build'iga kirmasligi uchun.
 */
export interface StoryboardIssue {
  path: string;
  code: string;
  message: string;
  limit?: number | string;
  actual?: number | string;
  suggestion?: string;
}

export interface SceneTiming {
  index: number;
  id?: string;
  type: string;
  startFrame: number;
  endFrame: number;
  durationFrames: number;
  explicit: boolean;
  previewFrame: number;
}

export interface MotionTimeline {
  fps: number;
  width: number;
  height: number;
  totalFrames: number;
  totalSeconds: number;
  scenes: SceneTiming[];
}

export type MotionValidation =
  | { ok: true; storyboard: Record<string, unknown> & { title: string; scenes: Array<Record<string, unknown> & { type: string; id?: string }> }; timeline: MotionTimeline }
  | { ok: false; issues: StoryboardIssue[] };

export interface MotionApi {
  validateStoryboard(input: unknown): MotionValidation;
  validateStoryboardJson(text: string): MotionValidation;
  storyboardJsonSchema(): Record<string, unknown>;
  formatIssues(issues: StoryboardIssue[]): string;
  LIMITS: Record<string, unknown>;
  GIF_LIMITS: { maxSeconds: number; maxWidth: number; fps: number };
  INPUT_LIMITS: { maxStoryboardBytes: number; maxIssues: number; maxCodeChars: number; maxDiffChars: number };
  SCENE_TYPES: readonly string[];
  SHOWPIECE_VARIANTS: readonly string[];
  PRESETS: readonly string[];
  TRANSITIONS: readonly string[];
  CODE_LANGUAGES: readonly string[];
  FPS: number;
}

let loaded: Promise<MotionApi> | null = null;
let override: MotionApi | null = null;

export function loadMotion(): Promise<MotionApi> {
  if (override) return Promise.resolve(override);
  loaded ??= import(/* @vite-ignore */ pathToFileURL(path.join(motionDir(), "src", "index.ts")).href).then((m) => m as unknown as MotionApi);
  return loaded;
}

/** Faqat testlar uchun. */
export function setMotionForTests(api: MotionApi | null): void {
  override = api;
}
