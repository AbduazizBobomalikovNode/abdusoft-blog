import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD, type TestUser } from "../../test/auth-test-helpers.js";
import { callTool, connect, mcpCall, type Json } from "../../test/mcp-harness.js";

// Video xizmati O'CHIQ: main_video_job_id faqat posts:write talab qiladi.
vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.MCP_WRITE_TOOLS_ENABLED = "true";
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "1000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "1000";
  process.env.VIDEO_ENABLED = "false";
});

let app: Hono;
let admin: TestUser;
let writer: string;
let readOnly: string;
let postId: string;
let jobId: string;
let otherJobId: string;
let db: typeof import("../../db/index.js").db;
let s: typeof import("../../db/schema.js");

const call = (t: string, name: string, args: Record<string, unknown> = {}) => callTool(app, t, name, args);
const token = async () => ((await call(writer, "get_post", { id: postId })).json as Json).post.updatedAt as string;

async function mkJob(forPost: string): Promise<string> {
  const [job] = await db.insert(s.motionJobs).values({ kind: "render", status: "ready", postId: forPost, storyboard: {}, durationSeconds: 30, via: "mcp", finishedAt: new Date() } as never).returning();
  const id = (job as { id: string }).id;
  await db.insert(s.motionAssets).values({ jobId: id, kind: "mp4", key: `video/none-${id}`, url: `http://localhost:4000/uploads/video/${id}.mp4`, mime: "video/mp4", size: 10, width: 1920, height: 1080, seconds: 30 } as never);
  return id;
}
async function mkPost(slug: string): Promise<string> {
  const [row] = await db.insert(s.posts).values({ slug, title: slug, contentJson: { type: "doc", content: [] }, contentHtml: "", toc: [], status: "draft" } as never).returning();
  return (row as { id: string }).id;
}

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
  ({ db } = await import("../../db/index.js"));
  s = await import("../../db/schema.js");
  admin = await createTestUser({ role: "admin", name: "Owner" });
  const creds = { email: admin.email, password: TEST_USER_PASSWORD };
  writer = (await connect(app, creds, { scope: "blog:read posts:write offline_access" })).tokens.access_token;
  readOnly = (await connect(app, creds, { scope: "blog:read offline_access" })).tokens.access_token;
  postId = await mkPost("mcp-main-video");
  jobId = await mkJob(postId);
  otherJobId = await mkJob(await mkPost("mcp-main-video-other"));
});

describe("update_post main_video_job_id", () => {
  it("is in the schema and needs no video:render", async () => {
    const tools = (await mcpCall(app, writer, "tools/list")).body.result.tools as Json[];
    const t = tools.find((x) => x.name === "update_post")!;
    expect(t.inputSchema.properties).toHaveProperty("main_video_job_id");
    expect(tools.map((x) => x.name)).not.toContain("start_video_render");
  });

  it("sets, shows it in get_post and the post block, then clears", async () => {
    const set = await call(writer, "update_post", { id: postId, expected_updated_at: await token(), main_video_job_id: jobId });
    expect(set.isError, set.text).toBe(false);
    expect(set.json.changed).toContain("main_video");
    expect(set.json.post.mainVideo).toMatchObject({ jobId, width: 1920, height: 1080, mime: "video/mp4" });
    const got = (await call(writer, "get_post", { id: postId })).json as Json;
    expect(got.post.mainVideo).toMatchObject({ jobId, seconds: 30 });

    const clear = await call(writer, "update_post", { id: postId, expected_updated_at: await token(), main_video_job_id: null });
    expect(clear.isError, clear.text).toBe(false);
    expect(clear.json.post.mainVideo).toBeUndefined();
    expect(((await call(writer, "get_post", { id: postId })).json as Json).post.mainVideo).toBeNull();
  });

  it("refuses another post's job and a malformed id; nothing is written", async () => {
    const wrong = await call(writer, "update_post", { id: postId, expected_updated_at: await token(), main_video_job_id: otherJobId });
    expect(wrong.isError).toBe(true);
    const bad = await call(writer, "update_post", { id: postId, expected_updated_at: await token(), main_video_job_id: "nope" });
    expect(bad.isError).toBe(true);
    expect(((await call(writer, "get_post", { id: postId })).json as Json).post.mainVideo).toBeNull();
  });

  it("a connection without posts:write cannot call update_post at all", async () => {
    const r = await call(readOnly, "update_post", { id: postId, expected_updated_at: await token(), main_video_job_id: jobId });
    expect(r.isError).toBe(true);
    expect(r.json.error).toMatchObject({ code: "insufficient_scope", requiredScope: "posts:write" });
  });
});
