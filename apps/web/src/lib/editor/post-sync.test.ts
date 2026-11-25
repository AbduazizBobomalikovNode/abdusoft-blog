import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminPostDetail } from "@blog/shared";
import { AdminApiError, adminApi, asPostConflict } from "@/lib/admin-client";
import { isConflictFailure, payloadAlreadyApplied, PostConflictBlockedError, PostSync } from "./post-sync";

/**
 * Soxta server: `updatedAt` tokenini tekshiradi (haqiqiy API kabi: farq qilsa 409 + joriy `updatedAt`, kim va qaysi kanal),
 * har bir yozuvda tokenni oshiradi. So'rovlar tasodifiy kechikish bilan keladi — navbat bo'lmasa poyga ro'y beradi.
 */
function installFakeServer(initial = "2026-10-01T10:00:00.000Z") {
  const state = {
    updatedAt: initial,
    updatedBy: { id: "u1", name: "Aziz" } as { id: string; name: string | null } | null,
    via: "web" as string | null,
    log: [] as { path: string; token: string | undefined; status: number }[],
    inFlight: 0,
    maxInFlight: 0,
    delays: [] as number[],
  };
  let counter = 0;
  const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    await new Promise((resolve) => setTimeout(resolve, state.delays.shift() ?? 0));
    state.inFlight -= 1;
    const token = typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : undefined;
    if (token !== undefined && token !== state.updatedAt) {
      state.log.push({ path, token, status: 409 });
      return new Response(
        JSON.stringify({ error: "Post boshqa joyda o'zgartirilgan", updatedAt: state.updatedAt, updatedBy: state.updatedBy, via: state.via }),
        { status: 409 },
      );
    }
    counter += 1;
    state.updatedAt = new Date(Date.parse(initial) + counter * 1000).toISOString();
    state.updatedBy = { id: "me", name: "Men" };
    state.via = "web";
    state.log.push({ path, token, status: 200 });
    return new Response(JSON.stringify({ id: "p1", status: "draft", updatedAt: state.updatedAt }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchStub);
  return state;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PostSync serialisation and token handling", () => {
  it("runs autosave + settings change + publish started together one after another, each with the previous response's token", async () => {
    const server = installFakeServer();
    server.delays = [30, 5, 1]; // birinchi so'rov eng sekin — navbatsiz bo'lsa oxirgisi o'zib ketardi
    const sync = new PostSync(server.updatedAt);

    const results = await Promise.all([
      sync.run((token) => adminApi.updatePost("p1", { contentJson: {}, ...(token ? { expectedUpdatedAt: token } : {}) })),
      sync.run((token) => adminApi.updatePost("p1", { settings: { showToc: true }, ...(token ? { expectedUpdatedAt: token } : {}) })),
      sync.run((token) => adminApi.publishPost("p1", { expectedUpdatedAt: token })),
    ]);

    expect(server.log.map((entry) => entry.status)).toEqual([200, 200, 200]);
    expect(server.maxInFlight).toBe(1);
    expect(server.log.map((entry) => entry.path)).toEqual(["/admin/posts/p1", "/admin/posts/p1", "/admin/posts/p1/publish"]);
    expect(server.log[0]!.token).toBe("2026-10-01T10:00:00.000Z");
    expect(server.log[1]!.token).toBe(results[0].updatedAt);
    expect(server.log[2]!.token).toBe(results[1].updatedAt);
    expect(sync.token).toBe(results[2]!.updatedAt);
    expect(sync.conflict).toBeNull();
  });

  it("without the queue the same concurrent requests would false-conflict (proves the test is meaningful)", async () => {
    const server = installFakeServer();
    const token = server.updatedAt;
    const outcomes = await Promise.allSettled([
      adminApi.updatePost("p1", { title: "a", expectedUpdatedAt: token }),
      adminApi.updatePost("p1", { title: "b", expectedUpdatedAt: token }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
  });

  it("a response without updatedAt (e.g. { ok: true }) keeps the current token", async () => {
    const sync = new PostSync("t0");
    await sync.run(async () => ({}));
    expect(sync.token).toBe("t0");
  });

  it("a failed non-conflict request releases the queue and keeps the token", async () => {
    const sync = new PostSync("t0");
    await expect(sync.run(async () => Promise.reject(new AdminApiError(500, "xato")))).rejects.toThrow("xato");
    expect(sync.conflict).toBeNull();
    await expect(sync.run(async (token) => ({ updatedAt: `${token}-yangi` }))).resolves.toEqual({ updatedAt: "t0-yangi" });
  });

  it("a slug 409 (no updatedAt in the body) is NOT a concurrency conflict", async () => {
    const sync = new PostSync("t0");
    const slugError = new AdminApiError(409, "Bu slug band", undefined, undefined, { error: "Bu slug band" });
    await expect(sync.run(async () => Promise.reject(slugError))).rejects.toBe(slugError);
    expect(sync.conflict).toBeNull();
    expect(isConflictFailure(slugError)).toBe(false);
    await expect(sync.run(async () => ({ updatedAt: "t1" }))).resolves.toBeTruthy();
  });
});

describe("PostSync on a genuine 409", () => {
  let server: ReturnType<typeof installFakeServer>;
  beforeEach(() => {
    server = installFakeServer();
  });

  it("records who/via, stops sending requests and never retries on its own", async () => {
    const sync = new PostSync("2001-01-01T00:00:00.000Z"); // eskirgan token
    server.updatedBy = { id: "u9", name: "Assistent egasi" };
    server.via = "mcp";
    const listener = vi.fn();
    sync.subscribe(listener);

    const failure = await sync.run((token) => adminApi.updatePost("p1", { title: "x", expectedUpdatedAt: token })).catch((e: unknown) => e);
    expect(asPostConflict(failure)).toMatchObject({ updatedAt: server.updatedAt, via: "mcp", updatedBy: { id: "u9", name: "Assistent egasi" } });
    expect(sync.conflict).toMatchObject({ via: "mcp" });
    expect(listener).toHaveBeenCalledTimes(1);

    // Keyingi so'rovlar (avtosaqlash taymeri, chop etish tugmasi, ...) tarmoqqa chiqmaydi.
    const callsBefore = server.log.length;
    const blocked = await Promise.allSettled([
      sync.run((token) => adminApi.updatePost("p1", { title: "y", expectedUpdatedAt: token })),
      sync.run((token) => adminApi.publishPost("p1", { expectedUpdatedAt: token })),
    ]);
    expect(blocked.every((outcome) => outcome.status === "rejected" && outcome.reason instanceof PostConflictBlockedError)).toBe(true);
    expect(server.log).toHaveLength(callsBefore);
    expect(isConflictFailure(new PostConflictBlockedError())).toBe(true);
  });

  it("'load latest' (resolve) clears the conflict and continues with the server's token", async () => {
    const sync = new PostSync("2001-01-01T00:00:00.000Z");
    await sync.run((token) => adminApi.updatePost("p1", { title: "x", expectedUpdatedAt: token })).catch(() => undefined);
    const listener = vi.fn();
    sync.subscribe(listener);
    sync.resolve(server.updatedAt);
    expect(sync.conflict).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    await expect(sync.run((token) => adminApi.updatePost("p1", { title: "z", expectedUpdatedAt: token }))).resolves.toBeTruthy();
    expect(server.log.at(-1)!.status).toBe(200);
  });

  it("'overwrite with mine' writes once WITHOUT a token, clears the conflict and adopts the new token", async () => {
    const sync = new PostSync("2001-01-01T00:00:00.000Z");
    await sync.run((token) => adminApi.updatePost("p1", { title: "x", expectedUpdatedAt: token })).catch(() => undefined);
    expect(sync.conflict).not.toBeNull();

    const result = await sync.runForced(() => adminApi.updatePost("p1", { title: "x", snapshot: true }));
    expect(server.log.at(-1)).toMatchObject({ status: 200, token: undefined });
    expect(sync.conflict).toBeNull();
    expect(sync.token).toBe(result.updatedAt);

    // Keyingi oddiy so'rov yana tokenli va muvaffaqiyatli.
    await sync.run((token) => adminApi.updatePost("p1", { title: "keyin", expectedUpdatedAt: token }));
    expect(server.log.at(-1)).toMatchObject({ status: 200, token: result.updatedAt });
  });

  it("a failed forced write keeps the conflict (nothing is lost, no loop)", async () => {
    const sync = new PostSync("2001-01-01T00:00:00.000Z");
    await sync.run((token) => adminApi.updatePost("p1", { title: "x", expectedUpdatedAt: token })).catch(() => undefined);
    await expect(sync.runForced(async () => Promise.reject(new AdminApiError(0, "Serverga ulanib bo'lmadi")))).rejects.toThrow();
    expect(sync.conflict).not.toBeNull();
  });

  it("two requests in flight when the conflict happens: the second is rejected without hitting the network", async () => {
    const sync = new PostSync("2001-01-01T00:00:00.000Z");
    const [first, second] = await Promise.allSettled([
      sync.run((token) => adminApi.updatePost("p1", { title: "1", expectedUpdatedAt: token })),
      sync.run((token) => adminApi.updatePost("p1", { title: "2", expectedUpdatedAt: token })),
    ]);
    expect(first.status).toBe("rejected");
    expect(second.status === "rejected" && second.reason instanceof PostConflictBlockedError).toBe(true);
    expect(server.log).toHaveLength(1);
  });
});

describe("payloadAlreadyApplied (own lost-response retry / identical second tab)", () => {
  const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
  const server = {
    title: "T",
    slug: "t",
    excerpt: "Q",
    coverUrl: null,
    pinned: false,
    contentJson: doc("matn"),
    tags: [{ id: "1", slug: "a", name: "A" }],
    settings: { showToc: true, allowComments: true },
  } as unknown as AdminPostDetail;

  it("is true only when every field the client wanted to write is already stored", () => {
    expect(payloadAlreadyApplied({ title: "T", contentJson: doc("matn") }, server)).toBe(true);
    expect(payloadAlreadyApplied({ title: "T", contentJson: doc("boshqa") }, server)).toBe(false);
    expect(payloadAlreadyApplied({ tagSlugs: ["a"] }, server)).toBe(true);
    expect(payloadAlreadyApplied({ tagSlugs: ["a", "b"] }, server)).toBe(false);
    expect(payloadAlreadyApplied({ settings: { showToc: true } }, server)).toBe(true);
    expect(payloadAlreadyApplied({ settings: { showToc: false } }, server)).toBe(false);
  });

  it("is false for an empty payload, an auto-excerpt request and unknown fields", () => {
    expect(payloadAlreadyApplied({}, server)).toBe(false);
    expect(payloadAlreadyApplied({ excerpt: null }, server)).toBe(false);
    expect(payloadAlreadyApplied({ scheduledAt: "x" }, server)).toBe(false);
    expect(payloadAlreadyApplied({ expectedUpdatedAt: "x" }, server)).toBe(false);
  });
});
