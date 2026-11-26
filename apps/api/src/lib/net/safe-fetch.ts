import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/**
 * Server tomonidan tashqi rasm yuklash (kanal ko'rinishi/yuborish): SSRF-xavfsiz.
 *  - faqat http/https, userinfo yo'q;
 *  - nom FAQAT bir marta, BIZ tekshirgan manzilga ulanish uchun hal qilinadi (ulanishdagi `lookup` tekshiradi — DNS rebinding yo'q);
 *    har bir hal qilingan manzil (A va AAAA) xususiy/loopback/link-local/CGNAT/multicast/metadata/ajratilgan bo'lsa — rad;
 *  - yo'naltirishlar qo'lda, har bir qadam qayta tekshiriladi (ko'pi bilan 3 ta);
 *  - ulanish + umumiy vaqt chegarasi, javob hajmi chegarasi (oqim bo'yicha), faqat `image/*` (SVG'dan tashqari).
 */

export class SafeFetchError extends Error {
  constructor(
    message: string,
    readonly kind: "unreachable" | "too_large" | "blocked" | "not_image",
  ) {
    super(message);
  }
}

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) blocked.addSubnet(addr, prefix, "ipv4");
for (const [addr, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64
  ["100::", 64],
  ["2001::", 32], // Teredo
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) blocked.addSubnet(addr, prefix, "ipv6");

/** `true` — manzil ochiq internetga tegishli EMAS (yoki noma'lum) va unga ulanib bo'lmaydi. */
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return true;
  if (family === 6) {
    // IPv4-mapped (`::ffff:a.b.c.d`) hech qachon ochiq manzil sifatida ishlatilmaydi. (`BlockList`ga qo'shilmaydi: Node IPv4'ni
    // xuddi shu oraliqda deb hisoblaydi va hamma ochiq IPv4'larni ham bloklab yuborardi.)
    const canonical = new URL(`http://[${address}]/`).hostname;
    if (/^\[(?:0:0:0:0:0:ffff|::ffff):/i.test(canonical)) return true;
  }
  return blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

export interface SafeFetchDeps {
  /** Test uchun: nomni hal qilish. */
  lookupAll?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  /** Test uchun: manzilni bloklash qoidasi (ishlab chiqarishda `isBlockedAddress`). */
  isBlocked?: (address: string) => boolean;
}

export interface SafeFetchOptions {
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** `true` (standart) — faqat `image/*` (SVG'dan tashqari) qabul qilinadi. */
  imageOnly?: boolean;
  /** Ixtiyoriy: har bir yo'naltirishdan keyingi manzil shu qoidadan o'tishi shart (o'tmasa `blocked`). Berilmasa — avvalgidek. */
  allowRedirect?: (url: URL) => boolean;
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export function createSafeFetcher(deps: SafeFetchDeps = {}) {
  const check = deps.isBlocked ?? isBlockedAddress;
  const lookupAll =
    deps.lookupAll ??
    (async (hostname: string) => (await dns.promises.lookup(hostname, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family })));

  const lookup = (
    hostname: string,
    options: { all?: boolean },
    callback: (err: Error | null, address?: unknown, family?: number) => void,
  ): void => {
    lookupAll(hostname).then(
      (addresses) => {
        if (addresses.length === 0 || addresses.some((a) => check(a.address))) {
          callback(new SafeFetchError("Rasm manzili ruxsat etilmagan (ichki yoki xavfli tarmoq manzili)", "blocked"));
          return;
        }
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (err: unknown) => callback(err instanceof Error ? err : new Error("lookup failed")),
    );
  };

  async function once(url: URL, opts: Required<Omit<SafeFetchOptions, "allowRedirect">>, deadline: number): Promise<{ redirect: string | null; buffer: Buffer | null; headers: http.IncomingHttpHeaders }> {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new SafeFetchError("Rasm manzili faqat http/https bo'lishi mumkin", "blocked");
    if (url.username || url.password) throw new SafeFetchError("Rasm manzilida login/parol bo'lishi mumkin emas", "blocked");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) !== 0 && check(host)) throw new SafeFetchError("Rasm manzili ruxsat etilmagan (ichki yoki xavfli tarmoq manzili)", "blocked");

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SafeFetchError("Rasm yuklanishi vaqt chegarasidan oshdi", "unreachable");

    return new Promise((resolve, reject) => {
      const client = url.protocol === "https:" ? https : http;
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const req = client.request(
        {
          protocol: url.protocol,
          hostname: host,
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers: { accept: "image/*", "user-agent": "blog-image-fetch/1" },
          lookup: lookup as never,
          agent: false,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (REDIRECT_STATUS.has(status) && res.headers.location) {
            res.resume();
            finish(() => resolve({ redirect: res.headers.location as string, buffer: null, headers: res.headers }));
            return;
          }
          if (status < 200 || status >= 300) {
            res.resume();
            finish(() => reject(new SafeFetchError(`Rasmga ulanib bo'lmadi (HTTP ${status})`, "unreachable")));
            return;
          }
          const type = String(res.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
          if (opts.imageOnly && (!type.startsWith("image/") || type === "image/svg+xml")) {
            res.resume();
            finish(() => reject(new SafeFetchError("Manzil rasm emas (yoki ruxsat etilmagan rasm turi)", "not_image")));
            return;
          }
          const declared = Number(res.headers["content-length"]);
          if (Number.isFinite(declared) && declared > opts.maxBytes) {
            res.destroy();
            finish(() => reject(new SafeFetchError("Fayl hajmi chegaradan katta", "too_large")));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > opts.maxBytes) {
              res.destroy();
              finish(() => reject(new SafeFetchError("Fayl hajmi chegaradan katta", "too_large")));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => finish(() => resolve({ redirect: null, buffer: Buffer.concat(chunks), headers: res.headers })));
          res.on("error", () => finish(() => reject(new SafeFetchError("Rasmga ulanib bo'lmadi", "unreachable"))));
          res.on("close", () => finish(() => reject(new SafeFetchError("Rasmga ulanib bo'lmadi", "unreachable"))));
        },
      );
      const timer = setTimeout(() => {
        req.destroy();
        finish(() => reject(new SafeFetchError("Rasm yuklanishi vaqt chegarasidan oshdi", "unreachable")));
      }, remaining);
      req.on("error", (error) => finish(() => reject(error instanceof SafeFetchError ? error : new SafeFetchError("Rasmga ulanib bo'lmadi", "unreachable"))));
      req.end();
    });
  }

  return async function safeFetchBytes(rawUrl: string, options: SafeFetchOptions): Promise<{ buffer: Buffer; validator: string | null }> {
    const { allowRedirect, ...rest } = options;
    const opts: Required<Omit<SafeFetchOptions, "allowRedirect">> = { timeoutMs: 10_000, maxRedirects: 3, imageOnly: true, ...rest };
    const deadline = Date.now() + opts.timeoutMs;
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new SafeFetchError("Rasm manzili noto'g'ri", "blocked");
    }
    for (let hop = 0; hop <= opts.maxRedirects; hop++) {
      const result = await once(url, opts, deadline);
      if (result.redirect === null) {
        const h = result.headers;
        return { buffer: result.buffer as Buffer, validator: (h.etag as string | undefined) ?? (h["last-modified"] as string | undefined) ?? null };
      }
      try {
        url = new URL(result.redirect, url);
      } catch {
        throw new SafeFetchError("Yo'naltirish manzili noto'g'ri", "blocked");
      }
      if (allowRedirect && !allowRedirect(url)) throw new SafeFetchError("Yo'naltirish ruxsat etilmagan manzilga olib boradi", "blocked");
    }
    throw new SafeFetchError("Juda ko'p yo'naltirish", "unreachable");
  };
}

/** Ishlab chiqarish nusxasi. */
export const safeFetchBytes = createSafeFetcher();
