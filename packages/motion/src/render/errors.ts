export class RenderCancelledError extends Error {
  constructor() {
    super("render cancelled");
    this.name = "RenderCancelledError";
  }
}

export class GifLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GifLimitError";
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
