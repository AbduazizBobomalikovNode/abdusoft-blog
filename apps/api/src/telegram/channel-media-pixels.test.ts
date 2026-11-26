import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";

const state = vi.hoisted(() => ({ buffer: Buffer.alloc(0) }));
vi.mock("../lib/net/safe-fetch.js", () => ({
  SafeFetchError: class extends Error {},
  safeFetchBytes: async () => ({ buffer: state.buffer, validator: null }),
}));

import { clearPreparedImageCache, getPreparedImage } from "./channel-media.js";

describe("externally fetched images get a pixel limit before decoding", () => {
  it("refuses a small file that declares a huge canvas (decompression bomb) without decoding it", async () => {
    // 12000 x 12000 = 144 MP, a few KB when compressed.
    state.buffer = await sharp({ create: { width: 12_000, height: 12_000, channels: 3, background: "#000" } }).png({ compressionLevel: 9 }).toBuffer();
    expect(state.buffer.length).toBeLessThan(2_000_000);
    clearPreparedImageCache();
    const r = await getPreparedImage("https://img.example/bomb.png");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("too_large");
      expect(r.error).toMatch(/megapiksel/);
    }
  }, 30_000);

  it("still prepares an ordinary external image", async () => {
    state.buffer = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#369" } }).png().toBuffer();
    clearPreparedImageCache();
    const r = await getPreparedImage("https://img.example/ok.png");
    expect(r.ok).toBe(true);
  });
});
