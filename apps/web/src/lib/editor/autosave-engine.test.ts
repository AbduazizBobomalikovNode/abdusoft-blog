import { describe, expect, it } from "vitest";
import type { AdminPostDetail, UpdatePostBody } from "@blog/shared";
import { AdminApiError } from "@/lib/admin-client";
import { AutosaveEngine, localMatchesServer, PendingNotSavedError, type EngineApi, type LocalFields } from "./autosave-engine";
import { backupFieldKeys, loadBackup, type StorageLike } from "./draft-backup";
import { PostConflictBlockedError, PostSync } from "./post-sync";

const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

function memory(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const INITIAL: LocalFields = {
  title: "Sarlavha",
  slug: "sarlavha",
  excerpt: "Tavsif",
  coverUrl: null,
  tagSlugs: ["a"],
  contentJson: doc("Boshlang'ich"),
  settings: { showToc: true },
  pinned: false,
};

/** Soxta server: haqiqiy API kabi tokenni tekshiradi, 409 qaytaradi, har yozuvda tokenni oshiradi. */
function fakeServer() {
  const state = {
    updatedAt: "2026-10-01T10:00:00.000Z",
    updatedBy: { id: "u1", name: "Men" } as { id: string; name: string | null } | null,
    via: "web" as string | null,
    fields: { ...INITIAL } as Record<string, unknown>,
    calls: [] as { kind: string; body?: UpdatePostBody }[],
    failNext: [] as unknown[],
    gate: null as null | Promise<void>,
  };
  let n = 0;
  const touch = () => {
    n += 1;
    state.updatedAt = new Date(Date.parse("2026-10-01T10:00:00.000Z") + n * 1000).toISOString();
  };
  const api: EngineApi = {
    async updatePost(_id, body) {
      state.calls.push({ kind: "update", body });
      if (state.gate) await state.gate;
      const failure = state.failNext.shift();
      if (failure) throw failure;
      if (body.expectedUpdatedAt !== undefined && body.expectedUpdatedAt !== state.updatedAt) {
        throw new AdminApiError(409, "boshqa joyda", undefined, undefined, {
          error: "boshqa joyda",
          updatedAt: state.updatedAt,
          updatedBy: state.updatedBy,
          via: state.via,
        });
      }
      const { expectedUpdatedAt: _e, overwrite: _o, ...fields } = body;
      void _e;
      void _o;
      Object.assign(state.fields, fields);
      touch();
      state.updatedBy = { id: "u1", name: "Men" };
      state.via = "web";
      return { updatedAt: state.updatedAt };
    },
    async getPost() {
      state.calls.push({ kind: "get" });
      const f = state.fields as Record<string, unknown>;
      return {
        id: "p1",
        updatedAt: state.updatedAt,
        title: f.title,
        slug: f.slug,
        excerpt: f.excerpt,
        coverUrl: f.coverUrl,
        tags: (f.tagSlugs as string[]).map((slug) => ({ id: slug, slug, name: slug })),
        contentJson: f.contentJson,
        settings: f.settings,
        pinned: f.pinned,
        channelPlan: null,
        status: f.status ?? "draft",
        scheduledAt: f.scheduledAt ?? null,
        publishedAt: f.publishedAt ?? null,
      } as unknown as AdminPostDetail;
    },
  };
  /** Boshqa yozuvchi (tab/yordamchi) postni o'zgartiradi. */
  const externalEdit = (fields: Record<string, unknown>, by: { id: string; name: string | null } | null = { id: "u2", name: "Dilnoza" }, via = "mcp") => {
    Object.assign(state.fields, fields);
    touch();
    state.updatedBy = by;
    state.via = via;
  };
  return { state, api, externalEdit };
}

function setup(over: { meId?: string; online?: () => boolean; managed?: boolean } = {}) {
  const server = fakeServer();
  const storage = memory();
  const sync = new PostSync(server.state.updatedAt);
  const slugNotices: string[] = [];
  const engine = new AutosaveEngine({
    postId: "p1",
    sync,
    api: server.api,
    storage,
    initialUpdatedAt: server.state.updatedAt,
    initialLocal: INITIAL,
    initialManaged: over.managed === false ? undefined : { status: "draft", scheduledAt: null, publishedAt: null },
    meId: over.meId ?? "u1",
    now: () => 1_000_000,
    isOnline: over.online,
    onSlugConflict: (m) => slugNotices.push(m),
  });
  engine.attach();
  return { ...server, calls: server.state.calls, failNext: server.state.failNext, storage, sync, engine, slugNotices };
}

describe("saving", () => {
  it("saves pending fields with the latest token, clears the backup and never shows a banner for its own saves", async () => {
    const t = setup();
    t.engine.queueSave({ title: "Yangi" });
    t.engine.queueSave({ contentJson: doc("matn") });
    expect(t.engine.dirty).toBe(true);
    const outcome = await t.engine.flush();
    expect(outcome.kind).toBe("saved");
    expect(t.calls.filter((c) => c.kind === "update")).toHaveLength(1);
    expect(t.calls[0]!.body).toMatchObject({ title: "Yangi", expectedUpdatedAt: "2026-10-01T10:00:00.000Z" });
    expect(t.engine.conflict).toBeNull();
    expect(t.engine.dirty).toBe(false);
    expect(t.storage.data.size).toBe(0);
  });

  it("classifies failures: offline keeps text and asks for retry; 5xx retries; other errors do not", async () => {
    const t = setup();
    t.engine.queueSave({ title: "Oflayn" });
    t.failNext.push(new AdminApiError(0, "Serverga ulanib bo'lmadi"));
    expect((await t.engine.flush()).kind).toBe("offline");
    expect(t.engine.state).toBe("offline");
    expect(t.engine.pendingKeys).toEqual(["title"]);
    expect(loadBackup(t.storage, "p1")?.title).toBe("Oflayn");
    t.failNext.push(new AdminApiError(503, "Server xatosi"));
    expect(await t.engine.flush()).toMatchObject({ kind: "error", retry: true });
    t.failNext.push(new AdminApiError(400, "Noto'g'ri"));
    expect(await t.engine.flush()).toMatchObject({ kind: "error", retry: false });
    // Hammasi o'tgach — saqlanadi:
    expect((await t.engine.flush()).kind).toBe("saved");
  });

  it("drops a taken slug and retries the rest once, keeping the text", async () => {
    const t = setup();
    t.engine.queueSave({ slug: "band", title: "Matn bor" });
    t.failNext.push(new AdminApiError(409, "Bu slug band"));
    const outcome = await t.engine.flush();
    expect(outcome.kind).toBe("saved");
    expect(t.slugNotices).toHaveLength(1);
    expect(t.calls.filter((c) => c.kind === "update")[1]!.body).toMatchObject({ title: "Matn bor" });
    expect(t.calls.filter((c) => c.kind === "update")[1]!.body).not.toHaveProperty("slug");
  });
});

describe("item 4: a transition never overtakes the last keystrokes", () => {
  it("typing during an in-flight save, then publish immediately: save, save-the-rest, then publish", async () => {
    const t = setup();
    let release!: () => void;
    t.state.gate = new Promise<void>((resolve) => (release = resolve));
    t.engine.queueSave({ contentJson: doc("birinchi") });
    const first = t.engine.flush(); // yo'lda
    await Promise.resolve();
    t.engine.queueSave({ contentJson: doc("birinchi + oxirgi so'zlar") }); // yozish davom etdi
    const order: string[] = [];
    const publish = t.engine.runTransition(async (token) => {
      order.push(`publish token=${token}`);
      order.push(`server text at publish: ${JSON.stringify(t.state.fields.contentJson).includes("oxirgi so'zlar")}`);
      return { updatedAt: "yangi" };
    });
    t.state.gate = null;
    release();
    await first;
    await publish;
    const updates = t.calls.filter((c) => c.kind === "update");
    expect(updates).toHaveLength(2);
    expect(order[1]).toBe("server text at publish: true");
    expect(order[0]).toMatch(/^publish token=2026-10-01T10:00:0[2-9]/);
  });

  it("does not publish when the text could not be saved (offline / 5xx), and keeps the text recoverable", async () => {
    const t = setup();
    t.engine.queueSave({ title: "Saqlanmagan matn" });
    t.failNext.push(new AdminApiError(0, "Serverga ulanib bo'lmadi"));
    let ran = false;
    const failure = await t.engine.runTransition(async () => ((ran = true), {})).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PendingNotSavedError);
    expect(ran).toBe(false);
    expect(t.engine.pendingKeys).toEqual(["title"]);
    expect(loadBackup(t.storage, "p1")?.title).toBe("Saqlanmagan matn");
  });

  it("a conflict before the transition blocks it without touching the network", async () => {
    const t = setup();
    t.externalEdit({ title: "Boshqa" });
    t.engine.queueSave({ title: "Mening" });
    await t.engine.flush();
    expect(t.engine.conflict).not.toBeNull();
    const before = t.calls.length;
    const failure = await t.engine.runTransition(async () => ({})).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PostConflictBlockedError);
    expect(t.calls.length).toBe(before);
  });
});

