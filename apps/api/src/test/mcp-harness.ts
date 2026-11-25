import { createHash, randomBytes } from "node:crypto";
import type { Hono } from "hono";

export const API = "http://localhost:4000";
export const WEB = "http://localhost:3000";
export const MCP_URL = `${API}/mcp`;
export const ISSUER = `${API}/api/auth`;
export const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
export const ALL_BLOG_SCOPES = "blog:read posts:write media:upload posts:publish channels:send comments:moderate posts:delete offline_access";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- testlarda JSON-RPC/JWT javoblari erkin tuzilishli
export type Json = any;

export const b64u = (b: Buffer) => b.toString("base64url");
export function pkce() {
  const verifier = b64u(randomBytes(32));
  return { verifier, challenge: b64u(createHash("sha256").update(verifier).digest()) };
}
export const jwtPayload = (token: string) => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as Json;

/** In-process "brauzer": cookie jar + qo'lda redirect. `app.request` orqali (tarmoqsiz). */
export class Browser {
  jar = new Map<string, string>();
  constructor(private readonly app: Hono) {}

  async req(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; origin?: string; navigate?: boolean } = {}) {
    const headers = new Headers(init.headers);
    if (this.jar.size) headers.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    if (init.origin) headers.set("origin", init.origin);
    // Haqiqiy navigatsiya (top-level) — Better Auth shunda JSON o'rniga 302 qaytaradi.
    if (init.navigate) headers.set("sec-fetch-mode", "navigate");
    const res = await this.app.request(url, { method: init.method ?? "GET", headers, body: init.body });
    for (const sc of res.headers.getSetCookie()) {
      const [kv] = sc.split(";");
      const i = kv!.indexOf("=");
      const k = kv!.slice(0, i);
      const v = kv!.slice(i + 1);
      if (v === "") this.jar.delete(k);
      else this.jar.set(k, v);
    }
    return res;
  }

  signIn(email: string, password: string, oauthQuery?: string) {
    return this.req(`${API}/api/auth/sign-in/email`, {
      method: "POST",
      origin: WEB,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ email, password, ...(oauthQuery ? { oauth_query: oauthQuery } : {}) }),
    });
  }
}

