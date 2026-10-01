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
