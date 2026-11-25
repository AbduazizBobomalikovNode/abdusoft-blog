import { describe, expect, it } from "vitest";
import type { PostRevision } from "@blog/shared";
import { changedFields, stableStringify, type CurrentPostFields } from "./revision-diff";

const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

const current: CurrentPostFields = {
  title: "Sarlavha",
  slug: "sarlavha",
  excerpt: "Qisqa",
  coverUrl: null,
  tagSlugs: ["a", "b"],
  contentJson: doc("Salom"),
  settings: { commentsEnabled: true, showToc: false },
};

function revision(over: Partial<PostRevision> = {}): PostRevision {
  return {
    id: "r1",
    createdAt: "2026-10-01T10:00:00.000Z",
    createdBy: null,
    via: "mcp",
    reason: "update",
    title: "Sarlavha",
    slug: "sarlavha",
    status: "draft",
    excerpt: "Qisqa",
    contentJson: doc("Salom"),
    coverUrl: null,
    tagSlugs: ["b", "a"],
    settings: {},
    ...over,
  } as PostRevision;
}

describe("changedFields", () => {
  it("reports nothing for an identical version (tag order and key order do not matter)", () => {
    expect(changedFields(revision(), current)).toEqual([]);
    expect(changedFields(revision({ contentJson: { content: doc("Salom").content, type: "doc" } }), current)).toEqual([]);
  });

  it("lists exactly the fields that differ", () => {
    expect(changedFields(revision({ title: "Boshqa", contentJson: doc("Yangi") }), current)).toEqual(["title", "content"]);
    expect(changedFields(revision({ slug: "eski", excerpt: null, coverUrl: "/x.png", tagSlugs: ["a"] }), current)).toEqual([
      "slug",
      "excerpt",
      "tags",
      "cover",
    ]);
  });

  it("compares only the settings keys the revision knows about (partial settings)", () => {
    expect(changedFields(revision({ settings: {} }), current)).toEqual([]);
    expect(changedFields(revision({ settings: { showToc: true } }), current)).toEqual(["settings"]);
    expect(changedFields(revision({ settings: { commentsEnabled: true } }), current)).toEqual([]);
  });

  it("treats null and missing excerpt/cover as equal", () => {
    expect(changedFields(revision({ excerpt: null }), { ...current, excerpt: null })).toEqual([]);
  });
});

describe("stableStringify", () => {
  it("is order independent for objects and keeps array order", () => {
    expect(stableStringify({ b: 1, a: [2, 1] })).toBe(stableStringify({ a: [2, 1], b: 1 }));
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
    expect(stableStringify(undefined)).toBe("null");
  });
});
