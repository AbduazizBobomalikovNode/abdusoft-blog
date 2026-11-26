/**
 * Contract between the GitHub-hosted runner script (`github-main.ts`) and the blog API (`/runner/video/jobs/:id/...`).
 * The API keeps a copy of the shapes it needs (it must never import this package); both sides are covered by tests.
 *
 * Authentication: `Authorization: Bearer <hex HMAC-SHA256(VIDEO_RUNNER_SECRET, jobId)>`. The long-lived secret never leaves the runner.
 *
 *   POST  .../claim                    { runId, attempt }          -> ClaimResponse
 *   POST  .../progress                 { phase, fraction, message }-> { cancel: boolean }
 *   PUT   .../files/:name/parts/:n     raw bytes (<= partBytes), header x-part-sha256 -> { ok: true }
 *   POST  .../files/:name/complete     { parts, bytes, sha256 }    -> { ok: true }
 *   POST  .../complete                 CompleteBody                -> { ok: true }
 *   POST  .../fail                     { code, message }           -> { ok: true }
 */
import { createHmac } from "node:crypto";

/** Per-job bearer token: only a holder of the secret can compute it, and a token for one job is useless for another. */
export const runnerToken = (secret: string, jobId: string): string => createHmac("sha256", secret).update(jobId).digest("hex");

export const MIN_SECRET_CHARS = 32;

export interface ClaimFile {
  name: string;
  maxBytes: number;
}

export interface ClaimResponse {
  kind: "preview" | "render" | "gif";
  storyboard: unknown;
  options: { at?: number[]; scene?: string; width?: number; from?: number; to?: number; loop?: boolean };
  /** Whole-job render clock (seconds), counted by the runner after the bundle is ready. */
  timeoutSeconds: number;
  concurrency: number;
  partBytes: number;
  /** Upper bound on the number of preview frames the runner may upload. */
  maxFiles: number;
  /** Output file name and size limit: render `video.mp4`, gif `clip.gif`; preview frames use `still-<n>.jpg`. */
  stillMaxBytes: number;
  videoName: string | null;
  videoMaxBytes: number;
}

export interface CompleteBody {
  kind: "preview" | "render" | "gif";
  /** preview: one entry per uploaded frame, in order. */
  stills?: Array<{ name: string; seconds: number; scene: number; sceneType: string }>;
  /** render/gif. */
  video?: { name: string; seconds: number; frames: number; renderMs: number };
  timings: { renderMs: number; uploadMs: number };
}

/** Failure codes a runner may report; anything else is stored as `runner_failed`. */
export const RUNNER_FAIL_CODES = ["engine_mismatch", "invalid_storyboard", "render_failed", "browser_missing", "timeout", "cancelled", "gif_limit", "scene_not_found", "too_large", "disk_full", "upload_failed", "runner_internal"] as const;
export type RunnerFailCode = (typeof RUNNER_FAIL_CODES)[number];
