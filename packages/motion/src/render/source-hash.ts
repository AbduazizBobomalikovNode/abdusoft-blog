import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { BUNDLE_DIR, FONT_DIR, PACKAGE_ROOT } from "./paths.ts";

/** Packages whose code ends up in the bundle or runs it. Their versions fold into the hash. */
export const VERSIONED_PACKAGES = ["remotion", "@remotion/bundler", "@remotion/renderer", "react", "react-dom", "zod"] as const;

const SOURCE_EXT = /\.(ts|tsx)$/;
const IMPORT_RE =
  /(?:^|[\s;])(?:import|export)\s[^"'`]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|(?:^|[\s;])import\s*["']([^"']+)["']/g;

const sha256 = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const rel = (f: string): string => path.relative(PACKAGE_ROOT, f).split(path.sep).join("/");

function listFiles(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const f = path.join(dir, name);
    if (statSync(f).isDirectory()) out.push(...listFiles(f, ext));
    else if (ext.test(name)) out.push(f);
  }
  return out;
}

/** Relative imports of one source file (`./x.ts`, `../assets/f.woff2`); bare packages are covered by VERSIONED_PACKAGES. */
export function relativeImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec?.startsWith(".")) out.push(path.resolve(path.dirname(file), spec));
  }
  return out;
}

/** src/bundle/** plus the closure of every relative import (shared modules, font files), sorted. */
export function sourceClosure(): string[] {
  const seen = new Set<string>();
  const stack = listFiles(BUNDLE_DIR, SOURCE_EXT);
  while (stack.length > 0) {
    const f = stack.pop() as string;
    if (seen.has(f)) continue;
    if (!existsSync(f)) throw new Error(`bundle import not found: ${rel(f)}`);
    seen.add(f);
    if (SOURCE_EXT.test(f)) stack.push(...relativeImports(f));
  }
  // The font directory is hashed whole: a swapped font file must invalidate the cache even if unreferenced.
  for (const f of listFiles(FONT_DIR, /\.woff2$/)) seen.add(f);
  return [...seen].sort();
}

export function packageVersion(name: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "node_modules", name, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

export interface SourceHash {
  hash: string;
  files: Record<string, string>;
  versions: Record<string, string | null>;
}

/** One hash for everything the pixels depend on besides the props: bundle sources, fonts, package versions. */
export function sourceHash(): SourceHash {
  const files = Object.fromEntries(sourceClosure().map((f) => [rel(f), sha256(readFileSync(f))]));
  const versions = Object.fromEntries(VERSIONED_PACKAGES.map((p) => [p, packageVersion(p)]));
  const hash = sha256(JSON.stringify({ v: 1, files, versions }));
  return { hash, files, versions };
}
