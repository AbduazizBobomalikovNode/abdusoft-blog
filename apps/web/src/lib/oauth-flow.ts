import { groupRequestedScopes, type McpConsentInfo, type McpScopeGroupView } from "@blog/shared";

/**
 * Claude konnektori (OAuth) uchun veb tomon mantiqi — toza funksiyalar (testlanadi). Sahifalar (`/login`, `/consent`)
 * faqat shu natijalarni chizadi.
 */

/**
 * Better Auth imzolagan OAuth so'rovining ("oauth_query") bor-yo'qligi: `sig` parametri bor bo'lsa — bu avtorizatsiya
 * oqimidan kelgan sahifa. Imzoni TEKSHIRISH serverning ishi; bu yerda faqat oddiy kirishdan ajratib olamiz.
 */
export function hasSignedOAuthQuery(search: string): boolean {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return params.has("sig") && params.has("client_id");
}

/** `?...` belgisiz xom so'rov qatori (server shuni imzolagan, qayta kodlamaymiz). */
export function rawOAuthQuery(search: string): string {
  return search.startsWith("?") ? search.slice(1) : search;
}

/**
 * Email+parol bilan kirgandan keyin qayerga borish: OAuth oqimida server `url` qaytaradi (avtorizatsiyani davom
 * ettirish) — shunga o'tamiz; oddiy kirishda (yoki `url` yo'q bo'lsa) `null` — sahifa avvalgidek `/admin`ga boradi.
 */
export function oauthContinuationUrl(search: string, data: unknown): string | null {
  if (!hasSignedOAuthQuery(search)) return null;
  if (!data || typeof data !== "object" || !("url" in data)) return null;
  const url = (data as { url?: unknown }).url;
  return typeof url === "string" && url.length > 0 ? url : null;
}

export type ConsentViewState =
  | { kind: "invalid-link" }
  | { kind: "signed-out" }
  | { kind: "expired" }
  | { kind: "unavailable" }
  | { kind: "refused"; info: McpConsentInfo }
  | { kind: "unknown-client"; info: McpConsentInfo }
  | {
      kind: "ready";
      info: McpConsentInfo;
      groups: McpScopeGroupView[];
      offline: boolean;
      unknown: string[];
      /** "Xavfli amallar" guruhida ruxsat so'ralganmi (qizil ogohlantirish). */
      hasDanger: boolean;
    };

/** API `GET /connector/consent` javobini (yoki xatosini) sahifa holatiga aylantiradi. */
export function consentViewState(search: string, response: { status: number; body: unknown } | null): ConsentViewState {
  if (!hasSignedOAuthQuery(search)) return { kind: "invalid-link" };
  if (!response) return { kind: "unavailable" };
  if (response.status === 401) return { kind: "signed-out" };
  if (response.status === 400) return { kind: "expired" };
  if (response.status !== 200 || !isConsentInfo(response.body)) return { kind: "unavailable" };

  const info = response.body;
  if (!info.allowed) return info.reason === "not_admin" ? { kind: "refused", info } : { kind: "unknown-client", info };

  const { groups, offline, unknown } = groupRequestedScopes(info.scopes);
  return { kind: "ready", info, groups, offline, unknown, hasDanger: groups.some((group) => group.group === "danger") };
}

function isConsentInfo(value: unknown): value is McpConsentInfo {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<McpConsentInfo>;
  return typeof v.allowed === "boolean" && Array.isArray(v.scopes) && !!v.user && typeof v.user.email === "string";
}

/** Rozilik/rad javobidan (`{ url }`) brauzer o'tadigan manzil. Bo'lmasa `null`. */
export function consentRedirectUrl(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const url = (data as { url?: unknown }).url;
  return typeof url === "string" && url.length > 0 ? url : null;
}

/** "Ulangan ilovalar" jadvalida ruxsatlarni qisqa o'zbekcha nomlar bilan chiqarish uchun. */
export function describeConnectionScopes(scopes: readonly string[]): { labels: string[]; hasDanger: boolean; offline: boolean } {
  const { groups, offline } = groupRequestedScopes(scopes);
  return {
    labels: groups.flatMap((group) => group.scopes.map((scope) => scope.label)),
    hasDanger: groups.some((group) => group.group === "danger"),
    offline,
  };
}
