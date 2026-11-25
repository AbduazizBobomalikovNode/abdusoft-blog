import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SafeFetchError, createSafeFetcher, isBlockedAddress, safeFetchBytes } from "./safe-fetch.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

let server: http.Server;
let port = 0;
let hits: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    const url = req.url ?? "";
    if (url === "/ok.png") {
      res.writeHead(200, { "content-type": "image/png", etag: '"v1"' });
      res.end(PNG);
    } else if (url === "/page.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html></html>");
    } else if (url === "/vector.svg") {
      res.writeHead(200, { "content-type": "image/svg+xml" });
      res.end("<svg xmlns='http://www.w3.org/2000/svg'/>");
    } else if (url === "/big.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.write(Buffer.alloc(200_000));
      res.write(Buffer.alloc(200_000));
      res.end(Buffer.alloc(200_000));
    } else if (url === "/to-metadata") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    } else if (url === "/to-internal-name") {
      res.writeHead(302, { location: "http://internal.test/secret.png" });
      res.end();
    } else if (url === "/to-ok") {
      res.writeHead(302, { location: "/ok.png" });
      res.end();
    } else if (url === "/loop") {
      res.writeHead(302, { location: "/loop" });
      res.end();
    } else if (url === "/hang") {
      // never answers
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

/** A fetcher that treats the loopback test server as "public" (only the test can do this; production uses the real rules). */
const lab = createSafeFetcher({
  lookupAll: async (host) => (host === "img.test" ? [{ address: "127.0.0.1", family: 4 }] : host === "internal.test" ? [{ address: "10.1.2.3", family: 4 }] : host === "mixed.test" ? [{ address: "127.0.0.1", family: 4 }, { address: "10.0.0.9", family: 4 }] : []),
  isBlocked: (a) => a !== "127.0.0.1" && isBlockedAddress(a),
});
const fetchLab = (path: string, opts: { maxBytes?: number; timeoutMs?: number } = {}) => lab(`http://img.test:${port}${path}`, { maxBytes: 1_000_000, ...opts });

describe("isBlockedAddress", () => {
  it.each([
    "0.0.0.0", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.0.3", "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.31.255.255",
    "192.0.0.5", "192.168.1.1", "198.18.0.1", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::7f00:1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "2001:db8::1", "2002:7f00:1::1", "not-an-ip",
  ])("blocks %s", (addr) => expect(isBlockedAddress(addr)).toBe(true));

  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001:81b::200e"])("allows %s", (addr) =>
    expect(isBlockedAddress(addr)).toBe(false),
  );
});

describe("production fetcher refuses unsafe targets WITHOUT connecting", () => {
  it.each([
    ["loopback IP", () => `http://127.0.0.1:${port}/ok.png`],
    ["localhost", () => `http://localhost:${port}/ok.png`],
    ["IPv6 loopback", () => `http://[::1]:${port}/ok.png`],
    ["decimal-encoded loopback", () => `http://2130706433:${port}/ok.png`],
    ["hex-encoded loopback", () => `http://0x7f.1:${port}/ok.png`],
    ["IPv4-mapped IPv6 loopback", () => `http://[::ffff:127.0.0.1]:${port}/ok.png`],
    ["cloud metadata", () => "http://169.254.169.254/latest/meta-data/"],
    ["private 10/8", () => "http://10.0.0.5/x.png"],
    ["private 192.168/16", () => "http://192.168.1.1/x.png"],
    ["CGNAT", () => "http://100.64.0.1/x.png"],
    ["multicast", () => "http://224.0.0.1/x.png"],
    ["file scheme", () => "file:///etc/passwd"],
    ["ftp scheme", () => "ftp://example.com/x.png"],
    ["userinfo", () => `http://user:pw@127.0.0.1:${port}/ok.png`],
    ["not a URL", () => "nope"],
  ])("%s", async (_n, url) => {
    hits = [];
    await expect(safeFetchBytes(url(), { maxBytes: 1_000_000, timeoutMs: 2000 })).rejects.toBeInstanceOf(SafeFetchError);
    expect(hits).toEqual([]);
  });
});

describe("hardened fetching behaviour", () => {
  it("fetches a normal image and returns its validator", async () => {
    const r = await fetchLab("/ok.png");
    expect(r.buffer.equals(PNG)).toBe(true);
    expect(r.validator).toBe('"v1"');
  });

  it("follows a harmless redirect but refuses a redirect to a metadata address or to a name that resolves to a private one", async () => {
    expect((await fetchLab("/to-ok")).buffer.equals(PNG)).toBe(true);
    await expect(fetchLab("/to-metadata")).rejects.toMatchObject({ kind: "blocked" });
    await expect(fetchLab("/to-internal-name")).rejects.toMatchObject({ kind: "blocked" });
    await expect(fetchLab("/loop")).rejects.toMatchObject({ kind: "unreachable" });
  });

  it("refuses a name when ANY resolved address is private", async () => {
    await expect(lab(`http://mixed.test:${port}/ok.png`, { maxBytes: 1000 })).rejects.toMatchObject({ kind: "blocked" });
  });

  it("enforces the size cap while streaming and via content-length", async () => {
    await expect(fetchLab("/big.png", { maxBytes: 100_000 })).rejects.toMatchObject({ kind: "too_large" });
  });

  it("accepts only image content types (HTML and SVG are refused)", async () => {
    await expect(fetchLab("/page.html")).rejects.toMatchObject({ kind: "not_image" });
    await expect(fetchLab("/vector.svg")).rejects.toMatchObject({ kind: "not_image" });
  });

  it("gives up on a server that never answers", async () => {
    const started = Date.now();
    await expect(fetchLab("/hang", { timeoutMs: 300 })).rejects.toMatchObject({ kind: "unreachable" });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("reports HTTP errors", async () => {
    await expect(fetchLab("/missing.png")).rejects.toMatchObject({ kind: "unreachable" });
  });
});
