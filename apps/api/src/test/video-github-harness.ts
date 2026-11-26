import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

/** Fixtures for the GitHub-runner tests: tiny but REAL files (the API verifies magic numbers and decoded dimensions). */
export const jpeg = (width: number, height: number): Promise<Buffer> => sharp({ create: { width, height, channels: 3, background: "#224466" } }).jpeg().toBuffer();

/** A structurally valid minimal MP4: `ftyp` (24 bytes), an empty `moov` (8) and an `mdat` that fills the rest of the file. */
export function mp4(bytes = 4096): Buffer {
  const b = Buffer.alloc(bytes, 7);
  b.writeUInt32BE(24, 0);
  b.write("ftypisom", 4, "latin1");
  b.writeUInt32BE(8, 24);
  b.write("moov", 28, "latin1");
  b.writeUInt32BE(bytes - 32, 32);
  b.write("mdat", 36, "latin1");
  return b;
}

export function gif(width = 800, height = 450, bytes = 2048): Buffer {
  const b = Buffer.alloc(bytes, 1);
  b.write("GIF89a", 0, "latin1");
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

export const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

export const ensureDir = (dir: string): string => {
  mkdirSync(path.resolve(dir), { recursive: true });
  return dir;
};

/** A fetch double that records the calls and answers like api.github.com (dispatch 204/200, cancel 202). */
export interface GithubCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}
export function githubDouble(handler?: (call: GithubCall) => Response | Promise<Response>) {
  const calls: GithubCall[] = [];
  const fetchFn = async (input: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call: GithubCall = { url: String(input), method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? init.body : null };
    calls.push(call);
    if (handler) return handler(call);
    if (call.url.endsWith("/cancel")) return new Response(null, { status: 202 });
    return new Response(JSON.stringify({ workflow_run_id: 4242, run_url: "https://api.github.com/x", html_url: "https://github.com/x" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchFn };
}
