import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { verifyMp4Structure } from "./uploads.js";

const dir = mkdtempSync(path.join(tmpdir(), "mp4-structure-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const box = (type: string, payload = 0, size?: number): Buffer => {
  const b = Buffer.alloc(8 + payload, 3);
  b.writeUInt32BE(size ?? 8 + payload, 0);
  b.write(type, 4, "latin1");
  return b;
};
const ftyp = (): Buffer => {
  const b = box("ftyp", 12);
  b.write("isom", 8, "latin1");
  return b;
};
let n = 0;
const ok = async (...parts: Buffer[]): Promise<boolean> => {
  const file = path.join(dir, `f${n++}.mp4`);
  writeFileSync(file, Buffer.concat(parts));
  return verifyMp4Structure(file);
};

describe("MP4 box structure (L4)", () => {
  it("accepts ftyp + moov + mdat in either order, with other boxes between", async () => {
    expect(await ok(ftyp(), box("moov", 40), box("mdat", 1000))).toBe(true);
    expect(await ok(ftyp(), box("free", 8), box("mdat", 1000), box("moov", 40))).toBe(true);
  });

  it("accepts a size-0 last box (to the end of the file) and a 64-bit box size", async () => {
    expect(await ok(ftyp(), box("moov", 8), box("mdat", 500, 0))).toBe(true);
    const big = Buffer.alloc(16 + 100, 1);
    big.writeUInt32BE(1, 0);
    big.write("mdat", 4, "latin1");
    big.writeBigUInt64BE(BigInt(116), 8);
    expect(await ok(ftyp(), box("moov", 8), big)).toBe(true);
  });

  it("rejects what only looks like an MP4", async () => {
    expect(await ok(box("moov", 8), ftyp(), box("mdat", 8))).toBe(false); // ftyp not first
    expect(await ok(ftyp(), box("mdat", 100))).toBe(false); // no moov
    expect(await ok(ftyp(), box("moov", 100))).toBe(false); // no mdat
    expect(await ok(ftyp())).toBe(false);
    expect(await ok(Buffer.alloc(0))).toBe(false);
    expect(await ok(Buffer.from("not a video at all"))).toBe(false);
  });

  it("rejects truncated, padded and inconsistent files", async () => {
    const whole = Buffer.concat([ftyp(), box("moov", 40), box("mdat", 1000)]);
    expect(await ok(whole.subarray(0, whole.length - 1))).toBe(false); // the last box runs past the end
    expect(await ok(whole, Buffer.alloc(5, 0))).toBe(false); // trailing bytes that are not a box
    expect(await ok(ftyp(), box("moov", 40), box("mdat", 100, 5000))).toBe(false); // size beyond the file
    expect(await ok(ftyp(), box("moov", 40, 4), box("mdat", 100))).toBe(false); // size smaller than its own header
    const hugeLarge = Buffer.alloc(16);
    hugeLarge.writeUInt32BE(1, 0);
    hugeLarge.write("mdat", 4, "latin1");
    hugeLarge.writeBigUInt64BE(2n ** 60n, 8);
    expect(await ok(ftyp(), box("moov", 8), hugeLarge)).toBe(false);
  });
});
