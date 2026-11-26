#!/usr/bin/env node
/**
 * GitHub Actions entry point: renders ONE queued video job for the blog API and uploads the result. Plain Node 24
 * (types are stripped), no build step. Configuration comes ONLY from the environment:
 *   JOB_ID, VIDEO_RUNNER_SECRET, VIDEO_API_ORIGIN (+ GITHUB_RUN_ID / GITHUB_RUN_ATTEMPT set by Actions).
 * `runGithubJob` derives the per-job token and then deletes VIDEO_RUNNER_SECRET from `process.env`, before anything is spawned.
 * The log of a public repository is public, so this script prints stage names, timings and sizes only.
 */
import { enterDedicatedRenderProcess } from "../render/private-tmp.ts";
import { runGithubJob } from "./run.ts";

enterDedicatedRenderProcess();

const abort = new AbortController();
// Actions sends SIGINT then SIGTERM when a run is cancelled: stop the render, tell the API (it already knows), clean up.
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => abort.abort());

const { executeSpec } = await import("../worker/execute.ts");
const { isolateBrowserSignals } = await import("../render/cli-signals.ts");

const exit = await runGithubJob(process.env, {
  log: (line) => process.stdout.write(`${line}\n`),
  execute: (opts) => executeSpec({ ...opts, launchHook: isolateBrowserSignals }),
  signal: abort.signal,
});
process.stdout.write(`result=${exit.summary}\n`);
// Remotion can leave handles open (browser pipes): end the process explicitly.
process.exit(exit.code);
