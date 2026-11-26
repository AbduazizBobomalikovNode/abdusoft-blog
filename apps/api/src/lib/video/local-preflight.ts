import { readFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "./paths.js";

/**
 * `VIDEO_RUNNER=local` refuses to start any job until `scripts/setup-motion-browser.sh` has proven on THIS machine that the
 * compositor binary runs (glibc >= 2.35) and one tiny still renders. The script writes this marker; nothing else does.
 */
export const preflightFile = (): string => path.join(dataDir(), "local-preflight.json");

export interface PreflightState {
  ok: boolean;
  hint: string;
  at: string | null;
}

let override: PreflightState | null = null;
/** Faqat testlar uchun. */
export function setPreflightForTests(state: PreflightState | null): void {
  override = state;
}

export function localPreflight(): PreflightState {
  if (override) return override;
  const hint = "Run `bash scripts/setup-motion-browser.sh` on the server: it checks glibc >= 2.35, runs the compositor and renders one tiny still. Until it passes, the local backend does not start jobs (or switch to VIDEO_RUNNER=github).";
  try {
    const data = JSON.parse(readFileSync(preflightFile(), "utf8")) as { ok?: unknown; at?: unknown };
    if (data.ok === true) return { ok: true, hint: "", at: typeof data.at === "string" ? data.at : null };
  } catch {
    // marker yo'q yoki buzuq
  }
  return { ok: false, hint, at: null };
}
