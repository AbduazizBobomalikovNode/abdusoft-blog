import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD, type TestUser } from "../../test/auth-test-helpers.js";
import { MCP_URL, authorize } from "../../test/mcp-harness.js";

// MCP SDK'ning o'z OAuth klienti yozuv vositalari yoqilgan serverga qarshi: 401 challenge'dagi ruxsatlarni so'raydi,
// foydalanuvchi qisman rozilik beradi, vositalar ro'yxati va chaqiruvlar SDK orqali ishlaydi.
vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.MCP_WRITE_TOOLS_ENABLED = "true";
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

const appFetch: typeof fetch = (input, init) => app.request(input instanceof Request ? input.url : String(input), init) as Promise<Response>;

describe("MCP SDK client against the write-enabled connector", () => {
  it("asks for the write permissions, receives a partial grant and calls write tools", async () => {
    const redirect = "http://localhost:57011/callback";
    const state: { tokens?: OAuthTokens; clientInfo?: OAuthClientInformationMixed; verifier: string; code: string; url?: URL } = { verifier: "", code: "" };
    const provider: OAuthClientProvider = {
      get redirectUrl() {
        return redirect;
      },
      get clientMetadata() {
        return { client_name: "sdk-write", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
      },
      clientInformation: () => state.clientInfo,
      saveClientInformation: (info) => void (state.clientInfo = info),
      tokens: () => state.tokens,
      saveTokens: (tokens) => void (state.tokens = tokens),
      saveCodeVerifier: (v) => void (state.verifier = v),
      codeVerifier: () => state.verifier,
      async redirectToAuthorization(url) {
        state.url = url;
        const result = await authorize(app, {
          url: url.href,
          clientId: url.searchParams.get("client_id")!,
          redirectUri: url.searchParams.get("redirect_uri")!,
          email: admin.email,
          password: TEST_USER_PASSWORD,
          // The owner un-ticks the dangerous and the channel permissions on the consent page.
          consentScope: "blog:read posts:write media:upload posts:publish offline_access",
        });
        state.code = result.code;
      },
    };
    const make = () => new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: appFetch });

    let transport = make();
    let client = new Client({ name: "sdk-write", version: "1.0.0" });
    await expect(client.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(state.url!.searchParams.get("scope")!.split(" ")).toEqual(expect.arrayContaining(["blog:read", "posts:write", "posts:publish", "posts:delete", "comments:moderate", "channels:send"]));
    await transport.finishAuth(state.code);
    expect(state.tokens!.scope!.split(" ").sort()).toEqual(["blog:read", "media:upload", "offline_access", "posts:publish", "posts:write"]);

    transport = make();
    client = new Client({ name: "sdk-write", version: "1.0.0" });
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    expect(tools.length).toBeGreaterThan(30);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.publish_post!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(byName.delete_comment!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.list_posts!.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.update_post!.title).toBe("Update a post");

    const parse = (r: Awaited<ReturnType<typeof client.callTool>>) => JSON.parse((r.content as Array<{ text: string }>)[0]!.text);
    const created = parse(await client.callTool({ name: "create_post_draft", arguments: { title: "SDK orqali", content_markdown: "## Salom\n\nBu SDK orqali yozildi va yetarli uzunlikda." } }));
    expect(created.post.status).toBe("draft");
    const stale = await client.callTool({ name: "update_post", arguments: { id: created.post.id, expected_updated_at: "2000-01-01T00:00:00.000Z", title: "Eskirgan" } });
    expect(stale.isError).toBe(true);
    expect(parse(stale).error.code).toBe("conflict");
    const denied = await client.callTool({ name: "ban_comment_author", arguments: { id: "00000000-0000-4000-8000-000000000000" } });
    expect(parse(denied).error).toMatchObject({ code: "insufficient_scope", requiredScope: "comments:moderate" });
    const published = parse(await client.callTool({ name: "publish_post", arguments: { id: created.post.id, expected_updated_at: created.post.updatedAt } }));
    expect(published.post.status).toBe("published");
    await client.close();
  });
});
