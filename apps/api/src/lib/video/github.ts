import { eq } from "drizzle-orm";
import { SECRET_KEEP_PREFIX } from "@blog/shared";
import { config } from "../../config.js";
import { db } from "../../db/index.js";
import { siteSettings } from "../../db/schema.js";
import { decryptSecret, encryptSecret, maskSecret } from "../crypto.js";
import { HostClient, type FetchLike } from "../distribution/http.js";
import { upsertSiteSetting } from "../site-settings.js";

/**
 * GitHub tomonidagi sozlamalar va chaqiruvlar (faqat `VIDEO_RUNNER=github`).
 *  - token va repozitoriy: env bo'sh bo'lmasa env > DB; token `encryptSecret` bilan shifrlangan holda `site_settings` ("settings:video"),
 *    hech qaysi marshrut/vosita uni qaytarmaydi (faqat maska), log'ga yozilmaydi;
 *  - tashqi so'rov FAQAT `api.github.com`ga (allow-list, HTTPS, redirect kuzatilmaydi); xato xabarlaridan token olib tashlanadi.
 */

const KEY = "settings:video";
export const GITHUB_API_HOST = "api.github.com";
export const WORKFLOW_FILE = "render-video.yml";
/** Workflow har doim `main` dagi nusxadan ishga tushadi (operator shu shoxga `video-render` environment siyosatini beradi). */
export const WORKFLOW_REF = "main";
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

interface Raw {
  githubToken?: string;
  githubRepo?: string;
}

let fetchImpl: FetchLike = (input, init) => fetch(input, init);
/** Faqat testlar uchun. */
export function setGithubFetchForTests(fn: FetchLike | null): void {
  fetchImpl = fn ?? ((input, init) => fetch(input, init));
}

async function loadRaw(): Promise<Raw> {
  const [row] = await db.select().from(siteSettings).where(eq(siteSettings.key, KEY)).limit(1);
  return (row?.value as Raw | undefined) ?? {};
}

export interface GithubConfig {
  token: string;
  repo: string;
  tokenSource: "env" | "db" | "none";
  repoSource: "env" | "db" | "none";
  /** DB'da shifrlangan token bor, lekin deshifrlanmaydi (`BETTER_AUTH_SECRET` almashtirilgan). */
  tokenUnreadable: boolean;
}

/** Deshifrlangan token FAQAT server ichida (dispatch/cancel) ishlatiladi. */
export async function getGithubConfig(): Promise<GithubConfig> {
  const raw = await loadRaw();
  const dbToken = decryptSecret(raw.githubToken);
  const token = config.VIDEO_GITHUB_TOKEN || dbToken;
  const repo = (config.VIDEO_GITHUB_REPO || raw.githubRepo || "").trim();
  return {
    token,
    repo: REPO_RE.test(repo) ? repo : "",
    tokenSource: config.VIDEO_GITHUB_TOKEN ? "env" : dbToken ? "db" : "none",
    repoSource: config.VIDEO_GITHUB_REPO ? "env" : raw.githubRepo ? "db" : "none",
    tokenUnreadable: !config.VIDEO_GITHUB_TOKEN && Boolean(raw.githubToken) && dbToken === "",
  };
}

export interface GithubSettingsView {
  token: { isSet: boolean; masked: string; source: "env" | "db" | "none"; envVar: string; unreadable: boolean };
  repo: { value: string; source: "env" | "db" | "none"; envVar: string };
}

export async function getGithubSettingsView(): Promise<GithubSettingsView> {
  const c = await getGithubConfig();
  return {
    token: { isSet: Boolean(c.token), masked: c.token ? maskSecret(c.token) : "", source: c.tokenSource, envVar: "VIDEO_GITHUB_TOKEN", unreadable: c.tokenUnreadable },
    repo: { value: c.repo || (config.VIDEO_GITHUB_REPO ? config.VIDEO_GITHUB_REPO : ""), source: c.repoSource, envVar: "VIDEO_GITHUB_REPO" },
  };
}

export class GithubSettingsError extends Error {
  readonly fields: Record<string, string>;
  constructor(fields: Record<string, string>) {
    super("Sozlamalarda xatolik topildi");
    this.name = "GithubSettingsError";
    this.fields = fields;
  }
}

/** `undefined`/maska = o'zgarmaydi; "" = tozalash; boshqa = yangi qiymat. Env'dan qulflangan maydonni o'zgartirishga urinish xato. */
export async function saveGithubSettings(patch: { githubToken?: string; githubRepo?: string }): Promise<void> {
  const raw = await loadRaw();
  const errors: Record<string, string> = {};
  if (patch.githubToken !== undefined && !patch.githubToken.startsWith(SECRET_KEEP_PREFIX)) {
    const t = patch.githubToken.trim();
    if (config.VIDEO_GITHUB_TOKEN) errors.githubToken = "env'dan qulflangan (VIDEO_GITHUB_TOKEN) — panelda o'zgartirib bo'lmaydi";
    else if (t === "") raw.githubToken = "";
    else if (/\s/.test(t) || t.length > 255) errors.githubToken = "Token bo'shliqsiz va 255 belgidan qisqa bo'lishi kerak";
    else raw.githubToken = encryptSecret(t);
  }
  if (patch.githubRepo !== undefined) {
    const r = patch.githubRepo.trim();
    if (config.VIDEO_GITHUB_REPO) {
      if (r !== config.VIDEO_GITHUB_REPO) errors.githubRepo = "env'dan qulflangan (VIDEO_GITHUB_REPO) — panelda o'zgartirib bo'lmaydi";
    } else if (r === "") raw.githubRepo = "";
    else if (!REPO_RE.test(r)) errors.githubRepo = "Repozitoriy `egasi/nomi` ko'rinishida bo'lishi kerak";
    else raw.githubRepo = r;
  }
  if (Object.keys(errors).length > 0) throw new GithubSettingsError(errors);
  await upsertSiteSetting(KEY, raw);
}

