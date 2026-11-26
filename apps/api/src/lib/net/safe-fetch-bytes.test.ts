import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSafeFetcher, detectRasterFormat, isBlockedAddress } from "./safe-fetch.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const SVG = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/>");
const HTML = Buffer.from("<!doctype html><html></html>");
let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const send = (type: string | null, body: Buffer) => {
      res.writeHead(200, type ? { "content-type": type } : {});
      res.end(body);
    };
    switch (req.url) {
      case "/octet.png": return send("application/octet-stream", PNG);
      case "/none.png": return send(null, PNG);
      case "/octet.svg": return send("application/octet-stream", SVG);
      case "/octet.html": return send("application/octet-stream", HTML);
      case "/octet.txt": return send("application/octet-stream", Buffer.from("hello world, not an image"));
      case "/png-as-svg-bytes": return send("image/png", SVG);
      case "/text.png": return send("text/plain", PNG);
      default: res.writeHead(404); res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const lab = createSafeFetcher({ lookupAll: async () => [{ address: "127.0.0.1", family: 4 }], isBlocked: (a) => a !== "127.0.0.1" && isBlockedAddress(a) });
const get = (p: string) => lab(`http://img.test:${port}${p}`, { maxBytes: 1_000_000 });

describe("IPv6 forms that hide an internal IPv4 address are blocked", () => {
  it.each(["::7f00:1", "::a00:1", "::c0a8:101", "::127.0.0.1", "::a9fe:a9fe", "64:ff9b:1::7f00:1", "64:ff9b:1:ffff::1", "64:ff9b::a00:1"])("blocks %s", (a) => expect(isBlockedAddress(a)).toBe(true));
  it.each(["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "2a00:1450:4001:81b::200e", "64:ff9a::1"])("still allows %s", (a) => expect(isBlockedAddress(a)).toBe(false));
});

describe("external images are judged by their real bytes", () => {
  it("accepts a PNG served as application/octet-stream or without a content type", async () => {
    expect((await get("/octet.png")).buffer.equals(PNG)).toBe(true);
    expect((await get("/none.png")).buffer.equals(PNG)).toBe(true);
  });
  it("refuses SVG, HTML and non-images however they are labelled", async () => {
    for (const p of ["/octet.svg", "/octet.html", "/octet.txt", "/png-as-svg-bytes", "/text.png"]) await expect(get(p), p).rejects.toMatchObject({ kind: "not_image" });
  });
  it("detects the supported raster formats by magic number", () => {
    expect(detectRasterFormat(PNG)).toBe("png");
    expect(detectRasterFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(detectRasterFormat(Buffer.from("GIF89a....."))).toBe("gif");
    expect(detectRasterFormat(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]))).toBe("webp");
    expect(detectRasterFormat(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypavif")]))).toBe("avif");
    expect(detectRasterFormat(Buffer.from([0x49, 0x49, 0x2a, 0x00]))).toBe("tiff");
    expect(detectRasterFormat(SVG)).toBeNull();
    expect(detectRasterFormat(Buffer.alloc(0))).toBeNull();
  });
});
