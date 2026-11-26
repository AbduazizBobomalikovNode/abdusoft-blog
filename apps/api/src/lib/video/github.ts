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
/** Blogning o'z repozitoriysi: dispatch tokeni UNGA berilmasligi kerak (deploy.yml'ni ham ishga tushira oladi). */
export const BLOG_REPO = "AbduazizBobomalikovNode/abdusoft-blog";
export const DEFAULT_WORKFLOW_FILE = "render-video.yml";
export const DEFAULT_WORKFLOW_REF = "main";

/** GitHub egasi nomi: 1..39 belgi, harf/raqam va yakka defis (boshida/oxirida defis yo'q). */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
/** Repozitoriy nomi: 1..100 belgi, harf/raqam/`.`/`_`/`-`; faqat nuqtalardan iborat (`.`, `..`) va `.git` bilan tugaydigan nomlar YO'Q. */
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const WORKFLOW_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,98}\.ya?ml$/;
const REF_RE = /^[A-Za-z0-9._/-]{1,100}$/;

/** `egasi/nomi` ni GitHub qoidalari bo'yicha tekshiradi; yaroqsiz bo'lsa `null`. */
export function parseRepo(value: string): { owner: string; name: string } | null {
  const parts = value.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts as [string, string];
  if (!OWNER_RE.test(owner) || !NAME_RE.test(name)) return null;
  if (/^\.+$/.test(name) || name.toLowerCase().endsWith(".git")) return null;
  return { owner, name };
}
export const isValidRepo = (value: string): boolean => parseRepo(value) !== null;
/** Workflow fayl nomi (yo'l emas): `[A-Za-z0-9._-]+\.ya?ml`. */
export const isValidWorkflowFile = (value: string): boolean => WORKFLOW_RE.test(value);
/** Oddiy shox nomi: `..`, nazorat belgilari, boshida `-`/`/`, `//`, `/.`, `.lock` va oxirida `/`/`.` yo'q. */
export function isValidRef(value: string): boolean {
  if (!REF_RE.test(value)) return false;
  if (value.startsWith("-") || value.startsWith("/") || value.startsWith(".")) return false;
  if (value.includes("..") || value.includes("//") || value.includes("/.") || value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock")) return false;
  return true;
}
export const isBlogRepo = (repo: string): boolean => repo.toLowerCase() === BLOG_REPO.toLowerCase();

const SAME_REPO_UZ =
  "Bu blogning o'z repozitoriysi: token deploy.yml'ni (eski commit'ga qaytarish ham) ishga tushira olardi. Render uchun alohida kichik repozitoriy yarating (docs/video.md). Faqat bilib turib ruxsat berish uchun VIDEO_ALLOW_SAME_REPO=true qo'ying (tavsiya etilmaydi).";
const SAME_REPO_EN =
  "The dispatch repository is the blog's own repository, so the token could also run deploy.yml (a rollback deploy). Create a separate small render repository (docs/video.md) or, knowingly, set VIDEO_ALLOW_SAME_REPO=true (discouraged).";

/** `/repos/{owner}/{name}` — kodlangan segmentlar (yaroqli nomlarda `.`/`..` yo'q, shuning uchun yo'l normallashmaydi). */
function repoApiPath(repo: string): string | null {
  const r = parseRepo(repo);
  return r ? `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}` : null;
}

interface Raw {
  githubToken?: string;
  githubRepo?: string;
  githubWorkflow?: string;
  githubRef?: string;
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

type Source = "env" | "db" | "none";

export interface GithubConfig {
  token: string;
  repo: string;
  /** Workflow fayl nomi (default `render-video.yml`). Yaroqsiz bo'lsa bo'sh. */
  workflow: string;
  /** Dispatch shoxi (default `main`). Yaroqsiz bo'lsa bo'sh. */
  ref: string;
  tokenSource: Source;
  repoSource: Source;
  workflowSource: Source;
  refSource: Source;
  /** DB'da shifrlangan token bor, lekin deshifrlanmaydi (`BETTER_AUTH_SECRET` almashtirilgan). */
  tokenUnreadable: boolean;
  /** Dispatch'ni to'xtatadigan sozlama xatosi (o'zbekcha, qiymatsiz) yoki `null`. */
  problem: string | null;
  /** Xuddi shu xato inglizcha (ish xatosi uchun). */
  problemEn: string | null;
}

/** Deshifrlangan token FAQAT server ichida (dispatch/cancel/status) ishlatiladi. */
export async function getGithubConfig(): Promise<GithubConfig> {
  const raw = await loadRaw();
  const dbToken = decryptSecret(raw.githubToken);
  const token = config.VIDEO_GITHUB_TOKEN || dbToken;
  const repoRaw = (config.VIDEO_GITHUB_REPO || raw.githubRepo || "").trim();
  const workflowRaw = (config.VIDEO_GITHUB_WORKFLOW || raw.githubWorkflow || "").trim() || DEFAULT_WORKFLOW_FILE;
  const refRaw = (config.VIDEO_GITHUB_REF || raw.githubRef || "").trim() || DEFAULT_WORKFLOW_REF;
  const repo = isValidRepo(repoRaw) ? repoRaw : "";
  const workflow = isValidWorkflowFile(workflowRaw) ? workflowRaw : "";
  const ref = isValidRef(refRaw) ? refRaw : "";
  let problem: string | null = null;
  let problemEn: string | null = null;
  if (repoRaw && !repo) {
    problem = "Repozitoriy nomi `egasi/nomi` ko'rinishida va GitHub qoidalariga mos bo'lishi kerak.";
    problemEn = "The repository name is not valid (expected owner/name).";
  } else if (!workflow) {
    problem = "Workflow fayl nomi yaroqsiz (faqat `nom.yml` yoki `nom.yaml`, yo'lsiz).";
    problemEn = "The workflow file name is not valid (a plain name ending in .yml or .yaml).";
  } else if (!ref) {
    problem = "Shox nomi yaroqsiz (oddiy shox nomi: `..`, bo'shliq va boshida `-` bo'lmasin).";
    problemEn = "The ref is not a valid plain branch name.";
  } else if (repo && isBlogRepo(repo) && !config.VIDEO_ALLOW_SAME_REPO) {
    problem = SAME_REPO_UZ;
    problemEn = SAME_REPO_EN;
  }
  const src = (env: string, db: string | undefined): Source => (env ? "env" : db ? "db" : "none");
  return {
    token,
    repo,
    workflow,
    ref,
    tokenSource: config.VIDEO_GITHUB_TOKEN ? "env" : dbToken ? "db" : "none",
    repoSource: src(config.VIDEO_GITHUB_REPO, raw.githubRepo),
    workflowSource: src(config.VIDEO_GITHUB_WORKFLOW, raw.githubWorkflow),
    refSource: src(config.VIDEO_GITHUB_REF, raw.githubRef),
    tokenUnreadable: !config.VIDEO_GITHUB_TOKEN && Boolean(raw.githubToken) && dbToken === "",
    problem,
    problemEn,
  };
}

export interface GithubSettingsView {
  token: { isSet: boolean; masked: string; source: Source; envVar: string; unreadable: boolean };
  repo: { value: string; source: Source; envVar: string };
  workflow: { value: string; source: Source; envVar: string; default: string };
  ref: { value: string; source: Source; envVar: string; default: string };
  /** Dispatch'ni to'xtatayotgan sozlama xatosi (o'zbekcha) yoki `null`. */
  problem: string | null;
}

export async function getGithubSettingsView(): Promise<GithubSettingsView> {
  const c = await getGithubConfig();
  return {
    token: { isSet: Boolean(c.token), masked: c.token ? maskSecret(c.token) : "", source: c.tokenSource, envVar: "VIDEO_GITHUB_TOKEN", unreadable: c.tokenUnreadable },
    repo: { value: c.repo || (config.VIDEO_GITHUB_REPO ? config.VIDEO_GITHUB_REPO : ""), source: c.repoSource, envVar: "VIDEO_GITHUB_REPO" },
    workflow: { value: c.workflow || DEFAULT_WORKFLOW_FILE, source: c.workflowSource, envVar: "VIDEO_GITHUB_WORKFLOW", default: DEFAULT_WORKFLOW_FILE },
    ref: { value: c.ref || DEFAULT_WORKFLOW_REF, source: c.refSource, envVar: "VIDEO_GITHUB_REF", default: DEFAULT_WORKFLOW_REF },
    problem: c.problem,
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
export async function saveGithubSettings(patch: { githubToken?: string; githubRepo?: string; githubWorkflow?: string; githubRef?: string }): Promise<void> {
  const raw = await loadRaw();
  const errors: Record<string, string> = {};
  if (patch.githubToken !== undefined && !patch.githubToken.startsWith(SECRET_KEEP_PREFIX)) {
    const t = patch.githubToken.trim();
    if (config.VIDEO_GITHUB_TOKEN) errors.githubToken = "env'dan qulflangan (VIDEO_GITHUB_TOKEN) — panelda o'zgartirib bo'lmaydi";
    else if (t === "") raw.githubToken = "";
    else if (/\s/.test(t) || t.length > 255) errors.githubToken = "Token bo'shliqsiz va 255 belgidan qisqa bo'lishi kerak";
    else raw.githubToken = encryptSecret(t);
  }
  const field = (key: "githubRepo" | "githubWorkflow" | "githubRef", envValue: string, envName: string, valid: (v: string) => boolean, invalidText: string): void => {
    const v = patch[key];
    if (v === undefined) return;
    const r = v.trim();
    if (envValue) {
      if (r !== envValue) errors[key] = `env'dan qulflangan (${envName}) — panelda o'zgartirib bo'lmaydi`;
    } else if (r === "") raw[key] = "";
    else if (!valid(r)) errors[key] = invalidText;
    else raw[key] = r;
  };
  field("githubRepo", config.VIDEO_GITHUB_REPO, "VIDEO_GITHUB_REPO", isValidRepo, "Repozitoriy `egasi/nomi` ko'rinishida va GitHub qoidalariga mos bo'lishi kerak");
  field("githubWorkflow", config.VIDEO_GITHUB_WORKFLOW, "VIDEO_GITHUB_WORKFLOW", isValidWorkflowFile, "Workflow fayl nomi `nom.yml` yoki `nom.yaml` bo'lishi kerak (yo'lsiz)");
  field("githubRef", config.VIDEO_GITHUB_REF, "VIDEO_GITHUB_REF", isValidRef, "Shox nomi oddiy bo'lishi kerak (`..`, bo'shliq va boshida `-` bo'lmasin)");
  const effectiveRepo = (config.VIDEO_GITHUB_REPO || raw.githubRepo || "").trim();
  if (!errors.githubRepo && effectiveRepo && isBlogRepo(effectiveRepo) && !config.VIDEO_ALLOW_SAME_REPO) errors.githubRepo = SAME_REPO_UZ;
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

/** GitHub run id: rakamlar, 1..18 xona (hozirgi id'lar ~11 xonali), boshida nol yo'q. */
export const RUN_ID_RE = /^[1-9]\d{0,17}$/;

/** `POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches` with the job id as the only input. */
export async function dispatchWorkflow(jobId: string): Promise<DispatchResult> {
  const c = await getGithubConfig();
  if (!c.token || !c.repo) {
    return { ok: false, code: "runner_not_configured", retryable: false, message: `The GitHub token or repository is not set (${c.tokenUnreadable ? "the stored token cannot be read: enter it again" : "Settings > Video, or VIDEO_GITHUB_TOKEN and VIDEO_GITHUB_REPO"}).` };
  }
  if (c.problemEn) return { ok: false, code: "runner_not_configured", retryable: false, message: c.problemEn };
  const base = repoApiPath(c.repo);
  if (!base) return { ok: false, code: "runner_not_configured", retryable: false, message: "The repository name is not valid (expected owner/name)." };
  const client = new HostClient({ fetch: fetchImpl, timeoutMs: 15_000 }, [GITHUB_API_HOST], [c.token]);
  try {
    const res = await client.request({
      method: "POST",
      url: `https://${GITHUB_API_HOST}${base}/actions/workflows/${encodeURIComponent(c.workflow)}/dispatches`,
      headers: HEADERS(c.token),
      body: JSON.stringify({ ref: c.ref, inputs: { job_id: jobId }, return_run_details: true }),
      mode: "safe_write",
    });
    if (res.status === 200 || res.status === 204) {
      const id = (res.json as { workflow_run_id?: unknown } | undefined)?.workflow_run_id;
      const runId = typeof id === "number" || typeof id === "string" ? String(id) : null;
      return { ok: true, runId: runId && RUN_ID_RE.test(runId) ? runId : null };
    }
    const rateLimited = res.status === 429 || (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after")));
    if (rateLimited || res.status === 408 || res.status >= 500) return { ok: false, code: "runner_unavailable", retryable: true, status: res.status, message: `GitHub is temporarily unavailable or rate limiting (HTTP ${res.status}).` };
    if (res.status === 401) return { ok: false, code: "runner_auth", retryable: false, status: 401, message: "GitHub rejected the token (expired, revoked or wrong). Create a new fine-grained token with 'Actions: Read and write' on the render repository and save it in the settings." };
    if (res.status === 403) return { ok: false, code: "runner_auth", retryable: false, status: 403, message: "The GitHub token has no permission to start workflows in this repository. It needs 'Actions: Read and write' on this repository." };
    if (res.status === 404) return { ok: false, code: "runner_not_found", retryable: false, status: 404, message: `GitHub could not find the repository or the workflow '${c.workflow}' (check the repository name, that the token can see it, and that the workflow file is on the '${c.ref}' branch of the render repository).` };
    if (res.status === 422) return { ok: false, code: "runner_rejected", retryable: false, status: 422, message: `GitHub rejected the dispatch (usually: the workflow has no 'workflow_dispatch' trigger on '${c.ref}', the 'job_id' input is not defined there, or the ref does not exist).` };
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
    if (!c.token || !c.repo || c.problem) return false;
    const base = repoApiPath(c.repo);
    if (!base) return false;
    const client = new HostClient({ fetch: fetchImpl, timeoutMs: 10_000 }, [GITHUB_API_HOST], [c.token]);
    const res = await client.request({ method: "POST", url: `https://${GITHUB_API_HOST}${base}/actions/runs/${runId}/cancel`, headers: HEADERS(c.token), mode: "safe_write" });
    return res.status === 202 || res.status === 409;
  } catch {
    return false;
  }
}

export interface WorkflowRunState {
  /** `queued`, `in_progress`, `completed`, `waiting`, `requested`, `pending`, ... */
  status: string | null;
  /** Faqat `completed` bo'lganda: `success`, `failure`, `cancelled`, `skipped`, `timed_out`, ... */
  conclusion: string | null;
}

/** Best effort: `GET /repos/{owner}/{repo}/actions/runs/{run_id}` (docs.github.com/rest/actions/workflow-runs#get-a-workflow-run). `null` = noma'lum. Never throws. */
export async function getWorkflowRunState(runId: string | null | undefined): Promise<WorkflowRunState | null> {
  if (!runId || !RUN_ID_RE.test(runId)) return null;
  try {
    const c = await getGithubConfig();
    if (!c.token || !c.repo || c.problem) return null;
    const base = repoApiPath(c.repo);
    if (!base) return null;
    const client = new HostClient({ fetch: fetchImpl, timeoutMs: 10_000 }, [GITHUB_API_HOST], [c.token]);
    const res = await client.request({ method: "GET", url: `https://${GITHUB_API_HOST}${base}/actions/runs/${runId}`, headers: HEADERS(c.token), mode: "read" });
    if (res.status !== 200) return null;
    const j = res.json as { status?: unknown; conclusion?: unknown } | undefined;
    return { status: typeof j?.status === "string" ? j.status : null, conclusion: typeof j?.conclusion === "string" ? j.conclusion : null };
  } catch {
    return null;
  }
}