describe("item 3: a silent token refresh never leads to a silent overwrite", () => {
  it("two tabs of one user: tab A pending {title}, tab B saved new content -> banner, NOT refreshed", async () => {
    const t = setup({ meId: "u1" });
    t.externalEdit({ contentJson: doc("TAB B matni") }, { id: "u1", name: "Men" }, "web");
    t.engine.queueSave({ title: "A sarlavhasi" }); // faqat sarlavha kutmoqda, serverdagi sarlavha o'zgarmagan
    const outcome = await t.engine.flush();
    expect(outcome.kind).toBe("conflict");
    expect(t.engine.conflict).toMatchObject({ via: "web", updatedBy: { id: "u1" } });
    // A ning keyingi matn avtosaqlashi tokenli bo'lib B ning matnini bosib ketmaydi:
    t.engine.queueSave({ contentJson: doc("A ning eski asosidagi matni") });
    const calls = t.calls.length;
    expect((await t.engine.flush()).kind).toBe("conflict");
    expect(t.calls.length).toBe(calls);
    expect(JSON.stringify(t.state.fields.contentJson)).toContain("TAB B matni");
  });

  it("refreshes silently only when the server already holds EVERYTHING the editor holds (lost-response retry)", async () => {
    const t = setup({ meId: "u1" });
    t.engine.queueSave({ title: "Yangi", contentJson: doc("Yangi matn") });
    // So'rov serverga yetdi, lekin javob yo'qoldi (token eskirdi): server holati = bizniki.
    t.externalEdit({ title: "Yangi", contentJson: doc("Yangi matn") }, { id: "u1", name: "Men" }, "web");
    const outcome = await t.engine.flush();
    expect(outcome.kind).toBe("saved");
    expect(t.engine.conflict).toBeNull();
    expect(t.sync.token).toBe(t.state.updatedAt);
    expect(t.engine.dirty).toBe(false);
  });

  it("a different actor (assistant) always gets the banner, even if the payload fields happen to match", async () => {
    const t = setup({ meId: "u1" });
    t.externalEdit({ title: "Yangi" }, { id: "u2", name: "Dilnoza" }, "mcp");
    t.engine.queueSave({ title: "Yangi" });
    expect((await t.engine.flush()).kind).toBe("conflict");
  });

  it("localMatchesServer compares every field the editor owns", () => {
    const server = { title: "T", slug: "t", excerpt: "Q", coverUrl: null, tags: [{ slug: "a" }], contentJson: doc("x"), settings: { showToc: true }, pinned: false, channelPlan: null } as unknown as AdminPostDetail;
    const local: LocalFields = { title: "T", slug: "t", excerpt: "Q", coverUrl: null, tagSlugs: ["a"], contentJson: doc("x"), settings: { showToc: true }, pinned: false };
    expect(localMatchesServer(local, server)).toBe(true);
    for (const patch of [{ title: "X" }, { slug: "x" }, { excerpt: "X" }, { coverUrl: "/a" }, { tagSlugs: ["b"] }, { contentJson: doc("y") }, { settings: { showToc: false } }, { pinned: true }] as Partial<LocalFields>[]) {
      expect(localMatchesServer({ ...local, ...patch }, server)).toBe(false);
    }
    expect(localMatchesServer({ title: "T" }, server)).toBe(true); // faqat ushlab turgan kalitlar
  });
});

