/** Stable machine-readable codes of every typed render failure (the worker reports them to the API as-is). */
export type MotionErrorCode = "cancelled" | "timeout" | "browser_missing" | "process_not_dedicated" | "gif_limit";

/** Base class: `code` is what callers switch on; `message` is written for the operator. */
export class MotionError extends Error {
  readonly code: MotionErrorCode;
  constructor(code: MotionErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class RenderCancelledError extends MotionError {
  constructor() {
    super("cancelled", "render cancelled");
  }
}

/** The whole job (bundle, browser, frames, encode) did not finish within `timeoutMs`. */
export class RenderTimeoutError extends MotionError {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super("timeout", `render did not finish within ${Math.round(timeoutMs / 1000)} s and was stopped`);
    this.timeoutMs = timeoutMs;
  }
}

/** The headless browser is not installed and downloading it was not allowed (the default for the library). */
export class BrowserMissingError extends MotionError {
  static readonly INSTALL_HINT =
    "Install it once with `bash scripts/setup-motion-browser.sh` (or `pnpm --filter @blog/motion exec blog-motion browser install`), or pass --browser <path> / MotionRenderer browserExecutable.";
  constructor(detail?: string) {
    super("browser_missing", `Headless browser (Chrome Headless Shell) is not installed${detail ? `: ${detail}` : ""}. ${BrowserMissingError.INSTALL_HINT}`);
  }
}

/** A renderer was created in a process that did not opt in to being a dedicated render process. */
export class RendererProcessError extends MotionError {
  constructor() {
    super(
      "process_not_dedicated",
      "MotionRenderer rewrites process-wide temp-dir variables while it renders, so it only runs in a dedicated process. Call enterDedicatedRenderProcess() first (the blog-motion CLI and the render worker do), or run the render in a child process.",
    );
  }
}

export class GifLimitError extends MotionError {
  constructor(message: string) {
    super("gif_limit", message);
  }
}

export type RenderPhase = "validate" | "highlight" | "bundle" | "browser" | "stills" | "render" | "encode" | "done";

/** Progress callback payload; `fraction` is 0..1 within the phase, or null when unknown. */
export interface RenderProgress {
  phase: RenderPhase;
  fraction: number | null;
  message: string;
}
export type ProgressCallback = (p: RenderProgress) => void;