export async function register(app: Hono, body: Record<string, unknown>, ip = "203.0.113.5") {
  return app.request(`${API}/api/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

export async function registerClient(app: Hono, redirectUri = CLAUDE_REDIRECT, name = "Claude", ip?: string) {
  const res = await register(
    app,
    {
      client_name: name,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    ip,
  );
  const body = (await res.json()) as { client_id?: string };
  if (res.status !== 201 || !body.client_id) throw new Error(`registration failed: ${res.status} ${JSON.stringify(body)}`);
  return body.client_id;
}

export interface AuthorizeResult {
  code: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
  steps: string[];
  consentUrl?: string;
  loginUrl?: string;
  /** `denied` bo'lsa redirect'dagi `error`. */
  error?: string;
  browser: Browser;
}

/** authorize -> (login sahifasi: sign-in XHR) -> (consent sahifasi: consent XHR) -> redirect_uri'ga code bilan. */
export async function authorize(
  app: Hono,
  p: {
    clientId: string;
    redirectUri?: string;
    scope?: string;
    resource?: string | null;
    email: string;
    password: string;
    approve?: boolean;
    browser?: Browser;
    stopAtConsent?: boolean;
    /** Tayyor authorization URL (masalan MCP SDK klienti yasagan) — berilsa u ishlatiladi, boshqa parametrlar e'tiborsiz. */
    url?: string;
  },
): Promise<AuthorizeResult> {
  const b = p.browser ?? new Browser(app);
  const redirectUri = p.redirectUri ?? CLAUDE_REDIRECT;
  const { verifier, challenge } = pkce();
  const q = new URLSearchParams({
    response_type: "code",
    client_id: p.clientId,
    redirect_uri: redirectUri,
    scope: p.scope ?? ALL_BLOG_SCOPES,
    state: b64u(randomBytes(8)),
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (p.resource !== null) q.set("resource", p.resource ?? MCP_URL);

  const steps: string[] = [];
  let url = p.url ?? `${API}/api/auth/oauth2/authorize?${q}`;
  let loginUrl: string | undefined;
  let consentUrl: string | undefined;

  for (let i = 0; i < 8; i += 1) {
    let u: URL;
    if (url.startsWith(redirectUri) || new URL(url).origin === WEB) {
      u = new URL(url);
    } else {
      const r = await b.req(url, { navigate: true });
      const loc = r.headers.get("location");
      if (![301, 302, 303, 307, 308].includes(r.status) || !loc) throw new Error(`authorize step ${i}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
      u = new URL(loc, url);
    }

    if (u.href.startsWith(redirectUri)) {
      steps.push("redirect_uri");
      const error = u.searchParams.get("error") ?? undefined;
      return { code: u.searchParams.get("code") ?? "", verifier, redirectUri, clientId: p.clientId, steps, consentUrl, loginUrl, error, browser: b };
    }
    if (u.origin === WEB && u.pathname === "/login") {
      steps.push("login-page");
      loginUrl = u.href;
      const si = await b.signIn(p.email, p.password, u.search.slice(1));
      const body = (await si.json().catch(() => null)) as { url?: string } | null;
      if (!body?.url) throw new Error(`sign-in gave no redirect url: ${si.status} ${JSON.stringify(body)}`);
      url = new URL(body.url, API).href;
      continue;
    }
    if (u.origin === WEB && u.pathname === "/consent") {
      steps.push("consent-page");
      consentUrl = u.href;
      if (p.stopAtConsent) return { code: "", verifier, redirectUri, clientId: p.clientId, steps, consentUrl, loginUrl, browser: b };
      const c = await b.req(`${API}/api/auth/oauth2/consent`, {
        method: "POST",
        origin: WEB,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ accept: p.approve ?? true, oauth_query: u.search.slice(1) }),
      });
      const cj = (await c.json()) as { url?: string; error?: string };
      if (!cj.url) throw new Error(`consent: ${c.status} ${JSON.stringify(cj)}`);
      url = new URL(cj.url, API).href;
      continue;
    }
    steps.push(`hop:${u.origin}${u.pathname}`);
    url = u.href;
  }
  throw new Error("too many hops");
}

export async function tokenRequest(app: Hono, params: Record<string, string>) {
  const res = await app.request(`${API}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
}

export async function exchangeCode(app: Hono, a: AuthorizeResult, resource: string | null = MCP_URL) {
  return tokenRequest(app, {
    grant_type: "authorization_code",
    code: a.code,
    redirect_uri: a.redirectUri,
    client_id: a.clientId,
    code_verifier: a.verifier,
    ...(resource ? { resource } : {}),
  });
}

/** Ro'yxatdan o'tish + to'liq admin oqimi + token. */
export async function connect(
  app: Hono,
  user: { email: string; password: string },
  opts: { scope?: string; clientId?: string; redirectUri?: string; name?: string } = {},
) {
  const clientId = opts.clientId ?? (await registerClient(app, opts.redirectUri, opts.name));
  const a = await authorize(app, { clientId, ...user, scope: opts.scope, redirectUri: opts.redirectUri });
  const tok = await exchangeCode(app, a);
  if (tok.status !== 200) throw new Error(`token exchange failed: ${tok.status} ${JSON.stringify(tok.body)}`);
  return { clientId, authorize: a, tokens: tok.body as { access_token: string; refresh_token?: string; scope: string; expires_in: number } };
}

let rpcId = 0;
export async function mcpCall(app: Hono, token: string | undefined, method: string, params: unknown = {}, extraHeaders: Record<string, string> = {}) {
  rpcId += 1;
  const res = await app.request(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
  });
  const text = await res.text();
  let body: Json;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, www: res.headers.get("www-authenticate"), body, headers: res.headers };
}

export async function callTool(app: Hono, token: string, name: string, args: Record<string, unknown> = {}) {
  const r = await mcpCall(app, token, "tools/call", { name, arguments: args });
  const result = r.body?.result as { isError?: boolean; content?: Array<{ text: string }> } | undefined;
  const text = result?.content?.[0]?.text ?? "";
  let json: Json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* matn */
  }
  return { status: r.status, isError: result?.isError === true, text, json, raw: r.body };
}
