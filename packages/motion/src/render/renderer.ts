import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { GIF_LIMITS } from "../limits.ts";
import { COMPOSITION_ID } from "../props.ts";
import type { Storyboard } from "../schema/storyboard.ts";
import type { Timeline } from "../timeline.ts";
import { FPS } from "../timing.ts";
import { assertStoryboard } from "../validate.ts";
import { ensureBundle, type BundleResult } from "./bundle.ts";
import { type ProgressCallback, RenderCancelledError } from "./errors.ts";
import { checkGifRange } from "./gif-limits.ts";
import { withPrivateTmp } from "./private-tmp.ts";
import { DEFAULT_CACHE_DIR } from "./paths.ts";
import { prepareRenderProps } from "./prepare.ts";

type Renderer = typeof import("@remotion/renderer");
type Browser = Awaited<ReturnType<Renderer["openBrowser"]>>;
type Composition = Awaited<ReturnType<Renderer["selectComposition"]>>;

export interface MotionRendererOptions {
  /** Where the Remotion bundle cache lives (default packages/motion/.cache, or BLOG_MOTION_CACHE_DIR). */
  cacheDir?: string;
  /** Use this browser instead of Remotion's managed Chrome Headless Shell. */
  browserExecutable?: string;
  onProgress?: ProgressCallback;
  /** Abort to cancel: the browser and encoder are stopped and temp output is removed. */
  signal?: AbortSignal;
  /** Frames rendered in parallel (default: Remotion's choice, about half the cores). */
  concurrency?: number;
  /** Override the theme of the storyboard (fixtures are rendered in both modes). */
  themeOverride?: "light" | "dark";
}

export interface StillRequest {
  /** Directory the JPEGs are written to (created). */
  outDir: string;
  /** Seconds to capture; omit (or pass auto) for one still per scene at its most informative moment. */
  at?: number[];
  /** JPEG quality 1-100 (default 80). */
  quality?: number;
  /** Output width in px (default 960 = half of 1920). */
  width?: number;
}

export interface StillResult {
  file: string;
  frame: number;
  seconds: number;
  /** Scene index the frame belongs to. */
  scene: number;
  sceneType: string;
  bytes: number;
}

export interface VideoResult {
  file: string;
  bytes: number;
  frames: number;
  seconds: number;
  renderMs: number;
}

export interface GifRequest {
  /** Clip start/end in seconds within the storyboard (default: whole storyboard). */
  from?: number;
  to?: number;
}

interface Session {
  storyboard: Storyboard;
  timeline: Timeline;
  composition: Composition;
  props: Record<string, unknown>;
  serveUrl: string;
  browser: Browser;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/**
 * Programmatic rendering API. One instance keeps one bundle and ONE browser alive across stills and
 * videos; call `close()` (always, in a finally) to stop the browser and delete temp files.
 */
export class MotionRenderer {
  readonly #opts: MotionRendererOptions;
  readonly #cancel: { cancelSignal: import("@remotion/renderer").CancelSignal; cancel: () => void };
  #renderer: Renderer | null = null;
  #bundle: BundleResult | null = null;
  #browser: Browser | null = null;
  #tmpFiles = new Set<string>();
  #closed = false;
  #onAbort: (() => void) | null = null;

