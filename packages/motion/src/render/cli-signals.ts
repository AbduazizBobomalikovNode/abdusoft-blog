/**
 * Process-signal handling is owned by the process entry point (the CLI and the render worker), never by the library.
 * Remotion's browser launcher installs a SIGINT listener that kills the browser and calls process.exit(130) at once,
 * which would skip our cleanup (temp files, partial output). The entry point passes this as `launchHook`: it removes
 * exactly the SIGINT listeners the launch added. Cancellation then goes through the AbortSignal, and the launcher's
 * own 'exit' hook still kills the browser when the process ends.
 */
export async function isolateBrowserSignals<T>(launch: () => Promise<T>): Promise<T> {
  const before = new Set(process.listeners("SIGINT"));
  try {
    return await launch();
  } finally {
    for (const l of process.listeners("SIGINT")) if (!before.has(l)) process.removeListener("SIGINT", l);
  }
}
