import { describe, expect, it } from "vitest";
import { clearBackup, loadBackup, saveBackup, serverChangedSinceBackup, shouldOfferRestore, type DraftBackup, type StorageLike } from "./draft-backup";

function memory(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}
const backup = (over: Partial<DraftBackup> = {}): DraftBackup => ({
  v: 1,
  postId: "p1",
  baseUpdatedAt: "2026-10-01T10:00:00.000Z",
  savedAt: Date.parse("2026-10-01T10:05:00.000Z"),
  title: "T",
  contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "yangi" }] }] },
  ...over,
});
const server = { updatedAt: "2026-10-01T10:00:00.000Z", title: "T", contentJson: { type: "doc", content: [{ type: "paragraph" }] } };

describe("draft backup", () => {
  it("round-trips and clears", () => {
    const s = memory();
    expect(saveBackup(s, backup())).toBe(true);
    expect(loadBackup(s, "p1")?.title).toBe("T");
    clearBackup(s, "p1");
    expect(loadBackup(s, "p1")).toBeNull();
  });

  it("survives broken storage and corrupt data", () => {
    const broken: StorageLike = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); }, removeItem: () => { throw new Error("x"); } };
    expect(saveBackup(broken, backup())).toBe(false);
    expect(loadBackup(broken, "p1")).toBeNull();
    expect(() => clearBackup(broken, "p1")).not.toThrow();
    const s = memory();
    s.setItem("blog:draft:p1", "{not json");
    expect(loadBackup(s, "p1")).toBeNull();
    s.setItem("blog:draft:p1", JSON.stringify({ v: 1, postId: "other" }));
    expect(loadBackup(s, "p1")).toBeNull();
  });

  it("offers restore only when backup is newer AND different", () => {
    expect(shouldOfferRestore(backup(), server)).toBe(true);
    expect(shouldOfferRestore(backup({ savedAt: Date.parse(server.updatedAt) - 1000 }), server)).toBe(false);
    expect(shouldOfferRestore(backup({ contentJson: server.contentJson }), server)).toBe(false);
    expect(shouldOfferRestore(null, server)).toBe(false);
  });

  it("detects a server copy that moved on after the backup base", () => {
    expect(serverChangedSinceBackup(backup(), server)).toBe(false);
    expect(serverChangedSinceBackup(backup({ baseUpdatedAt: "2026-10-01T09:00:00.000Z" }), server)).toBe(true);
  });
});

import { backupDiffKeys, backupFieldKeys, backupFieldLabels, backupValue, type ServerFields } from "./draft-backup";

describe("backup format v1 with optional dirty/extra (backward compatible)", () => {
  const srv: ServerFields = {
    title: "T",
    slug: "t",
    excerpt: "Q",
    coverUrl: null,
    tags: [{ slug: "a" }],
    contentJson: { type: "doc", content: [] },
    settings: { showToc: true },
    pinned: false,
  };

  it("an old backup (no dirty/extra) still loads and restores title + content only", () => {
    const s = memory();
    s.setItem("blog:draft:p1", JSON.stringify({ v: 1, postId: "p1", baseUpdatedAt: "x", savedAt: 1, title: "Eski", contentJson: { a: 1 } }));
    const b = loadBackup(s, "p1")!;
    expect(b.title).toBe("Eski");
    expect(b.dirty).toBeUndefined();
    expect(backupFieldKeys(b)).toEqual(["title", "contentJson"]);
  });

  it("round-trips dirty/extra and drops malformed ones", () => {
    const s = memory();
    saveBackup(s, backup({ dirty: ["excerpt", "tagSlugs"], extra: { excerpt: "Yangi", tagSlugs: ["b"] } }));
    const b = loadBackup(s, "p1")!;
    expect(b.dirty).toEqual(["excerpt", "tagSlugs"]);
    expect(backupValue(b, "excerpt")).toBe("Yangi");
    s.setItem("blog:draft:p1", JSON.stringify({ ...b, dirty: "x", extra: [1] }));
    const bad = loadBackup(s, "p1")!;
    expect(bad.dirty).toBeUndefined();
    expect(bad.extra).toBeUndefined();
  });

  it("lists exactly the fields that would come back (differ from the server) with Uzbek labels", () => {
    const b = backup({
      title: "T",
      dirty: ["title", "excerpt", "tagSlugs", "coverUrl", "settings", "pinned", "slug"],
      extra: { excerpt: "Yangi tavsif", tagSlugs: ["a"], coverUrl: "/x.png", settings: { showToc: true }, pinned: true, slug: "t" },
    });
    expect(backupDiffKeys(b, srv)).toEqual(["excerpt", "coverUrl", "pinned"]);
    expect(backupFieldLabels(["excerpt", "coverUrl", "pinned"])).toEqual(["Qisqa tavsif", "Muqova rasmi", "Muhim belgisi"]);
  });
});