describe("item 1: 'load latest' loses nothing", () => {
  it("keeps EVERY unsaved field in the backup and the offer, and lists which ones would come back", async () => {
    const t = setup();
    t.externalEdit({ contentJson: doc("Yordamchi yozdi"), title: "Yordamchi sarlavhasi" });
    t.engine.queueSave({ excerpt: "Yangi tavsif" });
    t.engine.queueSave({ tagSlugs: ["a", "b"] });
    t.engine.queueSave({ coverUrl: "/muqova.png" });
    t.engine.queueSave({ slug: "yangi-havola" });
    t.engine.queueSave({ settings: { showToc: false } });
    t.engine.queueSave({ pinned: true });
    t.engine.queueSave({ title: "Mening sarlavham", contentJson: doc("Mening matnim") });
    expect((await t.engine.flush()).kind).toBe("conflict");

    const { fresh, offer, fields } = await t.engine.loadLatest();
    expect(fresh.title).toBe("Yordamchi sarlavhasi");
    expect(offer).not.toBeNull();
    expect(new Set(backupFieldKeys(offer!))).toEqual(new Set(["excerpt", "tagSlugs", "coverUrl", "slug", "settings", "pinned", "title", "contentJson"]));
    expect(offer!.extra).toMatchObject({ excerpt: "Yangi tavsif", tagSlugs: ["a", "b"], coverUrl: "/muqova.png", slug: "yangi-havola", settings: { showToc: false }, pinned: true });
    expect(offer!.title).toBe("Mening sarlavham");
    expect(new Set(fields)).toEqual(new Set(["excerpt", "tagSlugs", "coverUrl", "slug", "settings", "pinned", "title", "contentJson"]));
    // mahalliy zaxira ham saqlangan (yangi format):
    expect(loadBackup(t.storage, "p1")?.extra).toMatchObject({ excerpt: "Yangi tavsif" });
    // tahrirlagich serverdan qayta quriladi: kutayotganlar tashlanadi, token yangilanadi, banner yo'q
    expect(t.engine.dirty).toBe(false);
    expect(t.sync.conflict).toBeNull();
    expect(t.sync.token).toBe(fresh.updatedAt);
  });

  it("a local field that equals the server copy is not offered; no differences means no offer and a cleaned backup", async () => {
    const t = setup();
    t.externalEdit({ excerpt: "Bir xil tavsif" });
    t.engine.queueSave({ excerpt: "Bir xil tavsif" });
    t.engine.queueSave({ pinned: true });
    await t.engine.flush();
    const first = await t.engine.loadLatest();
    expect(first.fields).toEqual(["pinned"]);

    const t2 = setup();
    t2.externalEdit({ title: "Boshqa" });
    t2.engine.queueSave({ title: "Boshqa" });
    const second = await t2.engine.loadLatest();
    expect(second.offer).toBeNull();
    expect(t2.storage.data.size).toBe(0);
  });

  it("the text survives even when localStorage is unavailable (the offer is held in memory)", async () => {
    const server = fakeServer();
    const sync = new PostSync(server.state.updatedAt);
    const engine = new AutosaveEngine({ postId: "p1", sync, api: server.api, storage: null, initialUpdatedAt: server.state.updatedAt, initialLocal: INITIAL, meId: "u1" });
    server.externalEdit({ contentJson: doc("Boshqa") });
    engine.queueSave({ contentJson: doc("Mening matnim") });
    const { offer } = await engine.loadLatest();
    expect(JSON.stringify(offer?.contentJson)).toContain("Mening matnim");
  });

  it("scheduler publishing while the editor is open: the next autosave conflicts, and load latest keeps the typed text", async () => {
    const t = setup();
    t.externalEdit({ status: "published" }, null, "scheduler");
    t.engine.queueSave({ contentJson: doc("Yozayotgan matnim") });
    const outcome = await t.engine.flush();
    expect(outcome.kind).toBe("conflict");
    expect(t.engine.conflict).toMatchObject({ via: "scheduler", updatedBy: null });
    const { offer } = await t.engine.loadLatest();
    expect(JSON.stringify(offer?.contentJson)).toContain("Yozayotgan matnim");
  });
});

