import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { GIF_LIMITS } from "../limits.ts";
import { COMPOSITION_ID } from "../props.ts";
import type { Storyboard } from "../schema/storyboard.ts";
import type { Timeline } from "../timeline.ts";
import { FPS } from "../timing.ts";
import { resolveScene, sceneFrameRange, sceneReviewFrames } from "../scene-ref.ts";
import { assertStoryboard } from "../validate.ts";
import { ensureBundle, type BundleResult } from "./bundle.ts";
import { BrowserMissingError, GifLimitError, type ProgressCallback, RenderCancelledError, RenderTimeoutError } from "./errors.ts";
import { clampConcurrency, clampTimeoutMs } from "./limits.ts";
import { sweepStale } from "./sweep.ts";
import { checkGifRange } from "./gif-limits.ts";
import { withPackageCwd } from "./browser.ts";
import { assertDedicatedRenderProcess, withPrivateTmp } from "./private-tmp.ts";
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
  /**
   * Allow downloading Chrome Headless Shell (~100 MB) when it is missing. Default FALSE: a missing browser fails fast
   * with BrowserMissingError. The CLI's `browser install` command and the server setup script are the places that opt in.
   */
  allowBrowserDownload?: boolean;
  onProgress?: ProgressCallback;
  /** Abort to cancel: the browser and encoder are stopped and temp output is removed. */
  signal?: AbortSignal;
  /** Frames rendered in parallel, clamped to 1..min(8, CPU count). Default 1 (the safe value for a shared server). */
  concurrency?: number;
  /**
   * Whole-job wall clock in ms (default 10 min, clamped to 1 s..1 h), counted from create(). When it elapses the
   * operation rejects with RenderTimeoutError, the render is cancelled and close() removes temp output.
   */
  timeoutMs?: number;
  /**
   * Wraps the browser launch. Remotion's launcher installs process signal listeners (SIGINT calls process.exit(130));
   * a process entry point that owns signals (the CLI) passes `isolateBrowserSignals` here. The library itself never
   * touches signal handlers.
   */
  launchHook?: <T>(launch: () => Promise<T>) => Promise<T>;
  /** Sweep stale temp/bundle directories when the renderer is created (default true). */
  sweepOnStart?: boolean;
  /** Override the theme of the storyboard (fixtures are rendered in both modes). */
  themeOverride?: "light" | "dark";
  /** Override the style preset of the storyboard. */
  presetOverride?: (typeof import("../theme/tokens.ts"))["PRESETS"][number];
}

export interface StillRequest {
  /** Directory the JPEGs are written to (created). */
  outDir: string;
  /** Seconds to capture; omit (or pass auto) for one still per scene at its most informative moment. */
  at?: number[];
  /** JPEG quality 1-100 (default 80). */
  quality?: number;
  /**
   * Only this scene (id or 1-based position). Without `at`, four review frames are written: the start,
   * early, middle and settled end of the scene (names end in -start, -early, -middle, -end).
   */
  scene?: string;
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
  /** Only this scene (id or 1-based position); overrides from/to. */
  scene?: string;
  /** With `scene` on a closing scene: only the final hold period, which loops seamlessly. */
  loop?: boolean;
}

export interface VideoRequest {
  /** Only this scene (id or 1-based position), including the overlap of its entering transition. */
  scene?: string;
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
  /** Rejects when the job times out or is aborted, so every public operation settles even if Remotion hangs. */
  readonly #interrupt: Promise<never>;
  #timer: NodeJS.Timeout | null = null;
  #timedOut = false;
  #browserChecked = false;
  readonly #timeoutMs: number;
  readonly concurrency: number;

