import { describe, expect, it } from "vitest";
import type { DistributionItemDto, DistributionVersionDto } from "@blog/shared";
import { canAddVersion, initialVersionId, isVersionDirty, markPrimary, primaryOf, removeVersion, replaceVersion, saveStateLabel, versionLimitText, versionsOf } from "./distribution-versions";

const ver = (id: string, over: Partial<DistributionVersionDto> = {}): DistributionVersionDto => ({
  id, postId: "p", provider: "x", name: id, text: "t", imageChoice: "auto", linkMode: null, isPrimary: false, createdBy: null, createdVia: "web",
  createdAt: "2026-11-26T10:00:00Z", updatedAt: "2026-11-26T10:00:00Z", ...over,
});
const item = (over: Partial<DistributionItemDto> = {}) => ({ status: "draft", versionId: null, ...over }) as DistributionItemDto;

describe("version strip helpers", () => {
  it("filters by provider and finds the primary", () => {
    const all = [ver("a"), ver("b", { isPrimary: true }), ver("c", { provider: "threads" })];
    expect(versionsOf(all, "x").map((v) => v.id)).toEqual(["a", "b"]);
    expect(primaryOf(versionsOf(all, "x"))?.id).toBe("b");
    expect(primaryOf([ver("a")])).toBeNull();
  });

  it("opens on the primary when editable; otherwise on Standart (null); the item's own version wins; sent rows stay as before", () => {
    const vs = [ver("a"), ver("b", { isPrimary: true })];
    expect(initialVersionId(vs, null, true)).toBe("b");
    expect(initialVersionId(vs, null, false)).toBeNull();
    expect(initialVersionId([ver("a")], null, true)).toBeNull();
    expect(initialVersionId(vs, item({ versionId: "a" }), true)).toBe("a");
    expect(initialVersionId(vs, item({ versionId: "gone" }), true)).toBe("b");
    expect(initialVersionId(vs, item({ status: "sent", versionId: "a" }), true)).toBe("b");
  });

  it("limits to 10 versions", () => {
    const ten = Array.from({ length: 10 }, (_, i) => ver(`v${i}`));
    expect(canAddVersion(ten.slice(0, 9))).toBe(true);
    expect(canAddVersion(ten)).toBe(false);
    expect(versionLimitText(ten.slice(0, 3))).toBe("3/10");
  });

  it("dirty detection compares text, image and link mode", () => {
    const v = ver("a", { text: "x", imageChoice: "og", linkMode: "text", provider: "linkedin" });
    expect(isVersionDirty(v, { text: "x", imageChoice: "og", linkMode: "text" })).toBe(false);
    expect(isVersionDirty(v, { text: "y", imageChoice: "og", linkMode: "text" })).toBe(true);
    expect(isVersionDirty(v, { text: "x", imageChoice: "none", linkMode: "text" })).toBe(true);
    expect(isVersionDirty(v, { text: "x", imageChoice: "og", linkMode: "article" })).toBe(true);
  });

  it("list updates keep primary unique", () => {
    const vs = [ver("a", { isPrimary: true }), ver("b")];
    expect(replaceVersion(vs, ver("b", { isPrimary: true, text: "n" })).map((v) => [v.id, v.isPrimary])).toEqual([["a", false], ["b", true]]);
    expect(replaceVersion(vs, ver("a", { isPrimary: true, text: "n" }))[0]!.text).toBe("n");
    expect(markPrimary(vs, "b").map((v) => v.isPrimary)).toEqual([false, true]);
    expect(markPrimary(vs, null).some((v) => v.isPrimary)).toBe(false);
    expect(removeVersion(vs, "a").map((v) => v.id)).toEqual(["b"]);
  });

  it("save-state labels", () => {
    expect(saveStateLabel("saving")).toBe("Saqlanmoqda…");
    expect(saveStateLabel("saved")).toBe("Saqlandi");
    expect(saveStateLabel("idle")).toBe("");
  });
});
