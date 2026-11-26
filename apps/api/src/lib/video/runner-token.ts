import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../../config.js";

/** Shortest runner secret that counts as configured (characters). */
export const MIN_RUNNER_SECRET_CHARS = 32;

/** Both sides compute it; the long-lived secret itself never leaves the runner. Test vector in `runner-token.test.ts` (same value in packages/motion). */
export const runnerTokenFor = (secret: string, jobId: string): string => createHmac("sha256", secret).update(jobId).digest("hex");

export const runnerSecretConfigured = (): boolean => config.VIDEO_RUNNER_SECRET.length >= MIN_RUNNER_SECRET_CHARS;

/** Constant-time check of a presented bearer token for one job. A missing/short secret accepts NOTHING. */
export function verifyRunnerToken(jobId: string, presented: string | undefined): boolean {
  if (!runnerSecretConfigured() || !presented || !/^[0-9a-f]{64}$/.test(presented)) return false;
  const expected = Buffer.from(runnerTokenFor(config.VIDEO_RUNNER_SECRET, jobId), "hex");
  const got = Buffer.from(presented, "hex");
  return expected.length === got.length && timingSafeEqual(expected, got);
}
