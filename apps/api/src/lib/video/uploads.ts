import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "../../config.js";
import { dataDir } from "./paths.js";

/**
 * Runner uploads on the API's disk. Layout: `<data>/runner-uploads/<jobId>/<name>.<n>.part` (one file per received part),
 * `<name>` (the assembled, verified file). Every write goes to a `*.tmp-*` name first and is renamed, so a crash never leaves a
 * half file that looks final. Nothing here is ever derived from storyboard text: names come from a fixed pattern per job kind.
 */

export const PART_BYTES = 8 * 1024 * 1024;
export const PREVIEW_MAX_FILES = 16;
const STILL_NAME = /^still-([1-9]|1[0-6])\.jpg$/;

export const uploadsRoot = (): string => path.join(dataDir(), "runner-uploads");
export const uploadDirOf = (jobId: string): string => path.join(uploadsRoot(), jobId);

export interface UploadRules {
  /** Names the runner may upload for this job. */
  allowed: (name: string) => boolean;
  maxFiles: number;
  /** Size cap of one file by name. */
  maxBytesOf: (name: string) => number;
  totalBytes: number;
}

export function rulesFor(kind: "preview" | "render" | "gif", expectedFiles: number): UploadRules {
  if (kind === "preview") {
    const maxFiles = Math.max(1, Math.min(PREVIEW_MAX_FILES, expectedFiles));
    return {
      allowed: (n) => {
        const m = STILL_NAME.exec(n);
        return m !== null && Number(m[1]) <= maxFiles;
      },
      maxFiles,
      maxBytesOf: () => config.VIDEO_MAX_STILL_BYTES,
      totalBytes: maxFiles * config.VIDEO_MAX_STILL_BYTES,
    };
  }
  const name = kind === "gif" ? "clip.gif" : "video.mp4";
  const cap = kind === "gif" ? config.VIDEO_MAX_GIF_BYTES : config.VIDEO_MAX_MP4_BYTES;
  return { allowed: (n) => n === name, maxFiles: 1, maxBytesOf: () => cap, totalBytes: cap };
}

export class UploadError extends Error {
  readonly status: 400 | 404 | 409 | 413 | 422 | 507;
  readonly code: string;
  constructor(status: UploadError["status"], code: string) {
    super(code);
    this.name = "UploadError";
    this.status = status;
    this.code = code;
  }
}

const isEnospc = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === "ENOSPC";

/** Names of the files (assembled or partial) present for a job, with their sizes. */
function inventory(dir: string): { files: Map<string, number>; partBytes: Map<string, number>; total: number } {
  const files = new Map<string, number>();
  const partBytes = new Map<string, number>();
  let total = 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return { files, partBytes, total };
  }
  for (const e of entries) {
    if (e.includes(".tmp-")) continue;
    let size = 0;
    try {
      size = statSync(path.join(dir, e)).size;
    } catch {
      continue;
    }
    const part = /^(.+)\.(\d+)\.part$/.exec(e);
    if (part) partBytes.set(part[1] as string, (partBytes.get(part[1] as string) ?? 0) + size);
    else files.set(e, size);
    total += size;
  }
  return { files, partBytes, total };
}

/**
 * Receive ONE part (streamed to disk, never buffered). Idempotent: the same part number replaces itself. Enforces the part size,
 * the per-file cap, the per-job total cap and the file-count cap before the first byte is kept; verifies the part checksum if given.
 */
