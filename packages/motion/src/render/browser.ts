import { existsSync } from "node:fs";
import { PACKAGE_ROOT } from "./paths.ts";
import { BrowserMissingError } from "./errors.ts";

/**
 * Remotion keeps its managed Chrome Headless Shell in `<nearest package.json from cwd>/node_modules/.remotion`.
 * To make "where is the browser" independent of whoever starts the process, every browser operation runs with
 * the working directory pinned to this package. Only meaningful in a dedicated process (see private-tmp.ts):
 * the working directory is process-wide.
 */
export async function withPackageCwd<T>(fn: () => Promise<T>): Promise<T> {
  const before = process.cwd();
  if (before === PACKAGE_ROOT) return fn();
  process.chdir(PACKAGE_ROOT);
  try {
    return await fn();
  } finally {
    try {
      process.chdir(before);
    } catch {
      /* the old directory vanished */
    }
  }
}

export interface BrowserStatus {
  installed: boolean;
  /** Executable path when installed. */
  path?: string;
  /** "managed" = Remotion's Chrome Headless Shell, "explicit" = a path the caller supplied. */
  source?: "managed" | "explicit";
  /** What to do when not installed. */
  hint?: string;
}

/** Is a usable browser available? Never downloads. */
export async function browserStatus(opts: { browserExecutable?: string } = {}): Promise<BrowserStatus> {
  if (opts.browserExecutable) {
    return existsSync(opts.browserExecutable)
      ? { installed: true, path: opts.browserExecutable, source: "explicit" }
      : { installed: false, hint: `browserExecutable "${opts.browserExecutable}" does not exist. ${BrowserMissingError.INSTALL_HINT}` };
  }
  const { ensureBrowser } = await import("@remotion/renderer");
  try {
    const status = (await withPackageCwd(() =>
      ensureBrowser({
        logLevel: "error",
        chromeMode: "headless-shell",
        onBrowserDownload: () => {
          throw new BrowserMissingError();
        },
      }),
    )) as { path?: string };
    return { installed: true, ...(status.path ? { path: status.path } : {}), source: "managed" };
  } catch (err) {
    if (err instanceof BrowserMissingError) return { installed: false, hint: BrowserMissingError.INSTALL_HINT };
    throw err;
  }
}

/** The ONLY place the library downloads a browser: an explicit operator action (`blog-motion browser install`). Idempotent. */
export async function installBrowser(onProgress?: (percent: number) => void): Promise<BrowserStatus> {
  const { ensureBrowser } = await import("@remotion/renderer");
  const status = (await withPackageCwd(() =>
    ensureBrowser({
      logLevel: "error",
      chromeMode: "headless-shell",
      onBrowserDownload: () => ({ version: null, onProgress: ({ percent }: { percent: number }) => onProgress?.(percent) }),
    }),
  )) as { path?: string };
  return { installed: true, ...(status.path ? { path: status.path } : {}), source: "managed" };
}
