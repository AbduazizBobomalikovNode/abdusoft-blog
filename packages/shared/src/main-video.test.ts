import { describe, expect, it } from "vitest";
import { AdminPostDetailSchema, PostDetailSchema, PostMainVideoSchema, STAFF_EDITABLE_POST_FIELDS, UpdatePostBodySchema } from "./dto.js";

const publicPost = {
  slug: "a",
  title: "A",
  excerpt: null,
  html: "<p>x</p>",
  toc: [],
  coverUrl: null,
  publishedAt: null,
  readingTime: null,
  pinned: false,
  tags: [],
  settings: {},
  counts: { views: 0, likes: 0, dislikes: 0, comments: 0 },
  adjacent: { prev: null, next: null },
  related: [],
};

describe("post main video DTO", () => {
  it("an old public payload without mainVideo still parses (defaults to null)", () => {
    const parsed = PostDetailSchema.safeParse(publicPost);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.mainVideo).toBeNull();
  });

  it("accepts a video with or without jobId and defaults posterUrl/mime", () => {
    const v = PostMainVideoSchema.parse({ url: "https://x.test/v.mp4", width: 1280, height: 720, seconds: 3 });
    expect(v).toMatchObject({ posterUrl: null, mime: "video/mp4" });
    expect(PostDetailSchema.parse({ ...publicPost, mainVideo: { ...v, jobId: "j" } }).mainVideo?.jobId).toBe("j");
    expect(PostMainVideoSchema.safeParse({ url: "u", width: 0, height: 1, seconds: 1 }).success).toBe(false);
    expect(PostMainVideoSchema.safeParse({ url: "u", width: 1, height: 1, seconds: 1, mime: "video/webm" }).success).toBe(false);
  });

  it("UpdatePostBody takes a uuid or null, never a free string; it is not a staff field", () => {
    expect(UpdatePostBodySchema.safeParse({ mainVideoJobId: "00000000-0000-4000-8000-000000000000" }).success).toBe(true);
    expect(UpdatePostBodySchema.safeParse({ mainVideoJobId: null }).success).toBe(true);
    expect(UpdatePostBodySchema.safeParse({}).success).toBe(true);
    expect(UpdatePostBodySchema.safeParse({ mainVideoJobId: "abc" }).success).toBe(false);
    expect(STAFF_EDITABLE_POST_FIELDS as readonly string[]).not.toContain("mainVideoJobId");
  });

  it("AdminPostDetail keeps parsing without mainVideo", () => {
    expect(AdminPostDetailSchema.shape.mainVideo.parse(undefined)).toBeNull();
  });
});