export async function receivePart(opts: {
  jobId: string;
  rules: UploadRules;
  name: string;
  n: number;
  body: ReadableStream<Uint8Array> | null;
  declaredLength: number | null;
  sha256: string | null;
}): Promise<{ bytes: number }> {
  const { rules, name, n } = opts;
  if (!rules.allowed(name)) throw new UploadError(400, "bad_file_name");
  const maxParts = Math.ceil(rules.maxBytesOf(name) / PART_BYTES);
  if (!Number.isInteger(n) || n < 0 || n >= maxParts) throw new UploadError(400, "bad_part_number");
  if (opts.declaredLength !== null && opts.declaredLength > PART_BYTES) throw new UploadError(413, "part_too_large");
  if (!opts.body) throw new UploadError(400, "empty_body");

  const dir = uploadDirOf(opts.jobId);
  mkdirSync(dir, { recursive: true });
  const inv = inventory(dir);
  const known = new Set([...inv.files.keys(), ...inv.partBytes.keys()]);
  if (!known.has(name) && known.size >= rules.maxFiles) throw new UploadError(409, "too_many_files");
  if (inv.files.has(name)) throw new UploadError(409, "file_already_complete");
  const final = path.join(dir, `${name}.${n}.part`);
  const replaced = existsSync(final) ? statSync(final).size : 0;
  const fileHeld = (inv.partBytes.get(name) ?? 0) - replaced;
  const totalHeld = inv.total - replaced;

  const tmp = path.join(dir, `${name}.${n}.tmp-${randomBytes(6).toString("hex")}`);
  let bytes = 0;
  const hash = createHash("sha256");
  const fileCap = rules.maxBytesOf(name);
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > PART_BYTES) return cb(new UploadError(413, "part_too_large"));
      if (fileHeld + bytes > fileCap) return cb(new UploadError(413, "file_too_large"));
      if (totalHeld + bytes > rules.totalBytes) return cb(new UploadError(413, "total_too_large"));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(opts.body as import("node:stream/web").ReadableStream), counter, createWriteStream(tmp, { flags: "wx", mode: 0o600 }));
    if (opts.sha256 && opts.sha256.toLowerCase() !== hash.digest("hex")) throw new UploadError(422, "checksum_mismatch");
    if (bytes === 0 && n !== 0) throw new UploadError(400, "empty_body");
    renameSync(tmp, final);
    return { bytes };
  } catch (e) {
    rmSync(tmp, { force: true });
    if (e instanceof UploadError) throw e;
    if (isEnospc(e)) throw new UploadError(507, "disk_full");
    throw new UploadError(400, "upload_aborted");
  }
}

// --------------------------------------------------------------------------- verification

const GIF_MAGIC = ["GIF87a", "GIF89a"];

/** Reads the first bytes of a file. */
async function head(file: string, n: number): Promise<Buffer> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

export interface Verified {
  mime: "video/mp4" | "image/gif" | "image/jpeg";
  ext: "mp4" | "gif" | "jpg";
  width: number | null;
  height: number | null;
}

/** Magic numbers for MP4/GIF/JPEG; stills also get their decoded dimensions checked against the requested width (16:9). */
export async function verifyFile(file: string, kind: "preview" | "render" | "gif", expectedWidth: number): Promise<Verified> {
  const h = await head(file, 16);
  if (kind === "render") {
    if (h.length < 12 || h.subarray(4, 8).toString("latin1") !== "ftyp") throw new UploadError(422, "bad_magic");
    return { mime: "video/mp4", ext: "mp4", width: 1920, height: 1080 };
  }
  if (kind === "gif") {
    if (h.length < 10 || !GIF_MAGIC.includes(h.subarray(0, 6).toString("latin1"))) throw new UploadError(422, "bad_magic");
    const width = h.readUInt16LE(6);
    const height = h.readUInt16LE(8);
    if (width < 16 || width > 1000 || height < 16 || height > 1000) throw new UploadError(422, "bad_dimensions");
    return { mime: "image/gif", ext: "gif", width, height };
  }
  if (h.length < 3 || h[0] !== 0xff || h[1] !== 0xd8 || h[2] !== 0xff) throw new UploadError(422, "bad_magic");
  let width: number | undefined;
  let height: number | undefined;
  try {
    const sharp = (await import("sharp")).default;
    const meta = await sharp(file).metadata();
    width = meta.width;
    height = meta.height;
    if (meta.format !== "jpeg") throw new UploadError(422, "bad_magic");
  } catch (e) {
    if (e instanceof UploadError) throw e;
    throw new UploadError(422, "undecodable_image");
  }
  const expectedHeight = Math.round((expectedWidth * 9) / 16);
  if (width !== expectedWidth || height === undefined || Math.abs(height - expectedHeight) > 2) throw new UploadError(422, "bad_dimensions");
  return { mime: "image/jpeg", ext: "jpg", width, height };
}

