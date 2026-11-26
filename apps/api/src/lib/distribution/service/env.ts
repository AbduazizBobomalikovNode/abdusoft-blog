import { config } from "../../../config.js";
import { createProvider } from "../registry.js";
import type { FetchLike, ProviderDeps } from "../http.js";
import type { DistributionProvider, ProviderId } from "../types.js";

/**
 * Tarqatish xizmatining tashqi muhiti: bayroq, qayta yo'naltirish URL'lari, provider nusxalari, `fetch` va soat (testlarda
 * almashtiriladi). Bu yerdagi hech narsa import paytida tarmoqqa chiqmaydi.
 */

export const distributionEnabled = (): boolean => config.DISTRIBUTION_ENABLED;

/** Platforma ilovasida ro'yxatdan o'tkaziladigan callback manzili. BARQAROR: o'zgartirsangiz egasi har platformada qayta kiritadi. */
export function redirectUrlFor(provider: ProviderId): string {
  return `${config.API_ORIGIN.replace(/\/+$/, "")}/admin/distribution/callback/${provider}`;
}

let fetchImpl: FetchLike | null = null;
let clock: () => Date = () => new Date();
let sleepImpl: ((ms: number) => Promise<void>) | undefined;

/** Faqat testlar uchun: soxta `fetch` (haqiqiy tarmoqqa chiqmaslik uchun). */
export function setDistributionFetch(next: FetchLike | null): void {
  fetchImpl = next;
}

/** Faqat testlar uchun: soxta soat. */
export function setDistributionClock(next: (() => Date) | null): void {
  clock = next ?? (() => new Date());
}

/** Faqat testlar uchun: konteyner holatini kutishda real kutmaslik. */
export function setDistributionSleep(next: ((ms: number) => Promise<void>) | undefined): void {
  sleepImpl = next;
}

export const distNow = (): Date => clock();

/** Provayderlarga beriladigan bog'liqliklar. Tashqi so'rovlar `HostClient` ichida allow-list bilan cheklanadi. */
export function providerDeps(): ProviderDeps {
  return {
    fetch: (input, init) => (fetchImpl ?? ((i, o) => fetch(i, o)))(input, init),
    now: () => clock(),
    ...(sleepImpl ? { sleep: sleepImpl } : {}),
  };
}

const providers = new Map<ProviderId, DistributionProvider>();

export function getProvider(id: ProviderId): DistributionProvider {
  let p = providers.get(id);
  if (!p) {
    p = createProvider(id, { github: { limit: config.DISTRIBUTION_GITHUB_README_POSTS } });
    providers.set(id, p);
  }
  return p;
}

export function isProviderId(value: string): value is ProviderId {
  return (["linkedin", "x", "threads", "instagram", "github"] as string[]).includes(value);
}
