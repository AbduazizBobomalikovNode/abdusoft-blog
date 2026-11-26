import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SafeFetchError, createSafeFetcher, isBlockedAddress } from "./safe-fetch.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
let server: http.Server;
let port = 0;
const hits: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? "";
    hits.push(`${req.headers.host}${url}`);
    if (url === "/og") {
      res.writeHead(302, { location: `http://other.test:${port}/stolen.png` });
      res.end();
    } else if (url === "/og-same") {
      res.writeHead(302, { location: "/own.png" });
      res.end();
    } else if (url === "/own.png" || url === "/stolen.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PNG);
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

const lab = createSafeFetcher({
  lookupAll: async (host) => (host === "own.test" || host === "other.test" ? [{ address: "127.0.0.1", family: 4 }] : []),
  isBlocked: (a) => a !== "127.0.0.1" && isBlockedAddress(a),
});
const sameOrigin = (u: URL) => u.host === `own.test:${port}`;

describe("safeFetchBytes allowRedirect (optional policy applied to every redirect target)", () => {
  it("without the option nothing changes: a redirect to another public host is followed", async () => {
    const r = await lab(`http://own.test:${port}/og`, { maxBytes: 100_000 });
    expect(r.buffer.byteLength).toBeGreaterThan(0);
  });

  it("a redirect that leaves the allowed origin is refused BEFORE it is requested", async () => {
    hits.length = 0;
    await expect(lab(`http://own.test:${port}/og`, { maxBytes: 100_000, allowRedirect: sameOrigin })).rejects.toBeInstanceOf(SafeFetchError);
    expect(hits.some((h) => h.includes("other.test"))).toBe(false);
  });

  it("a redirect that stays on the allowed origin works", async () => {
    const r = await lab(`http://own.test:${port}/og-same`, { maxBytes: 100_000, allowRedirect: sameOrigin });
    expect(r.buffer.byteLength).toBeGreaterThan(0);
  });
});
