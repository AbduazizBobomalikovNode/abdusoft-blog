import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PostMainVideo } from "@blog/shared";
import { formatVideoDuration, MainVideoCard } from "./main-video-card";

const video: PostMainVideo = { jobId: "j", url: "https://x/v.mp4", posterUrl: null, width: 1280, height: 720, seconds: 58, mime: "video/mp4" };
const render = (v: PostMainVideo, cover: string | null) =>
  renderToStaticMarkup(createElement(MainVideoCard, { video: v, fallbackPosterUrl: cover, onRemove: vi.fn(), onOpenVideo: vi.fn() }));

describe("MainVideoCard", () => {
  it("formats duration as m:ss", () => {
    expect(formatVideoDuration(58)).toBe("0:58");
    expect(formatVideoDuration(125.4)).toBe("2:05");
  });

  it("renders player with aspect ratio, duration and both buttons", () => {
    const html = render(video, null);
    expect(html).toContain("aspect-ratio:1280 / 720");
    expect(html).toContain("0:58");
    expect(html).toContain("Olib tashlash");
    expect(html).toContain("Video oynasi");
  });

  it("poster falls back to the cover, own poster wins", () => {
    expect(render(video, "https://x/cover.jpg")).toContain('poster="https://x/cover.jpg"');
    expect(render({ ...video, posterUrl: "https://x/p.jpg" }, "https://x/cover.jpg")).toContain('poster="https://x/p.jpg"');
  });
});