describe("item 2: 'overwrite with mine' sends the complete editor state", () => {
  it("sends every field once, without a token, with overwrite:true, so the result is exactly the user's version", async () => {
    const t = setup();
    t.externalEdit({ title: "Yordamchi", excerpt: "Yordamchi tavsifi", tagSlugs: ["z"], settings: { showToc: false }, pinned: true });
    t.engine.queueSave({ contentJson: doc("Mening matnim") }); // faqat matn o'zgardi
    expect((await t.engine.flush()).kind).toBe("conflict");

    expect(await t.engine.overwrite()).toBe(true);
    const sent = t.calls.filter((c) => c.kind === "update").at(-1)!.body!;
    expect(sent).not.toHaveProperty("expectedUpdatedAt");
    expect(sent.overwrite).toBe(true);
    expect(sent).toMatchObject({ title: "Sarlavha", excerpt: "Tavsif", tagSlugs: ["a"], settings: { showToc: true }, pinned: false, slug: "sarlavha" });
    // Server nusxasi = muharrirning to'liq holati (aralash emas):
    expect(t.state.fields).toMatchObject({ title: "Sarlavha", excerpt: "Tavsif", tagSlugs: ["a"], pinned: false });
    expect(t.engine.conflict).toBeNull();
    expect(t.engine.dirty).toBe(false);
    expect(t.storage.data.size).toBe(0);
    // Keyingi oddiy saqlash tokenli va konfliktsiz:
    t.engine.queueSave({ title: "Keyin" });
    expect((await t.engine.flush()).kind).toBe("saved");
  });

  it("omits an empty slug, and a failed overwrite keeps the conflict and the pending text", async () => {
    const t = setup();
    t.engine.queueSave({ slug: "   " });
    expect(t.engine.fullPayload()).not.toHaveProperty("slug");
    t.externalEdit({ title: "Boshqa" });
    t.engine.queueSave({ title: "Mening" });
    await t.engine.flush();
    t.failNext.push(new AdminApiError(0, "Serverga ulanib bo'lmadi"));
    expect(await t.engine.overwrite()).toBe(false);
    expect(t.engine.state).toBe("conflict");
    expect(t.engine.pendingKeys).toContain("title");
    expect(loadBackup(t.storage, "p1")?.title).toBe("Mening");
  });
});

