import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD, type TestUser } from "../../test/auth-test-helpers.js";
import { MCP_URL, authorize, jwtPayload } from "../../test/mcp-harness.js";

// MCP SDK'ning O'ZIGA tegishli OAuth klienti (discovery, dinamik ro'yxatdan o'tish, PKCE, `resource`, avtomatik refresh)
// ushbu serverga qarshi — Claude Code kabi loopback redirect bilan.
vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "1000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "1000";
});

let app: Hono;
let admin: TestUser;

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
  admin = await createTestUser({ role: "admin" });
});

afterEach(() => {
  vi.useRealTimers();
});

function makeProvider(redirect: string) {
  const state: { tokens?: OAuthTokens; clientInfo?: OAuthClientInformationMixed; verifier: string; code: string; authorizationUrl?: URL; saved: OAuthTokens[] } = {
    verifier: "",
    code: "",
    saved: [],
  };
  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return redirect;
    },
    get clientMetadata() {
      return {
        client_name: "sdk-test",
        redirect_uris: [redirect],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    clientInformation: () => state.clientInfo,
    saveClientInformation: (info) => {
      state.clientInfo = info;
    },
    tokens: () => state.tokens,
    saveTokens: (tokens) => {
      state.tokens = tokens;
      state.saved.push(tokens);
    },
    saveCodeVerifier: (v) => {
      state.verifier = v;
    },
    codeVerifier: () => state.verifier,
    async redirectToAuthorization(url) {
      state.authorizationUrl = url;
      const q = url.searchParams;
      const result = await authorize(app, {
        url: url.href,
        clientId: q.get("client_id")!,
        redirectUri: q.get("redirect_uri")!,
        email: admin.email,
        password: TEST_USER_PASSWORD,
      });
      state.code = result.code;
    },
  };
  return { provider, state };
}

const appFetch: typeof fetch = (input, init) => app.request(input instanceof Request ? input.url : String(input), init) as Promise<Response>;

describe.each([["http://localhost:57001/callback"], ["http://127.0.0.1:57002/callback"]])("MCP SDK OAuth client with loopback redirect %s", (redirect) => {
  it("discovers, registers, authorizes, connects, calls tools and refreshes by itself", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { provider, state } = makeProvider(redirect);
    const make = () => new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: appFetch });

    let transport = make();
    let client = new Client({ name: "sdk-test", version: "1.0.0" });
    await expect(client.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);

    // SDK o'zi: PRM -> AS metadata -> DCR -> authorization URL (PKCE S256 + resource + scope)
    const url = state.authorizationUrl!;
    expect(url.pathname).toBe("/api/auth/oauth2/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe(MCP_URL);
    expect(url.searchParams.get("scope")!.split(" ")).toEqual(expect.arrayContaining(["blog:read", "offline_access"]));
    expect(state.clientInfo?.client_id).toBeTruthy();
    expect(state.code).toBeTruthy();

    await transport.finishAuth(state.code);
    expect(state.tokens?.access_token).toBeTruthy();
    expect(state.tokens?.refresh_token).toBeTruthy();
    expect([jwtPayload(state.tokens!.access_token).aud].flat()).toEqual([MCP_URL]);

    transport = make();
    client = new Client({ name: "sdk-test", version: "1.0.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("list_posts");
    expect(tools.tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);

    const who = await client.callTool({ name: "whoami", arguments: {} });
    const text = (who.content as Array<{ text: string }>)[0]!.text;
    expect(JSON.parse(text).user.email).toBe(admin.email);

    // Access token muddati o'tadi -> SDK 401 oladi va refresh token bilan o'zi yangilaydi
    const before = state.saved.length;
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    const after = await client.callTool({ name: "list_tags", arguments: {} });
    expect(after.isError).toBeFalsy();
    expect(state.saved.length).toBeGreaterThan(before);
    expect(state.tokens!.refresh_token).toBeTruthy();
    await client.close();
  });
});
