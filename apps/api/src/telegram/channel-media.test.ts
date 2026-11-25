import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { config } from "../config.js";
import { uploadsDir } from "../lib/media/store.js";
import { clearPreparedImageCache, getPreparedImage, localKeyFor, resolveUploadPath } from "./channel-media.js";

const DIR = path.join(uploadsDir, "channel-media-test");
const OUTSIDE = path.resolve(uploadsDir, "..", "channel-media-outside.png");
let png: Buffer;
const url = (key: string) => `${config.API_ORIGIN}/uploads/${key}`;

beforeAll(async () => {
  png = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#369" } }).png().toBuffer();
  await mkdir(DIR, { recursive: true });
  await writeFile(path.join(DIR, "ok.png"), png);
  await writeFile(OUTSIDE, png); // a perfectly valid image that lives OUTSIDE the uploads directory
  await symlink(OUTSIDE, path.join(DIR, "link.png")).catch(() => undefined);
  clearPreparedImageCache();
});
afterAll(async () => {
  await rm(DIR, { recursive: true, force: true });
  await rm(OUTSIDE, { force: true });
});

describe("local upload paths cannot leave the uploads directory", () => {
  it("a normal upload still works through the preview/send path", async () => {
    const r = await getPreparedImage(url("channel-media-test/ok.png"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.original.width).toBe(40);
  });

  it.each([
    ["dot-dot segment", url("../channel-media-outside.png")],
    ["encoded dot-dot", url("%2e%2e/channel-media-outside.png")],
    ["encoded slash", url("..%2fchannel-media-outside.png")],
    ["double encoded", url("..%252fchannel-media-outside.png")],
    ["nested traversal", url("channel-media-test/../../channel-media-outside.png")],
    ["backslash", url("..\\channel-media-outside.png")],
    ["NUL byte", url("channel-media-test/ok.png%00.png")],
    ["absolute key", url("%2Fetc%2Fpasswd")],
  ])("%s is refused and the outside file is never read", async (_n, u) => {
    clearPreparedImageCache();
    const r = await getPreparedImage(u);
    expect(r.ok).toBe(false);
  });

  it("a symlink inside uploads that points outside is refused", async () => {
    clearPreparedImageCache();
    const r = await getPreparedImage(url("channel-media-test/link.png"));
    expect(r.ok).toBe(false);
  });

  it("resolveUploadPath only returns paths inside the uploads directory", async () => {
    expect(await resolveUploadPath("channel-media-test/ok.png")).toContain(path.join("channel-media-test", "ok.png"));
    for (const bad of ["../x.png", "a/../../x.png", "", "/etc/passwd", "a\0b"]) expect(await resolveUploadPath(bad), bad).toBeNull();
    expect(localKeyFor(url("../x.png"))).toBeNull(); // the URL parser collapses it out of /uploads/
    expect(localKeyFor("https://elsewhere.example/uploads/x.png")).toBeNull();
  });
});

describe("remote fetching goes through the safe fetcher", () => {
  it("a loopback / metadata URL is refused as unreachable without touching the network", async () => {
    clearPreparedImageCache();
    for (const u of ["http://127.0.0.1:1/x.png", "http://localhost:1/x.png", "http://169.254.169.254/x.png", `${config.API_ORIGIN}/not-uploads/x.png`]) {
      const r = await getPreparedImage(u);
      expect(r.ok, u).toBe(false);
      if (!r.ok) expect(r.kind).toBe("unreachable");
    }
  });
});
