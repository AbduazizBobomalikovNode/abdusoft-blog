import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * Opt-in (VIDEO_REAL_TESTS=1): REAL previews and one REAL render of the motion package's showcase storyboard, through the same
 * worker runner the API uses (separate process group, low priority, memory watchdog, concurrency 1). Prints wall-clock time,
 * peak RSS of the worker's whole process tree and output sizes: these numbers decide the production settings.
 *   VIDEO_REAL_TESTS=1 pnpm --filter @blog/api exec vitest run src/lib/video/real.test.ts
 */
const enabled = process.env.VIDEO_REAL_TESTS === "1";

const env = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/video-real-${process.pid}`;
  process.env.VIDEO_DATA_DIR = `${dir}/data`;
  return { dir };
});

describe.skipIf(!enabled)("real render through the worker (opt-in)", () => {
  const out = mkdtempSync(path.join(os.tmpdir(), "video-real-out-"));
  afterAll(() => {
    rmSync(out, { recursive: true, force: true });
    rmSync(env.dir, { recursive: true, force: true });
  });

  async function run(kind: "preview" | "render", jobId: string, extra: Record<string, unknown>) {
    const runner = await import("./runner.js");
    const paths = await import("./paths.js");
    const { config } = await import("../../config.js");
    mkdirSync(paths.jobDirOf(jobId), { recursive: true });
    const spec = {
      kind,
      storyboardFile: path.join(paths.motionDir(), "fixtures", "showcase.json"),
      outDir: path.join(paths.jobDirOf(jobId), "out"),
      cacheDir: paths.cacheDirOf(),
      concurrency: config.VIDEO_CONCURRENCY,
      timeoutMs: 600_000,
      ...extra,
    } as import("./runner.js").WorkerSpec;
    const progress: string[] = [];
    const report = await runner.runWorker({
      jobId,
      spec,
      timeoutMs: 620_000,
      memoryLimitMb: config.VIDEO_WORKER_MEMORY_MB,
      signal: new AbortController().signal,
      onProgress: (m) => {
        if (progress.at(-1) !== m.phase) progress.push(m.phase);
      },
    });
    return { report, progress };
  }

  it("previews (cold bundle, warm bundle) and one full MP4", async () => {
    const { config } = await import("../../config.js");
    const lines: string[] = [];
    const cold = await run("preview", "real-prev-cold", { width: 480 });
    const warm = await run("preview", "real-prev-warm", { width: 480 });
    const warmAt = await run("preview", "real-prev-at", { width: 480, at: [3, 12, 25, 40] });
    for (const [name, r] of [["preview, all scenes, cold bundle", cold], ["preview, all scenes, warm bundle", warm], ["preview, 4 frames, warm bundle", warmAt]] as const) {
      expect(r.report.outcome.outcome, JSON.stringify(r.report.outcome)).toBe("result");
      const res = r.report.outcome.outcome === "result" && r.report.outcome.result.kind === "preview" ? r.report.outcome.result : null;
      const sizes = res?.stills.map((s) => s.bytes) ?? [];
      lines.push(`${name}: wall ${(r.report.wallMs / 1000).toFixed(1)} s, peak tree RSS ${r.report.peakRssMb} MB, ${sizes.length} frames, ${Math.min(...sizes)}-${Math.max(...sizes)} bytes each (${sizes.reduce((a, b) => a + b, 0)} total)`);
    }
    const render = await run("render", "real-render", { outName: "video.mp4" });
    expect(render.report.outcome.outcome, JSON.stringify(render.report.outcome)).toBe("result");
    if (render.report.outcome.outcome === "result" && render.report.outcome.result.kind === "render") {
      const r = render.report.outcome.result;
      lines.push(`render MP4 ${r.seconds.toFixed(1)} s of video (${r.frames} frames): wall ${(render.report.wallMs / 1000).toFixed(1)} s (renderMs ${(r.renderMs / 1000).toFixed(1)} s), peak tree RSS ${render.report.peakRssMb} MB, ${(statSync(r.file).size / 1024 / 1024).toFixed(2)} MiB`);
    }
    const header = `machine: ${os.cpus()[0]?.model} x${os.availableParallelism()}, ${(os.totalmem() / 1024 ** 3).toFixed(0)} GB RAM, ${os.platform()} ${os.arch()}; concurrency ${config.VIDEO_CONCURRENCY}, memory ceiling ${config.VIDEO_WORKER_MEMORY_MB} MB, nice ${config.VIDEO_WORKER_NICE}, heap ${config.VIDEO_WORKER_HEAP_MB} MB`;
    process.stdout.write(`\nVIDEO-MEASUREMENTS\n${header}\n${lines.join("\n")}\n`);
  }, 900_000);
});