  private constructor(opts: MotionRendererOptions, renderer: Renderer) {
    this.#opts = opts;
    this.#renderer = renderer;
    this.#cancel = renderer.makeCancelSignal();
    if (opts.signal) {
      this.#onAbort = () => this.#cancel.cancel();
      if (opts.signal.aborted) this.#onAbort();
      else opts.signal.addEventListener("abort", this.#onAbort, { once: true });
    }
  }

  static async create(opts: MotionRendererOptions = {}): Promise<MotionRenderer> {
    return new MotionRenderer(opts, await import("@remotion/renderer"));
  }

  get #r(): Renderer {
    if (!this.#renderer) throw new Error("renderer closed");
    return this.#renderer;
  }

  #check(): void {
    if (this.#closed) throw new Error("MotionRenderer is closed");
    if (this.#opts.signal?.aborted) throw new RenderCancelledError();
  }

  #emit(phase: Parameters<ProgressCallback>[0]["phase"], fraction: number | null, message: string): void {
    this.#opts.onProgress?.({ phase, fraction, message });
  }

  /** Bundle (cached by source hash) and open the shared browser. */
  async warmUp(): Promise<{ bundle: BundleResult }> {
    this.#check();
    if (!this.#bundle) {
      this.#emit("bundle", 0, "bundling composition");
      this.#bundle = await ensureBundle(this.#opts.cacheDir ?? DEFAULT_CACHE_DIR, (f) => this.#emit("bundle", f, "bundling composition"));
      this.#emit("bundle", 1, this.#bundle.cached ? "bundle cache hit" : `bundled in ${(this.#bundle.ms / 1000).toFixed(1)} s`);
    }
    if (!this.#browser) {
      this.#emit("browser", 0, "opening browser");
      if (!this.#opts.browserExecutable) {
        await this.#r.ensureBrowser({
          logLevel: "error",
          onBrowserDownload: () => {
            this.#emit("browser", null, "downloading Chrome Headless Shell (first run only)");
            return { version: null, onProgress: ({ percent }: { percent: number }) => this.#emit("browser", percent, "downloading Chrome Headless Shell") };
          },
        });
      }
      this.#check();
      // Remotion's browser launcher installs a SIGINT listener that kills the browser and calls
      // process.exit(130) at once, which skips our cleanup (temp files, partial output). Remove exactly the
      // listeners it adds: cancellation goes through `signal`, and the launcher's own 'exit' hook still
      // kills the browser when the process ends.
      const before = new Set(process.listeners("SIGINT"));
      this.#browser = await this.#r.openBrowser("chrome", {
        chromeMode: "headless-shell",
        logLevel: "error",
        ...(this.#opts.browserExecutable ? { browserExecutable: this.#opts.browserExecutable } : {}),
      });
      for (const l of process.listeners("SIGINT")) if (!before.has(l)) process.removeListener("SIGINT", l);
      this.#emit("browser", 1, "browser ready");
    }
    return { bundle: this.#bundle };
  }

  #withTheme(input: unknown): unknown {
    return this.#opts.themeOverride && input && typeof input === "object" ? { ...(input as object), theme: this.#opts.themeOverride } : input;
  }

