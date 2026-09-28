import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "hono";

/**
 * `clientIp` `TRUST_PROXY` env bayrog'iga qarab boshqacha ishlaydi — buni
 * to'g'ri sinash uchun har bir testda modulni (demak `config.ts`ni ham)
 * qaytadan yuklaymiz, chunki bayroq import vaqtida bir marta o'qiladi.
 */
function fakeContext(headers: Record<string, string>): Context {
  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()],
    },
  } as unknown as Context;
}

const ORIGINAL_TRUST_PROXY = process.env.TRUST_PROXY;

describe("clientIp", () => {
  afterEach(() => {
    if (ORIGINAL_TRUST_PROXY === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = ORIGINAL_TRUST_PROXY;
    vi.resetModules();
  });

  it("ignores x-forwarded-for/x-real-ip entirely when TRUST_PROXY=false (default, dev)", async () => {
    process.env.TRUST_PROXY = "false";
    vi.resetModules();
    const { clientIp } = await import("./device.js");
    const c = fakeContext({ "x-forwarded-for": "1.2.3.4, 5.6.7.8", "x-real-ip": "9.9.9.9" });
    // No real connection info available in this fake context -> falls back to "unknown",
    // proving the spoofable headers were NOT used.
    expect(clientIp(c)).toBe("unknown");
  });

  it("uses the LAST hop of x-forwarded-for when TRUST_PROXY=true (our proxy's own appended value)", async () => {
    process.env.TRUST_PROXY = "true";
    vi.resetModules();
    const { clientIp } = await import("./device.js");
    const c = fakeContext({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" });
    expect(clientIp(c)).toBe("5.6.7.8");
  });

  it("falls back to x-real-ip when TRUST_PROXY=true and x-forwarded-for is absent", async () => {
    process.env.TRUST_PROXY = "true";
    vi.resetModules();
    const { clientIp } = await import("./device.js");
    const c = fakeContext({ "x-real-ip": "9.9.9.9" });
    expect(clientIp(c)).toBe("9.9.9.9");
  });
});