describe("item 6: nothing pending", () => {
  it("a conflict caused by a transition leaves the engine not dirty (the editor reloads from the server instead of adopting a token)", async () => {
    const t = setup();
    t.externalEdit({ title: "Yordamchi" });
    const failure = await t.engine.runTransition((token) => t.api.updatePost("p1", { title: "x", expectedUpdatedAt: token })).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AdminApiError);
    expect(t.engine.conflict).not.toBeNull();
    expect(t.engine.dirty).toBe(false);
  });
});

describe("item 5: restore from history", () => {
  it("text typed while the restore request was in flight is kept as an offer, not discarded", async () => {
    const t = setup();
    t.engine.queueSave({ title: "Oldin saqlangan" });
    const mark = t.engine.editCount;
    const restore = t.engine.runTransition(async () => {
      t.engine.queueSave({ contentJson: doc("So'rov paytida yozildi") });
      return { updatedAt: "yangi" };
    });
    await restore;
    const kept = t.engine.takeOver(mark);
    expect(kept).not.toBeNull();
    expect(JSON.stringify(kept!.contentJson)).toContain("So'rov paytida yozildi");
    expect(backupFieldKeys(kept!)).toEqual(["contentJson"]);
    expect(t.engine.dirty).toBe(false);
  });

  it("nothing typed meanwhile: pending is dropped and the stale backup cleared", async () => {
    const t = setup();
    t.engine.queueSave({ title: "A" });
    await t.engine.flush();
    t.engine.writeBackup();
    const mark = t.engine.editCount;
    expect(t.engine.takeOver(mark)).toBeNull();
    expect(t.storage.data.size).toBe(0);
  });
});