  async #session(input: unknown): Promise<Session> {
    this.#emit("validate", 0, "validating storyboard");
    const { storyboard, timeline } = assertStoryboard(this.#withTheme(input));
    this.#emit("highlight", 0, "highlighting code");
    const props = (await prepareRenderProps(storyboard)) as unknown as Record<string, unknown>;
    const { bundle } = await this.warmUp();
    const browser = this.#browser as Browser;
    const composition = await this.#r.selectComposition({
      serveUrl: bundle.serveUrl,
      id: COMPOSITION_ID,
      inputProps: props,
      puppeteerInstance: browser,
      chromeMode: "headless-shell",
      logLevel: "error",
    });
    if (composition.durationInFrames !== timeline.totalFrames) {
      throw new Error(`timeline mismatch: Node computed ${timeline.totalFrames} frames, the composition ${composition.durationInFrames}`);
    }
    return { storyboard, timeline, composition, props, serveUrl: bundle.serveUrl, browser };
  }

  /** Small JPEG stills (default 960x540) for sending back to an assistant as images. */
  async stills(input: unknown, req: StillRequest): Promise<StillResult[]> {
    this.#check();
    const s = await this.#session(input);
    mkdirSync(req.outDir, { recursive: true });
    const width = req.width ?? 960;
    const scale = width / s.timeline.width;
    const targets: Array<{ frame: number; scene: number; name: string }> = [];
    if (req.at && req.at.length > 0) {
      for (const sec of req.at) {
        const frame = Math.min(s.timeline.totalFrames - 1, Math.max(0, Math.round(sec * FPS)));
        const scene = s.timeline.scenes.findLast((t) => frame >= t.startFrame + t.leadFrames)?.index ?? 0;
        targets.push({ frame, scene, name: `at-${(frame / FPS).toFixed(2).padStart(6, "0")}s` });
      }
    } else {
      for (const t of s.timeline.scenes) targets.push({ frame: t.previewFrame, scene: t.index, name: `scene-${pad(t.index + 1)}-${t.id ?? t.type}` });
    }
    const out: StillResult[] = [];
    for (const [i, tg] of targets.entries()) {
      this.#check();
      this.#emit("stills", i / targets.length, `still ${i + 1}/${targets.length}`);
      const file = path.join(req.outDir, `${tg.name}.jpg`);
      this.#tmpFiles.add(file);
      await this.#guard(() =>
        this.#r.renderStill({
          composition: s.composition,
          serveUrl: s.serveUrl,
          output: file,
          frame: tg.frame,
          imageFormat: "jpeg",
          jpegQuality: req.quality ?? 80,
          scale,
          inputProps: s.props,
          puppeteerInstance: s.browser,
          chromeMode: "headless-shell",
          logLevel: "error",
          overwrite: true,
          cancelSignal: this.#cancel.cancelSignal,
        }),
      );
      this.#tmpFiles.delete(file);
      out.push({ file, frame: tg.frame, seconds: tg.frame / FPS, scene: tg.scene, sceneType: (s.timeline.scenes[tg.scene] as { type: string }).type, bytes: statSync(file).size });
    }
    this.#emit("stills", 1, `${out.length} stills written`);
    return out;
  }

  /** Silent H.264 MP4: yuv420p, constant 30 fps, faststart (moov first), no audio track. */
  async video(input: unknown, outFile: string): Promise<VideoResult> {
    this.#check();
    const s = await this.#session(input);
    return this.#encode(s, outFile, { codec: "h264" }, 0, s.timeline.totalFrames - 1);
  }

  /** GIF for short clips only (<= 15 s, <= 800 px wide, 15 fps). Longer: GifLimitError, use video(). */
  async gif(input: unknown, outFile: string, req: GifRequest = {}): Promise<VideoResult> {
    this.#check();
    // Limits are checked on the pure timeline, before any bundling or browser work.
    const range = checkGifRange(assertStoryboard(this.#withTheme(input)).timeline, req);
    const s = await this.#session(input);
    return this.#encode(s, outFile, { codec: "gif" }, range.startFrame, range.endFrame);
  }

  async #encode(
    s: Session,
    outFile: string,
    kind: { codec: "h264" | "gif" },
    startFrame: number,
    endFrame: number,
  ): Promise<VideoResult> {
    mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    const tmp = `${outFile}.tmp-${process.pid}${path.extname(outFile)}`;
    this.#tmpFiles.add(tmp);
    const t0 = Date.now();
    const total = endFrame - startFrame + 1;
    const isGif = kind.codec === "gif";
    await this.#guard(() =>
      this.#r.renderMedia({
        composition: s.composition,
        serveUrl: s.serveUrl,
        inputProps: s.props,
        outputLocation: tmp,
        overwrite: true,
        puppeteerInstance: s.browser,
        chromeMode: "headless-shell",
        logLevel: "error",
        cancelSignal: this.#cancel.cancelSignal,
        frameRange: [startFrame, endFrame],
        ...(this.#opts.concurrency ? { concurrency: this.#opts.concurrency } : {}),
        ...(isGif
          ? {
              codec: "gif" as const,
              everyNthFrame: FPS / GIF_LIMITS.fps,
              scale: Math.min(1, GIF_LIMITS.maxWidth / s.timeline.width),
              numberOfGifLoops: null,
            }
          : {
              codec: "h264" as const,
              pixelFormat: "yuv420p" as const,
              crf: 17,
              x264Preset: "medium" as const,
              colorSpace: "bt709" as const,
              imageFormat: "jpeg" as const,
              jpegQuality: 95,
              muted: true,
              enforceAudioTrack: false,
            }),
        onProgress: (p) => this.#emit(p.encodedFrames >= p.renderedFrames && p.progress >= 1 ? "encode" : "render", p.progress, `${isGif ? "gif" : "mp4"} frame ${Math.min(p.renderedFrames, total)}/${total}`),
      }),
    );
    renameSync(tmp, outFile);
    this.#tmpFiles.delete(tmp);
    this.#emit("done", 1, path.basename(outFile));
    return { file: outFile, bytes: statSync(outFile).size, frames: total, seconds: total / FPS, renderMs: Date.now() - t0 };
  }

  /** Run a Remotion call; translate a cancel into RenderCancelledError. */
  async #guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await withPrivateTmp(fn);
    } catch (err) {
      if (this.#opts.signal?.aborted || /cancelled|canceled|aborted/i.test(String((err as Error)?.message))) throw new RenderCancelledError();
      throw err;
    }
  }

  /** Stop the browser, drop abort listeners, remove unfinished temp output. Safe to call repeatedly. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#onAbort) this.#opts.signal?.removeEventListener("abort", this.#onAbort);
    try {
      this.#cancel.cancel();
    } catch {
      /* already settled */
    }
    const b = this.#browser;
    this.#browser = null;
    await b?.close({ silent: true }).catch(() => undefined);
    for (const f of this.#tmpFiles) if (existsSync(f)) rmSync(f, { force: true });
    this.#tmpFiles.clear();
    this.#renderer = null;
  }
}