// --------------------------------------------------------------------------- dispatch / cancel

export type DispatchFailure = { ok: false; code: "runner_not_configured" | "runner_auth" | "runner_not_found" | "runner_rejected" | "runner_unavailable"; retryable: boolean; message: string; status?: number };
export type DispatchResult = { ok: true; runId: string | null } | DispatchFailure;

const HEADERS = (token: string): Record<string, string> => ({
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  authorization: `Bearer ${token}`,
  "user-agent": "abdusoft-blog-video",
  "content-type": "application/json",
});

const RUN_ID_RE = /^\d{1,20}$/;

/** `POST /repos/{owner}/{repo}/actions/workflows/render-video.yml/dispatches` with the job id as the only input. */
export async function dispatchWorkflow(jobId: string): Promise<DispatchResult> {
  const c = await getGithubConfig();
  if (!c.token || !c.repo) {
    return { ok: false, code: "runner_not_configured", retryable: false, message: `The GitHub token or repository is not set (${c.tokenUnreadable ? "the stored token cannot be read: enter it again" : "Settings > Video, or VIDEO_GITHUB_TOKEN and VIDEO_GITHUB_REPO"}).` };
  }
  const client = new HostClient({ fetch: fetchImpl, timeoutMs: 15_000 }, [GITHUB_API_HOST], [c.token]);
  try {
    const res = await client.request({
      method: "POST",
      url: `https://${GITHUB_API_HOST}/repos/${c.repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      headers: HEADERS(c.token),
      body: JSON.stringify({ ref: WORKFLOW_REF, inputs: { job_id: jobId }, return_run_details: true }),
      mode: "safe_write",
    });
    if (res.status === 200 || res.status === 204) {
      const id = (res.json as { workflow_run_id?: unknown } | undefined)?.workflow_run_id;
      const runId = typeof id === "number" || typeof id === "string" ? String(id) : null;
      return { ok: true, runId: runId && RUN_ID_RE.test(runId) ? runId : null };
    }
    const rateLimited = res.status === 429 || (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after")));
    if (rateLimited || res.status === 408 || res.status >= 500) return { ok: false, code: "runner_unavailable", retryable: true, status: res.status, message: `GitHub is temporarily unavailable or rate limiting (HTTP ${res.status}).` };
    if (res.status === 401) return { ok: false, code: "runner_auth", retryable: false, status: 401, message: "GitHub rejected the token (expired, revoked or wrong). Create a new fine-grained token with 'Actions: Read and write' and save it in the settings." };
    if (res.status === 403) return { ok: false, code: "runner_auth", retryable: false, status: 403, message: "The GitHub token has no permission to start workflows in this repository. It needs 'Actions: Read and write' on this repository." };
    if (res.status === 404) return { ok: false, code: "runner_not_found", retryable: false, status: 404, message: "GitHub could not find the repository or the workflow 'render-video.yml' (check the repository name, that the token can see it, and that the workflow file is on the main branch)." };
    if (res.status === 422) return { ok: false, code: "runner_rejected", retryable: false, status: 422, message: "GitHub rejected the dispatch (usually: the workflow has no 'workflow_dispatch' trigger on main, or the 'job_id' input is not defined there)." };
    return { ok: false, code: "runner_rejected", retryable: false, status: res.status, message: `GitHub answered HTTP ${res.status} to the dispatch.` };
  } catch {
    return { ok: false, code: "runner_unavailable", retryable: true, message: "GitHub could not be reached (network error or timeout)." };
  }
}

/** Best effort: `POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel` (202 accepted, 409 already finished). Never throws. */
export async function cancelWorkflowRun(runId: string | null | undefined): Promise<boolean> {
  if (!runId || !RUN_ID_RE.test(runId)) return false;
  try {
    const c = await getGithubConfig();
    if (!c.token || !c.repo) return false;
    const client = new HostClient({ fetch: fetchImpl, timeoutMs: 10_000 }, [GITHUB_API_HOST], [c.token]);
    const res = await client.request({ method: "POST", url: `https://${GITHUB_API_HOST}/repos/${c.repo}/actions/runs/${runId}/cancel`, headers: HEADERS(c.token), mode: "safe_write" });
    return res.status === 202 || res.status === 409;
  } catch {
    return false;
  }
}