/**
 * Assemble the parts of ONE file into its final name (temp name + rename), checking the declared part count, total size and
 * checksum, the magic number and the dimensions. Idempotent: an already assembled file with the declared size is accepted again.
 */
export async function completeFile(opts: { jobId: string; rules: UploadRules; name: string; parts: number; bytes: number; sha256: string | null; kind: "preview" | "render" | "gif"; expectedWidth: number }): Promise<Verified & { bytes: number }> {
  const { rules, name } = opts;
  if (!rules.allowed(name)) throw new UploadError(400, "bad_file_name");
  const dir = uploadDirOf(opts.jobId);
  const final = path.join(dir, name);
  if (!Number.isInteger(opts.parts) || opts.parts < 1 || opts.parts > Math.ceil(rules.maxBytesOf(name) / PART_BYTES)) throw new UploadError(400, "bad_part_count");
  if (!Number.isInteger(opts.bytes) || opts.bytes < 1 || opts.bytes > rules.maxBytesOf(name)) throw new UploadError(413, "file_too_large");
  if (existsSync(final) && statSync(final).size === opts.bytes) {
    const v = await verifyFile(final, opts.kind, opts.expectedWidth);
    return { ...v, bytes: opts.bytes };
  }
  const partFiles: string[] = [];
  let total = 0;
  for (let i = 0; i < opts.parts; i++) {
    const p = path.join(dir, `${name}.${i}.part`);
    if (!existsSync(p)) throw new UploadError(409, "missing_part");
    const size = statSync(p).size;
    if (size > PART_BYTES) throw new UploadError(413, "part_too_large");
    if (i < opts.parts - 1 && size !== PART_BYTES) throw new UploadError(409, "bad_part_size");
    total += size;
    partFiles.push(p);
  }
  if (total !== opts.bytes) throw new UploadError(409, "size_mismatch");
  const tmp = path.join(dir, `${name}.tmp-${randomBytes(6).toString("hex")}`);
  const hash = createHash("sha256");
  try {
    const out = createWriteStream(tmp, { flags: "wx", mode: 0o600 });
    for (const p of partFiles) {
      await pipeline(
        createReadStream(p),
        new Transform({
          transform(chunk: Buffer, _e, cb) {
            hash.update(chunk);
            cb(null, chunk);
          },
        }),
        out,
        { end: false },
      );
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    if (opts.sha256 && opts.sha256.toLowerCase() !== hash.digest("hex")) throw new UploadError(422, "checksum_mismatch");
    const verified = await verifyFile(tmp, opts.kind, opts.expectedWidth);
    renameSync(tmp, final);
    for (const p of partFiles) rmSync(p, { force: true });
    return { ...verified, bytes: total };
  } catch (e) {
    rmSync(tmp, { force: true });
    if (e instanceof UploadError) throw e;
    if (isEnospc(e)) throw new UploadError(507, "disk_full");
    throw new UploadError(400, "assemble_failed");
  }
}

export const assembledPath = (jobId: string, name: string): string => path.join(uploadDirOf(jobId), name);

export function removeUploads(jobId: string): void {
  rmSync(uploadDirOf(jobId), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

/** Directories (job ids) present under the uploads root with their age, for the orphan sweep. */
export function listUploadDirs(): Array<{ jobId: string; ageMs: number }> {
  try {
    return readdirSync(uploadsRoot()).map((jobId) => ({ jobId, ageMs: Date.now() - statSync(path.join(uploadsRoot(), jobId)).mtimeMs }));
  } catch {
    return [];
  }
}
