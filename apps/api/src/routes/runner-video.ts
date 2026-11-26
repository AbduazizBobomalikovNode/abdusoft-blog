import { Hono, type Context, type Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { config } from "../config.js";
import { clientIp } from "../lib/device.js";
import { consumeRateLimit } from "../lib/rate-limit.js";
import { UploadError, completeFile, receivePart } from "../lib/video/uploads.js";
import { verifyRunnerToken } from "../lib/video/runner-token.js";
import {
  ClaimBody,
  CompleteBody,
  FailBody,
  ProgressBody,
  RunnerError,
  claim,
  complete,
  failDiskFull,
  failFromRunner,
  loadLiveClaimed,
  progress,
  rulesOfJob,
} from "../lib/video/runner-service.js";
import { previewWidthOf, type JobOptions } from "../lib/video/jobs.js";
import { z } from "zod";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[a-z0-9.-]{1,20}$/;
const JSON_LIMIT = 64 * 1024;

const answer = (c: Context, status: number, code: string) => c.json({ code }, status as 400);

/**
 * Hosted-runner endpoints (`VIDEO_ENABLED` and `VIDEO_RUNNER=github` only). Outside `/admin`: the caller is a GitHub Actions job,
 * not a person. The ONLY credential is the per-job HMAC bearer token (constant-time compare); a missing or short secret accepts
 * nothing. Answers carry a short `code` and never a path, stack trace or SQL text.
 */
export const runnerVideoRoute = new Hono();

// Flood guard before any work: one IP may not hammer the endpoints (a render makes a few dozen requests).
runnerVideoRoute.use("*", async (c, next) => {
  const r = consumeRateLimit(`runner-video-ip:${clientIp(c)}`, 1200, 60_000);
  if (!r.allowed) {
    c.header("Retry-After", String(r.retryAfterSeconds));
    return answer(c, 429, "rate_limited");
  }
  return next();
});

async function authenticate(c: Context, next: Next) {
  const id = c.req.param("id") ?? "";
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
  // One answer for "bad token", "not configured" and "malformed id": nothing is revealed to an unauthenticated caller.
  if (!UUID.test(id) || !verifyRunnerToken(id, token)) return answer(c, 401, "unauthorized");
  const r = consumeRateLimit(`runner-video-job:${id}`, 600, 60_000);
  if (!r.allowed) {
    c.header("Retry-After", String(r.retryAfterSeconds));
    return answer(c, 429, "rate_limited");
  }
  return next();
}

runnerVideoRoute.use("/jobs/:id/*", authenticate);
runnerVideoRoute.onError((error, c) => {
  if (error instanceof RunnerError) return answer(c, error.status, error.code);
  if (error instanceof UploadError) return answer(c, error.status, error.code);
  console.error("Runner endpoint xatosi:", error instanceof Error ? error.message : "unknown");
  return answer(c, 500, "internal_error");
});

const tooLarge = (c: Context) => answer(c, 413, "body_too_large");
const jsonBody = bodyLimit({ maxSize: JSON_LIMIT, onError: tooLarge });

async function readJson<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new RunnerError(422, "bad_request");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new RunnerError(422, "bad_request");
  return parsed.data;
}

runnerVideoRoute.post("/jobs/:id/claim", jsonBody, async (c) => c.json(await claim(c.req.param("id"), await readJson(c, ClaimBody))));

runnerVideoRoute.post("/jobs/:id/progress", jsonBody, async (c) => c.json(await progress(c.req.param("id"), await readJson(c, ProgressBody))));

// Parts are bounded (8 MB) and the whole request must fit the proxy's body limit (12 MB) and 60 s: the body is streamed to disk.
runnerVideoRoute.put(
  "/jobs/:id/files/:name/parts/:n",
  bodyLimit({ maxSize: 8 * 1024 * 1024, onError: tooLarge }),
  async (c) => {
    const id = c.req.param("id");
    const name = c.req.param("name");
    if (!NAME.test(name)) throw new UploadError(400, "bad_file_name");
    const row = await loadLiveClaimed(id);
    const declared = Number(c.req.header("content-length"));
    try {
      const n = /^\d{1,3}$/.test(c.req.param("n")) ? Number(c.req.param("n")) : -1;
      const r = await receivePart({
        jobId: id,
        rules: rulesOfJob(row),
        name,
        n,
        body: c.req.raw.body,
        declaredLength: Number.isFinite(declared) && c.req.header("content-length") !== undefined ? declared : null,
        sha256: c.req.header("x-part-sha256") ?? null,
      });
      return c.json({ ok: true, bytes: r.bytes });
    } catch (e) {
      if (e instanceof UploadError && e.code === "disk_full") await failDiskFull(id);
      throw e;
    }
  },
);

const FileDone = z.strictObject({ parts: z.number().int().min(1).max(20), bytes: z.number().int().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/i).nullable().optional() });

runnerVideoRoute.post("/jobs/:id/files/:name/complete", jsonBody, async (c) => {
  const id = c.req.param("id");
  const name = c.req.param("name");
  if (!NAME.test(name)) throw new UploadError(400, "bad_file_name");
  const row = await loadLiveClaimed(id);
  const body = await readJson(c, FileDone);
  try {
    const v = await completeFile({
      jobId: id,
      rules: rulesOfJob(row),
      name,
      parts: body.parts,
      bytes: body.bytes,
      sha256: body.sha256 ?? null,
      kind: row.kind,
      expectedWidth: previewWidthOf(row.options as JobOptions),
    });
    return c.json({ ok: true, bytes: v.bytes });
  } catch (e) {
    if (e instanceof UploadError && e.code === "disk_full") await failDiskFull(id);
    throw e;
  }
});

runnerVideoRoute.post("/jobs/:id/complete", jsonBody, async (c) => c.json(await complete(c.req.param("id"), await readJson(c, CompleteBody))));

runnerVideoRoute.post("/jobs/:id/fail", jsonBody, async (c) => c.json(await failFromRunner(c.req.param("id"), await readJson(c, FailBody))));

/** Config sanity at mount time is the caller's job (`app.ts`); this only documents the switch. */
export const runnerVideoEnabled = (): boolean => config.VIDEO_ENABLED && config.VIDEO_RUNNER === "github";
