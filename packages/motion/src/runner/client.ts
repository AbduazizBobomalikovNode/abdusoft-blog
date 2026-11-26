import { createHash } from "node:crypto";

/** A thin, retrying HTTP client for the runner endpoints. It prints NOTHING itself: callers decide what is safe to log. */
export interface ClientOptions {
  origin: string;
  token: string;
  jobId: string;
  /** Test hooks. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Attempts per request for network errors, 429 and 5xx. */
  attempts?: number;
  requestTimeoutMs?: number;
}

export class ApiRefused extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`the API answered ${status} ${code}`);
    this.name = "ApiRefused";
    this.status = status;
    this.code = code;
  }
}

export const sha256Hex = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** HTTPS only, except for a loopback address (local end-to-end runs). */
export function checkOrigin(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("VIDEO_API_ORIGIN is not a valid URL");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) throw new Error("VIDEO_API_ORIGIN must be an https:// URL");
  if (url.username || url.password || url.search || url.hash) throw new Error("VIDEO_API_ORIGIN must be a plain origin");
  return url;
}

export class RunnerClient {
  requests = 0;
  readonly #o: Required<Pick<ClientOptions, "attempts" | "requestTimeoutMs">> & ClientOptions;
  readonly #base: string;

  constructor(opts: ClientOptions) {
    this.#o = { attempts: 4, requestTimeoutMs: 50_000, ...opts };
    const origin = checkOrigin(opts.origin);
    this.#base = `${origin.origin}/runner/video/jobs/${opts.jobId}`;
  }

  /** JSON request. 4xx (except 429) is final and thrown as `ApiRefused`; network errors, 429 and 5xx are retried with backoff. */
  async json<T>(method: "POST", path: string, body: unknown): Promise<T> {
    return this.#send<T>(method, path, JSON.stringify(body), { "content-type": "application/json" });
  }

  async bytes<T>(path: string, body: Uint8Array, headers: Record<string, string>): Promise<T> {
    return this.#send<T>("PUT", path, body, { "content-type": "application/octet-stream", ...headers });
  }

  async #send<T>(method: string, path: string, body: string | Uint8Array, headers: Record<string, string>): Promise<T> {
    const doFetch = this.#o.fetchImpl ?? fetch;
    const sleep = this.#o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let lastStatus = 0;
    for (let attempt = 1; attempt <= this.#o.attempts; attempt++) {
      this.requests++;
      try {
        const res = await doFetch(`${this.#base}${path}`, {
          method,
          headers: { authorization: `Bearer ${this.#o.token}`, ...headers },
          body: body as BodyInit,
          redirect: "manual",
          signal: AbortSignal.timeout(this.#o.requestTimeoutMs),
        });
        lastStatus = res.status;
        if (res.status >= 200 && res.status < 300) return (await res.json().catch(() => ({}))) as T;
        const parsed = (await res.json().catch(() => ({}))) as { code?: unknown };
        const code = typeof parsed.code === "string" ? parsed.code.slice(0, 60) : "error";
        if (res.status === 429 || res.status >= 500) {
          if (attempt === this.#o.attempts) throw new ApiRefused(res.status, code);
        } else {
          throw new ApiRefused(res.status, code);
        }
      } catch (error) {
        if (error instanceof ApiRefused) {
          if (error.status !== 429 && error.status < 500) throw error;
          if (attempt === this.#o.attempts) throw error;
        } else if (attempt === this.#o.attempts) {
          throw new ApiRefused(lastStatus || 0, "network_error");
        }
      }
      await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)));
    }
    throw new ApiRefused(lastStatus || 0, "network_error");
  }
}