describe("unsaved text survives every conflict path", () => {
  it("autosave 409, transition 409 with pending text, and forced-overwrite failure all leave a complete backup", async () => {
    // 1) avtosaqlash 409
    const a = setup();
    a.externalEdit({ title: "B" });
    a.engine.queueSave({ title: "A", excerpt: "A tavsifi" });
    await a.engine.flush();
    expect(loadBackup(a.storage, "p1")).toMatchObject({ title: "A", extra: { excerpt: "A tavsifi" } });

    // 2) holat o'tishi 409 (boshqa yozuvchi), kutayotgan matn bilan: o'tish bloklanadi va zaxira yoziladi
    const b = setup();
    b.engine.queueSave({ contentJson: doc("Kutayotgan matn") });
    b.externalEdit({ title: "Tashqi" });
    // matn avtosaqlanishi 409 beradi:
    await b.engine.runTransition(async () => ({})).catch(() => undefined);
    expect(b.engine.conflict).not.toBeNull();
    expect(JSON.stringify(loadBackup(b.storage, "p1")?.contentJson)).toContain("Kutayotgan matn");
    expect(b.engine.pendingKeys).toContain("contentJson");
  });

  it("no retry loop: after a conflict every later flush is a no-network no-op", async () => {
    const t = setup();
    t.externalEdit({ title: "B" });
    t.engine.queueSave({ title: "A" });
    await t.engine.flush();
    const calls = t.calls.length;
    for (let i = 0; i < 5; i++) await t.engine.flush();
    expect(t.calls.length).toBe(calls);
  });

  it("a conflict raised by another request while text is pending writes the backup immediately", async () => {
    const t = setup();
    t.engine.queueSave({ excerpt: "Hali saqlanmagan" });
    t.externalEdit({ title: "Tashqi" });
    await t.sync.run((token) => t.api.updatePost("p1", { pinned: true, expectedUpdatedAt: token })).catch(() => undefined);
    expect(t.engine.conflict).not.toBeNull();
    expect(t.engine.state).toBe("conflict");
    expect(loadBackup(t.storage, "p1")?.extra).toMatchObject({ excerpt: "Hali saqlanmagan" });
  });
});

describe("React Strict Mode (effects mount, unmount, mount again)", () => {
  it("a conflict from a transition still reaches the engine after detach + re-attach", async () => {
    const server = fakeServer();
    const sync = new PostSync(server.state.updatedAt);
    const engine = new AutosaveEngine({ postId: "p1", sync, api: server.api, storage: memory(), initialUpdatedAt: server.state.updatedAt, initialLocal: INITIAL, meId: "u1" });
    const detach = engine.attach();
    detach(); // Strict Mode: tozalash...
    engine.attach(); // ...va qayta ulanish
    server.externalEdit({ title: "Tashqi" });
    await engine.runTransition((token) => server.api.updatePost("p1", { title: "x", expectedUpdatedAt: token })).catch(() => undefined);
    expect(engine.conflict).not.toBeNull();
    expect(engine.state).toBe("conflict");
  });
});


describe("round 4, item 1: a lost response followed by more typing is still the user's own save", () => {
  it("adopts the fresh token silently and sends only what was typed afterwards", async () => {
    const t = setup({ meId: "u1" });
    t.engine.queueSave({ title: "Yo'qolgan javobli saqlash" });
    // Server so'rovni oldi (o'zimiz, veb), lekin javob yo'qoldi:
    t.externalEdit({ title: "Yo'qolgan javobli saqlash" }, { id: "u1", name: "Men" }, "web");
    const freshToken = t.state.updatedAt;
    // Qayta urinishdan oldin foydalanuvchi yozishda davom etdi:
    let gate!: () => void;
    t.state.gate = new Promise<void>((r) => (gate = r));
    const flushing = t.engine.flush();
    await Promise.resolve();
    t.engine.queueSave({ contentJson: doc("Keyin yozilgan matn") });
    t.state.gate = null;
    gate();
    const outcome = await flushing;
    expect(outcome.kind).toBe("saved");
    expect(t.engine.conflict).toBeNull();
    // Yangi harflar yangi token bilan yuborildi va serverda:
    expect(JSON.stringify(t.state.fields.contentJson)).toContain("Keyin yozilgan matn");
    expect(t.engine.dirty).toBe(false);
    const updates = t.calls.filter((c) => c.kind === "update");
    expect(updates.at(-1)!.body).toMatchObject({ contentJson: doc("Keyin yozilgan matn"), expectedUpdatedAt: freshToken });
    expect(updates.at(-1)!.body).not.toHaveProperty("title");
  });

  it("still shows the banner in the two-tab case (server differs from BOTH the editor state and the in-flight payload)", async () => {
    const t = setup({ meId: "u1" });
    t.externalEdit({ contentJson: doc("TAB B") }, { id: "u1", name: "Men" }, "web");
    t.engine.queueSave({ title: "A sarlavhasi" });
    let gate!: () => void;
    t.state.gate = new Promise<void>((r) => (gate = r));
    const flushing = t.engine.flush();
    await Promise.resolve();
    t.engine.queueSave({ excerpt: "A yozishda davom etdi" });
    t.state.gate = null;
    gate();
    expect((await flushing).kind).toBe("conflict");
    expect(t.engine.conflict).not.toBeNull();
    expect(JSON.stringify(t.state.fields.contentJson)).toContain("TAB B");
  });
});

