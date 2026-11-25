import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = path.resolve(PKG, "..", "..");

export const readFixture = (name: string): unknown => JSON.parse(readFileSync(path.join(PKG, "fixtures", name), "utf8")) as unknown;

/** A minimal valid storyboard that tests mutate. */
export function base(scenes: unknown[] = [{ type: "title", title: "Salom" }]): Record<string, unknown> {
  return { version: 1, title: "t", theme: "dark", scenes };
}
