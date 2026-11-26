/**
 * The contract between the API's job runner (parent) and the render worker (child process).
 *
 * Parent -> child: ONE JSON file whose path is argv[2] (`WorkerSpec`). Nothing is passed through the environment
 * except what rendering needs (PATH, HOME/TMPDIR inside the job directory, BLOG_MOTION_CACHE_DIR); no secrets.
 * Child -> parent: JSON lines on STDOUT (`WorkerMessage`); everything else (logs) goes to stderr.
 * Exit code: 0 after a `result` line; 1 after an `error` line; the parent also treats any other exit as a crash.
 */
export type WorkerKind = "preview" | "render" | "gif";

export interface WorkerSpec {
  kind: WorkerKind;
  /** Absolute path of the storyboard JSON (re-validated inside the worker, size limit included). */
  storyboardFile: string;
  /** Absolute output directory (created). preview: stills are written here; render/gif: `<outDir>/<outName>`. */
  outDir: string;
  /** render/gif: output file name inside outDir (`video.mp4` / `clip.gif`). */
  outName?: string;
  /** Absolute bundle cache directory (outside the package, persistent across jobs). */
  cacheDir: string;
  /** Frames rendered in parallel (clamped again inside the worker). */
  concurrency?: number;
  /** Whole-job wall clock in ms; the parent enforces its own, slightly larger one and kills the process group. */
  timeoutMs?: number;
  /** Explicit browser executable (default: the managed Chrome Headless Shell installed by the setup script). */
  browserExecutable?: string;
  /** preview: seconds to capture (omit: one still per scene); width in px (default 640). */
  at?: number[];
  width?: number;
  quality?: number;
  /** Only this scene (id or 1-based position). */
  scene?: string;
  /** gif: clip window in seconds, or `loop` for a closing scene's seamless hold. */
  from?: number;
  to?: number;
  loop?: boolean;
  /**
   * Largest acceptable output file (render/gif: the video; preview: ONE still), checked as soon as the file exists so an
   * oversized result is reported before anything is uploaded or stored. Omit for no limit.
   */
  maxOutputBytes?: number;
}

export type WorkerMessage =
  | { t: "progress"; phase: string; fraction: number | null; message: string }
  | { t: "result"; kind: "preview"; stills: Array<{ file: string; seconds: number; scene: number; sceneType: string; bytes: number }>; totalSeconds: number }
  | { t: "result"; kind: "render" | "gif"; file: string; bytes: number; frames: number; seconds: number; renderMs: number }
  | { t: "error"; code: WorkerErrorCode; message: string; issues?: unknown[] };

export type WorkerErrorCode =
  | "invalid_spec"
  | "invalid_storyboard"
  | "browser_missing"
  | "timeout"
  | "cancelled"
  | "gif_limit"
  | "scene_not_found"
  | "too_large"
  | "disk_full"
  | "render_failed";
