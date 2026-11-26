import { mkdirSync, readFileSync, statfsSync } from "node:fs";
import os from "node:os";
import { dataDir } from "./paths.js";

export interface ResourceSnapshot {
  freeDiskMb: number | null;
  freeMemoryMb: number | null;
}

/** Linux: `MemAvailable` (keshni hisobga oladi); boshqa tizimlarda `os.freemem()`. */
export function availableMemoryMb(): number {
  try {
    const meminfo = readFileSync("/proc/meminfo", "utf8");
    const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo);
    if (match) return Math.floor(Number(match[1]) / 1024);
  } catch {
    // /proc yo'q (masalan macOS)
  }
  return Math.floor(os.freemem() / 1024 / 1024);
}

export function freeDiskMb(dir: string): number | null {
  try {
    mkdirSync(dir, { recursive: true });
    const s = statfsSync(dir);
    return Math.floor((Number(s.bavail) * Number(s.bsize)) / 1024 / 1024);
  } catch {
    return null;
  }
}

let probe: () => ResourceSnapshot = () => ({ freeDiskMb: freeDiskMb(dataDir()), freeMemoryMb: availableMemoryMb() });

export const probeResources = (): ResourceSnapshot => probe();

/** Faqat testlar uchun. */
export function setResourceProbeForTests(fn: (() => ResourceSnapshot) | null): void {
  probe = fn ?? (() => ({ freeDiskMb: freeDiskMb(dataDir()), freeMemoryMb: availableMemoryMb() }));
}
