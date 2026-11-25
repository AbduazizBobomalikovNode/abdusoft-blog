import { DistributionError } from "../errors.js";
import { asRecord, realSleep, str, type HttpResponse, type ProviderDeps } from "../http.js";
import { DAY_MS, type TokenPolicy } from "../token-status.js";

/**
 * Meta Graph (Threads va Instagram) uchun umumiy: xato taksonomiyasi, token siyosati, polling jadvali.
 *
 * Xato shakli (Graph API xatolarni boshqarish sahifasi, sana yo'q):
 *   https://developers.facebook.com/docs/graph-api/guides/error-handling
 *   `{error:{message,type:"OAuthException",code,error_subcode,error_user_msg,fbtrace_id}}`
 *   190 = token yaroqsiz/muddati tugagan (subcode 458/459/460/463/467); 4 va 17 = limit; 368 = vaqtinchalik blok;
 *   10 va 200-299 = ruxsat; 1 va 2 = vaqtinchalik servis xatosi. 32, 613, 100 — sahifada YO'Q (UNVERIFIED): 32/613 limit,
 *   100 noto'g'ri parametr deb qabul qilindi.
 * Threads token endpoint'lari esa `{error_type, code, error_message}` qaytaradi (threads get-started sahifasi).
 */

export function graphErrorOf(res: HttpResponse): { code?: number; subcode?: number; message?: string } {
  const j = asRecord(res.json);
  const e = asRecord(j.error);
  const code = typeof e.code === "number" ? e.code : typeof j.code === "number" ? j.code : undefined;
  const subcode = typeof e.error_subcode === "number" ? e.error_subcode : undefined;
  return { code, subcode, message: str(e.error_user_msg) ?? str(e.message) ?? str(j.error_message) };
}

/** `HostClient.fail` ga beriladigan `refine`. */
export function graphRefine(deps: ProviderDeps, platform: "Threads" | "Instagram") {
  return (res: HttpResponse, msg: string): DistributionError | undefined => {
    const { code } = graphErrorOf(res);
    const lower = `${msg} ${res.text}`.toLowerCase();
    const base = { status: res.status, platformMessage: msg || undefined };
    const now = deps.now?.() ?? new Date();
    if (lower.includes("duplicate")) {
      return new DistributionError({ ...base, kind: "duplicate_content", message: `${platform} bu matnni dublikat deb rad etdi` });
    }
    if (code === 190 || res.status === 401) {
      return new DistributionError({ ...base, kind: "auth_expired", message: `${platform} token yaroqsiz yoki muddati tugagan — qayta ulang` });
    }
    if (code === 4 || code === 17 || code === 32 || code === 613 || code === 368 || res.status === 429) {
      const ra = Number(res.headers.get("retry-after"));
      return new DistributionError({
        ...base,
        kind: "rate_limited",
        retryAt: Number.isFinite(ra) && ra > 0 ? new Date(now.getTime() + ra * 1000) : undefined,
        message: `${platform} limiti oshdi`,
      });
    }
    if (code === 10 || (code !== undefined && code >= 200 && code <= 299) || res.status === 403) {
      return new DistributionError({ ...base, kind: "permission_missing", message: `${platform}: ruxsat yetishmaydi (scope yoki ilova roli/tasdiqlash)` });
    }
    if (code === 1 || code === 2) {
      return new DistributionError({ ...base, kind: "transient", message: `${platform} vaqtinchalik xato` });
    }
    return undefined;
  };
}

/**
 * Konteyner holatini so'rash jadvali: darhol, so'ng 5 s, so'ng har 60 s (hujjat: "bir daqiqada bir marta, 5 daqiqagacha").
 * Umumiy kutish <= ~4 daqiqa 5 soniya.
 */
export const DEFAULT_POLL_SCHEDULE_MS: readonly number[] = [5_000, 60_000, 60_000, 60_000, 60_000];

export type ContainerState = "ready" | "pending" | "failed";

export async function pollContainer(
  deps: ProviderDeps,
  check: () => Promise<ContainerState>,
  schedule: readonly number[] = DEFAULT_POLL_SCHEDULE_MS,
): Promise<ContainerState> {
  const sleep = deps.sleep ?? realSleep;
  let state = await check();
  for (const wait of schedule) {
    if (state !== "pending") return state;
    await sleep(wait);
    state = await check();
  }
  return state;
}

/** 60 kunlik token; 24 soatdan keyin o'z-o'zini almashtirish bilan yangilanadi (Threads/Instagram "long-lived tokens" sahifalari). */
export const GRAPH_TOKEN_POLICY: TokenPolicy = {
  refresh: "self_exchange",
  warnBeforeMs: 7 * DAY_MS,
  remindBeforeMs: 10 * DAY_MS,
  // Umrining ikkinchi yarmida yangilaymiz (60 kun -> qolgan 30 kun).
  refreshLeadMs: 30 * DAY_MS,
  minRefreshAgeMs: DAY_MS,
};

export function toGraphForm(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, v);
  return sp.toString();
}