  private constructor(opts: MotionRendererOptions, renderer: Renderer) {
    this.#opts = opts;
    this.#renderer = renderer;
    this.#cancel = renderer.makeCancelSignal();
    this.concurrency = clampConcurrency(opts.concurrency);
    this.#timeoutMs = clampTimeoutMs(opts.timeoutMs);
    let reject!: (e: Error) => void;
    this.#interrupt = new Promise<never>((_, rej) => {
      reject = rej;
    });
    this.#interrupt.catch(() => undefined); // never an unhandled rejection
    this.#timer = setTimeout(() => {
      this.#timedOut = true;
      this.#cancelRender();
      reject(new RenderTimeoutError(this.#timeoutMs));
    }, this.#timeoutMs);
    this.#timer.unref();
    if (opts.signal) {
      this.#onAbort = () => {
        this.#cancelRender();
        reject(new RenderCancelledError());
      };
      if (opts.signal.aborted) this.#onAbort();
      else opts.signal.addEventListener("abort", this.#onAbort, { once: true });
    }
  }

  /**
   * Refuses to run outside a process that opted in with enterDedicatedRenderProcess(): rendering rewrites TMPDIR/TMP/TEMP
   * for the whole process. Throws RendererProcessError otherwise.
   */
  static async create(opts: MotionRendererOptions = {}): Promise<MotionRenderer> {
    assertDedicatedRenderProcess();
    if (opts.sweepOnStart !== false) sweepStale({ cacheDir: opts.cacheDir ?? DEFAULT_CACHE_DIR });
    return new MotionRenderer(opts, await import("@remotion/renderer"));
  }

  #cancelRender(): void {
    try {
      this.#cancel.cancel();
    } catch {
      /* already settled */
    }
  }

  /** Run an operation against the job clock and the abort signal; the loser keeps running only until close(). */
  #race<T>(work: Promise<T>): Promise<T> {
    work.catch(() => undefined);
    return Promise.race([work, this.#interrupt]);
  }

  get #r(): Renderer {
    if (!this.#renderer) throw new Error("renderer closed");
    return this.#renderer;
  }

  #check(): void {
    if (this.#closed) throw new Error("MotionRenderer is closed");
    if (this.#timedOut) throw new RenderTimeoutError(this.#timeoutMs);
    if (this.#opts.signal?.aborted) throw new RenderCancelledError();
  }

  #emit(phase: Parameters<ProgressCallback>[0]["phase"], fraction: number | null, message: string): void {
    this.#opts.onProgress?.({ phase, fraction, message });
  }

  /** Bundle (cached by source hash) and open the shared browser. */
  warmUp(): Promise<{ bundle: BundleResult }> {
    return this.#race(this.#warmUp());
  }

  /** Fail fast (before the ~10-25 s bundle) when no browser is installed and downloading is not allowed. */
  async #ensureBrowserInstalled(): Promise<void> {
    if (this.#browserChecked) return;
    const explicit = this.#opts.browserExecutable;
    if (explicit) {
      if (!existsSync(explicit)) throw new BrowserMissingError(`browserExecutable "${explicit}" does not exist`);
    } else {
      this.#emit("browser", 0, "checking browser");
      const allow = this.#opts.allowBrowserDownload === true;
      // ensureBrowser calls onBrowserDownload only when nothing usable is installed: refuse there unless downloading is allowed.
      await withPackageCwd(() =>
        this.#r.ensureBrowser({
          logLevel: "error",
          onBrowserDownload: () => {
            if (!allow) throw new BrowserMissingError();
            this.#emit("browser", null, "downloading Chrome Headless Shell (first run only)");
            return { version: null, onProgress: ({ percent }: { percent: number }) => this.#emit("browser", percent, "downloading Chrome Headless Shell") };
          },
        }),
      );
    }
    this.#browserChecked = true;
  }

  async #warmUp(): Promise<{ bundle: BundleResult }> {
    this.#check();
    await this.#ensureBrowserInstalled();
    this.#check();
    if (!this.#bundle) {
      this.#emit("bundle", 0, "bundling composition");
      this.#bundle = await ensureBundle(this.#opts.cacheDir ?? DEFAULT_CACHE_DIR, (f) => this.#emit("bundle", f, "bundling composition"));
      this.#emit("bundle", 1, this.#bundle.cached ? "bundle cache hit" : `bundled in ${(this.#bundle.ms / 1000).toFixed(1)} s`);
    }
    if (!this.#browser) {
      this.#emit("browser", 0, "opening browser");
      this.#check();
      const explicit = this.#opts.browserExecutable;
      const launch = (): ReturnType<Renderer["openBrowser"]> =>
        this.#r.openBrowser("chrome", {
          chromeMode: "headless-shell",
          logLevel: "error",
          ...(explicit ? { browserExecutable: explicit } : {}),
        });
      this.#browser = await withPackageCwd(() => (this.#opts.launchHook ? this.#opts.launchHook(launch) : launch()));
      this.#emit("browser", 1, "browser ready");
    }
    return { bundle: this.#bundle };
  }

  #withTheme(input: unknown): unknown {
    if (!input || typeof input !== "object") return input;
    return {
      ...(input as object),
      ...(this.#opts.themeOverride ? { theme: this.#opts.themeOverride } : {}),
      ...(this.#opts.presetOverride ? { preset: this.#opts.presetOverride } : {}),
    };
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
  stills(input: unknown, req: StillRequest): Promise<StillResult[]> {
    return this.#race(this.#stills(input, req));
  }

  async #stills(input: unknown, req: StillRequest): Promise<StillResult[]> {
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
    } else if (req.scene !== undefined) {
      const t = resolveScene(s.timeline, req.scene);
      for (const f of sceneReviewFrames(t)) targets.push({ frame: f.frame, scene: t.index, name: `scene-${pad(t.index + 1)}-${t.id ?? t.type}-${f.label}` });
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
  video(input: unknown, outFile: string, req: VideoRequest = {}): Promise<VideoResult> {
    return this.#race(this.#video(input, outFile, req));
  }

  async #video(input: unknown, outFile: string, req: VideoRequest): Promise<VideoResult> {
    this.#check();
    const s = await this.#session(input);
    if (req.scene !== undefined) {
      const range = sceneFrameRange(resolveScene(s.timeline, req.scene));
      return this.#encode(s, outFile, { codec: "h264" }, range.startFrame, range.endFrame);
    }
    return this.#encode(s, outFile, { codec: "h264" }, 0, s.timeline.totalFrames - 1);
  }

  /** GIF for short clips only (<= 15 s, <= 800 px wide, 15 fps). Longer: GifLimitError, use video(). */
  gif(input: unknown, outFile: string, req: GifRequest = {}): Promise<VideoResult> {
    return this.#race(this.#gif(input, outFile, req));
  }

  async #gif(input: unknown, outFile: string, req: GifRequest): Promise<VideoResult> {
    this.#check();
    // Limits are checked on the pure timeline, before any bundling or browser work.
    const tl = assertStoryboard(this.#withTheme(input)).timeline;
    let window: { from?: number; to?: number } = req;
    if (req.scene !== undefined) {
      const t = resolveScene(tl, req.scene);
      if (req.loop) {
        if (!t.loop) throw new GifLimitError(`scene ${t.index + 1} (${t.type}) has no seamless loop: only a closing scene that holds long enough after its animation does`);
        window = { from: t.loop.startFrame / FPS, to: (t.loop.startFrame + t.loop.frames) / FPS };
      } else window = { from: t.startFrame / FPS, to: t.endFrame / FPS };
    } else if (req.loop) throw new GifLimitError("--loop needs --scene <closing scene>");
    const range = checkGifRange(tl, window);
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
        concurrency: this.concurrency,
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
      if (this.#timedOut) throw new RenderTimeoutError(this.#timeoutMs);
      if (this.#opts.signal?.aborted || /cancelled|canceled|aborted/i.test(String((err as Error)?.message))) throw new RenderCancelledError();
      throw err;
    }
  }

  /** Stop the browser, drop abort listeners, remove unfinished temp output. Safe to call repeatedly. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#onAbort) this.#opts.signal?.removeEventListener("abort", this.#onAbort);
    this.#cancelRender();
    const b = this.#browser;
    this.#browser = null;
    await b?.close({ silent: true }).catch(() => undefined);
    for (const f of this.#tmpFiles) if (existsSync(f)) rmSync(f, { force: true });
    this.#tmpFiles.clear();
    this.#renderer = null;
  }
}
