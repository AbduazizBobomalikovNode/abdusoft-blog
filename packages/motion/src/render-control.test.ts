import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserMissingError, RenderCancelledError, RenderTimeoutError } from "./render/errors.ts";
import { clampConcurrency, clampTimeoutMs, DEFAULT_TIMEOUT_MS, MAX_CONCURRENCY } from "./render/limits.ts";
import { defaultCacheDir, PACKAGE_ROOT } from "./render/paths.ts";
import { enterDedicatedRenderProcess } from "./render/private-tmp.ts";
import { sweepStale } from "./render/sweep.ts";
import { base } from "./test-helpers.ts";
import { assertStoryboard } from "./validate.ts";

// A fake @remotion/renderer: nothing here touches a browser, a bundle or the network.
const fake = vi.hoisted(() => ({
  installed: false,
  downloads: 0,
  hang: false,
  stillCalls: 0,
  frames: 1,
}));

vi.mock("@remotion/renderer", () => ({
  makeCancelSignal: () => {
    let cancelled: (() => void) | null = null;
    const p = new Promise<void>((r) => (cancelled = r));
    return { cancelSignal: (cb: () => void) => void p.then(cb), cancel: () => cancelled?.() };
  },
  ensureBrowser: async (o: { onBrowserDownload: (x: { chromeMode: string }) => { onProgress: (p: { percent: number }) => void } }) => {
    if (fake.installed) return { type: "local-puppeteer-browser", path: "/fake/chrome" };
    const d = o.onBrowserDownload({ chromeMode: "headless-shell" }); // throws when downloading is not allowed
    fake.downloads++;
    d.onProgress({ percent: 1 });
    fake.installed = true;
    return { type: "local-puppeteer-browser", path: "/fake/chrome" };
  },
  openBrowser: async () => ({ close: async () => undefined }),
  selectComposition: async () => (fake.hang ? new Promise(() => undefined) : { durationInFrames: fake.frames, fps: 30, width: 1920, height: 1080 }),
  renderStill: async () => {
    fake.stillCalls++;
    return new Promise(() => undefined);
  },
}));
vi.mock("./render/bundle.ts", () => ({
  ensureBundle: async () => ({ serveUrl: "/fake", hash: "0".repeat(16), cached: true, ms: 0 }),
  bundleDir: () => "/fake",
}));
vi.mock("./render/prepare.ts", () => ({ prepareRenderProps: async () => ({}), computeHighlights: async () => ({}) }));

const { MotionRenderer } = await import("./render/renderer.ts");

const tmp = mkdtempSync(path.join(os.tmpdir(), "motion-control-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeAll(() => {
  enterDedicatedRenderProcess();
  fake.frames = assertStoryboard(base()).timeline.totalFrames;
});
beforeEach(() => {
  fake.installed = false;
  fake.downloads = 0;
  fake.hang = false;
  fake.stillCalls = 0;
});

describe("browser: opt-in download", () => {
  it("fails fast with a typed error that says how to install, and downloads nothing, by default", async () => {
    const r = await MotionRenderer.create({ cacheDir: tmp, sweepOnStart: false });
    try {
      const err = await r.stills(base(), { outDir: path.join(tmp, "o") }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BrowserMissingError);
      expect((err as BrowserMissingError).code).toBe("browser_missing");
      expect((err as Error).message).toMatch(/setup-motion-browser\.sh/);
      expect((err as Error).message).toMatch(/blog-motion browser install/);
      expect(fake.downloads).toBe(0);
    } finally {
      await r.close();
    }
  });

  it("an explicit browserExecutable that does not exist is the same typed error", async () => {
    const r = await MotionRenderer.create({ cacheDir: tmp, sweepOnStart: false, browserExecutable: "/nonexistent/chrome" });
    try {
      await expect(r.warmUp()).rejects.toMatchObject({ code: "browser_missing", message: expect.stringContaining("/nonexistent/chrome") });
    } finally {
      await r.close();
    }
  });

  it("downloads only when allowBrowserDownload is true", async () => {
    const r = await MotionRenderer.create({ cacheDir: tmp, sweepOnStart: false, allowBrowserDownload: true, timeoutMs: 1000 });
    try {
      await r.warmUp();
      expect(fake.downloads).toBe(1);
    } finally {
      await r.close();
    }
  });
});

describe("the job always ends", () => {
  it("times out with RenderTimeoutError even when the engine hangs, and close() is safe afterwards", async () => {
    fake.installed = true;
    fake.hang = true;
    const r = await MotionRenderer.create({ cacheDir: tmp, sweepOnStart: false, timeoutMs: 1000 });
    const t0 = Date.now();
    const err = await r.stills(base(), { outDir: path.join(tmp, "t") }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RenderTimeoutError);
    expect((err as RenderTimeoutError).code).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(5000);
    await expect(r.stills(base(), { outDir: path.join(tmp, "t") })).rejects.toBeInstanceOf(RenderTimeoutError);
    await r.close();
    await r.close();
  });

  it("cancels on abort, even mid-render, with RenderCancelledError", async () => {
    fake.installed = true;
    const ac = new AbortController();
    const r = await MotionRenderer.create({ cacheDir: tmp, sweepOnStart: false, signal: ac.signal, timeoutMs: 30_000 });
    const pending = r.stills(base(), { outDir: path.join(tmp, "c") }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(fake.stillCalls).toBe(1)); // inside the (never-finishing) render call
    ac.abort();
    expect(await pending).toBeInstanceOf(RenderCancelledError);
    await r.close();
  });

  it("an already-aborted signal cancels before any work", async () => {
    fake.installed = true;
    const ac = new AbortController();
    ac.abort();
    const r = await MotionRenderer.create({ cacheDir: tmp, sweepOnStart: false, signal: ac.signal });
    await expect(r.warmUp()).rejects.toBeInstanceOf(RenderCancelledError);
    await r.close();
  });

  it("leaves no private temp directory behind after a timeout", async () => {
    fake.installed = true;
    const before = new Set((await import("node:fs")).readdirSync(os.tmpdir()).filter((n) => n.startsWith("blog-motion-")));
    const r = await MotionRenderer.create({ cacheDir: tmp, sweepOnStart: false, timeoutMs: 1000 });
    await r.stills(base(), { outDir: path.join(tmp, "x") }).catch(() => undefined);
    await r.close();
    // withPrivateTmp's directory is removed when the (cancelled) engine call settles; the fake never settles, so the sweep owns it.
    sweepStale({ maxAgeMs: -1 });
    const after = (await import("node:fs")).readdirSync(os.tmpdir()).filter((n) => n.startsWith("blog-motion-") && !before.has(n));
    expect(after).toEqual([]);
  });
});