describe("round 4, item 2: no stale transition buttons after a silent refresh", () => {
  it("same user published the post elsewhere: the engine asks for a rebuild (stale) and keeps the pending text", async () => {
    const t = setup({ meId: "u1" });
    t.engine.queueSave({ title: "Yangi sarlavha" });
    t.externalEdit({ title: "Yangi sarlavha", status: "published", publishedAt: "2026-10-02T10:00:00.000Z" }, { id: "u1", name: "Men" }, "web");
    let gate!: () => void;
    t.state.gate = new Promise<void>((r) => (gate = r));
    const flushing = t.engine.flush();
    await Promise.resolve();
    t.engine.queueSave({ excerpt: "Keyingi tavsif" });
    t.state.gate = null;
    gate();
    const outcome = await flushing;
    expect(outcome.kind).toBe("stale");
    expect(t.engine.conflict).toBeNull();
    // Kutayotgan yangi yozuv yo'qolmaydi: loadLatest uni taklif sifatida qaytaradi.
    const { offer, fresh } = await t.engine.loadLatest();
    expect(fresh.status).toBe("published");
    expect(offer?.extra).toMatchObject({ excerpt: "Keyingi tavsif" });
  });

  it("the engine's own transitions update the known status, so they never look stale", async () => {
    const t = setup({ meId: "u1" });
    await t.engine.runTransition(async () => {
      t.externalEdit({ status: "published", publishedAt: "2026-10-02T10:00:00.000Z" }, { id: "u1", name: "Men" }, "web");
      return { updatedAt: t.state.updatedAt, status: "published", scheduledAt: null, publishedAt: "2026-10-02T10:00:00.000Z" } as { updatedAt: string };
    });
    t.engine.queueSave({ title: "Chop etilgandan keyin" });
    expect((await t.engine.flush()).kind).toBe("saved");
  });
});

describe("round 4, item 3: the reason a pending save blocks a transition", () => {
  it("passes the server's own message for a validation error, and the connection text for offline", async () => {
    const a = setup();
    a.engine.queueSave({ title: "x" });
    a.failNext.push(new AdminApiError(400, "Noto'g'ri so'rov (excerpt: juda uzun)"));
    const e1 = (await a.engine.runTransition(async () => ({})).catch((e: unknown) => e)) as PendingNotSavedError;
    expect(e1).toBeInstanceOf(PendingNotSavedError);
    expect(e1.message).toContain("excerpt: juda uzun");
    expect(e1.message).not.toContain("aloqa");

    const b = setup();
    b.engine.queueSave({ title: "x" });
    b.failNext.push(new AdminApiError(0, "Serverga ulanib bo'lmadi"));
    const e2 = (await b.engine.runTransition(async () => ({})).catch((e: unknown) => e)) as PendingNotSavedError;
    expect(e2.message).toContain("aloqa");
  });
});

describe("round 4, item 4: no backup gap after an overwrite", () => {
  it("text typed during the overwrite request is written to the backup instead of clearing it", async () => {
    const t = setup();
    t.externalEdit({ title: "Boshqa" });
    t.engine.queueSave({ title: "Mening" });
    await t.engine.flush();
    let gate!: () => void;
    t.state.gate = new Promise<void>((r) => (gate = r));
    const overwriting = t.engine.overwrite();
    await Promise.resolve();
    t.engine.queueSave({ contentJson: doc("Overwrite paytida yozildi") });
    t.state.gate = null;
    gate();
    expect(await overwriting).toBe(true);
    const backup = loadBackup(t.storage, "p1");
    expect(JSON.stringify(backup?.contentJson)).toContain("Overwrite paytida yozildi");
    expect(backup?.dirty).toEqual(["contentJson"]);
  });

  it("with nothing typed meanwhile the backup is cleared", async () => {
    const t = setup();
    t.externalEdit({ title: "Boshqa" });
    t.engine.queueSave({ title: "Mening" });
    await t.engine.flush();
    expect(await t.engine.overwrite()).toBe(true);
    expect(t.storage.data.size).toBe(0);
  });
});
