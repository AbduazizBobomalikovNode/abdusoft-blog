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

/** Pre-auth budget: FAILED authentications per address per minute. Valid-token traffic is never counted here, so a flood of bad tokens from
 * the runner's own address (or from behind a proxy that shares one address) cannot starve the real runner. */
export const FAILED_AUTH_PER_MINUTE = 60;
/** Post-auth budget per job id per minute: progress every ~3 s (20) plus the part uploads, with generous headroom. */
export const AUTHENTICATED_PER_JOB_PER_MINUTE = 600;

/** One failed attempt: 401 within the budget, 429 once the address used it up. Nothing in the request body is read. */
function rejectUnauthenticated(c: Context, status: 401 | 404, code: string) {
  const r = consumeRateLimit(`runner-video-authfail:${clientIp(c)}`, FAILED_AUTH_PER_MINUTE, 60_000);
  if (!r.allowed) {
    c.header("Retry-After", String(r.retryAfterSeconds));
    return answer(c, 429, "rate_limited");
  }
  return answer(c, status, code);
}

async function authenticate(c: Context, next: Next) {
  const id = c.req.param("id") ?? "";
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
  // One answer for "bad token", "not configured" and "malformed id": nothing is revealed to an unauthenticated caller.
  if (!UUID.test(id) || !verifyRunnerToken(id, token)) return rejectUnauthenticated(c, 401, "unauthorized");
  c.set("runnerAuthenticated" as never, true as never);
  const r = consumeRateLimit(`runner-video-job:${id}`, AUTHENTICATED_PER_JOB_PER_MINUTE, 60_000);
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

// Anything else under /runner/video (unknown paths, wrong method before authentication) is an unauthenticated probe: it counts as a failed attempt.
runnerVideoRoute.all("*", (c) => (c.get("runnerAuthenticated" as never) ? answer(c, 404, "not_found") : rejectUnauthenticated(c, 404, "not_found")));

/** Config sanity at mount time is the caller's job (`app.ts`); this only documents the switch. */
export const runnerVideoEnabled = (): boolean => config.VIDEO_ENABLED && config.VIDEO_RUNNER === "github";