describe("concurrency and timeout are clamped", () => {
  it("clamps concurrency to 1..min(8, cpus), default 1", () => {
    expect(clampConcurrency(undefined, 16)).toBe(1);
    expect(clampConcurrency(0, 16)).toBe(1);
    expect(clampConcurrency(-3, 16)).toBe(1);
    expect(clampConcurrency(Number.NaN, 16)).toBe(1);
    expect(clampConcurrency(3.9, 16)).toBe(3);
    expect(clampConcurrency(64, 16)).toBe(MAX_CONCURRENCY);
    expect(clampConcurrency(8, 4)).toBe(4);
    expect(clampConcurrency(2, 1)).toBe(1);
  });

  it("exposes the effective concurrency and clamps the timeout", async () => {
    const r = await MotionRenderer.create({ cacheDir: tmp, sweepOnStart: false, concurrency: 999 });
    expect(r.concurrency).toBeLessThanOrEqual(MAX_CONCURRENCY);
    expect(r.concurrency).toBeGreaterThanOrEqual(1);
    await r.close();
    expect(clampTimeoutMs(undefined)).toBe(DEFAULT_TIMEOUT_MS);
    expect(clampTimeoutMs(5)).toBe(1000);
    expect(clampTimeoutMs(10 ** 12)).toBe(60 * 60 * 1000);
  });
});

describe("startup sweep and cache location", () => {
  it("removes stale scratch dirs and half-built bundles, keeps fresh ones, prunes old bundle caches", () => {
    const root = mkdtempSync(path.join(tmp, "sweep-"));
    const tmpRoot = path.join(root, "tmp");
    const cache = path.join(root, "cache");
    mkdirSync(tmpRoot);
    mkdirSync(cache);
    const old = (Date.now() - 3 * 3600_000) / 1000;
    const mk = (dir: string, name: string, age?: number): string => {
      const p = path.join(dir, name);
      mkdirSync(p, { recursive: true });
      writeFileSync(path.join(p, "f"), "x");
      if (age !== undefined) utimesSync(p, age, age);
      return p;
    };
    const staleTmp = mk(tmpRoot, "blog-motion-abc", old);
    const freshTmp = mk(tmpRoot, "blog-motion-fresh");
    const foreign = mk(tmpRoot, "someone-elses", old);
    const halfBuilt = mk(cache, "bundle-aaaaaaaaaaaaaaaa.tmp-1-2", old);
    const current = mk(cache, "bundle-1111111111111111", old);
    const b2 = mk(cache, "bundle-2222222222222222", old + 10);
    const b3 = mk(cache, "bundle-3333333333333333", old + 20);
    const b4 = mk(cache, "bundle-4444444444444444", old + 30);
    const res = sweepStale({ tmpRoot, cacheDir: cache, keepBundle: "bundle-1111111111111111", keepBundles: 1 });
    expect(res.removed.length).toBe(4);
    expect(existsSync(staleTmp)).toBe(false);
    expect(existsSync(halfBuilt)).toBe(false);
    expect(existsSync(freshTmp)).toBe(true);
    expect(existsSync(foreign)).toBe(true); // not ours, never touched in a shared tmp dir
    expect(existsSync(current)).toBe(true); // the bundle in use
    expect(existsSync(b4)).toBe(true); // newest other bundle
    expect(existsSync(b2)).toBe(false);
    expect(existsSync(b3)).toBe(false);
  });

  it("with ownTmpRoot, sweeps every stale entry of a directory the program owns", () => {
    const root = mkdtempSync(path.join(tmp, "own-"));
    const stale = path.join(root, "job-9");
    mkdirSync(stale);
    const old = (Date.now() - 3 * 3600_000) / 1000;
    utimesSync(stale, old, old);
    sweepStale({ tmpRoot: root, ownTmpRoot: true });
    expect(existsSync(stale)).toBe(false);
  });

  it("never throws on missing directories", () => {
    expect(() => sweepStale({ tmpRoot: "/nonexistent/x", cacheDir: "/nonexistent/y" })).not.toThrow();
  });

  it("the default cache directory is outside the package and configurable", () => {
    const d = defaultCacheDir({ HOME: "/h" } as NodeJS.ProcessEnv);
    expect(d.startsWith(PACKAGE_ROOT)).toBe(false);
    expect(defaultCacheDir({ BLOG_MOTION_CACHE_DIR: "/data/cache" } as NodeJS.ProcessEnv)).toBe("/data/cache");
    expect(defaultCacheDir({ XDG_CACHE_HOME: "/x" } as NodeJS.ProcessEnv)).toBe("/x/blog-motion");
  });
});
