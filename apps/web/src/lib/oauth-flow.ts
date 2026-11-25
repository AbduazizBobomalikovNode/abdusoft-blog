import {
  MCP_OFFLINE_SCOPE,
  MCP_REQUIRED_SCOPE_ID,
  MCP_SCOPES,
  groupRequestedScopes,
  type McpConsentInfo,
  type McpScopeGroup,
  type McpScopeGroupView,
} from "@blog/shared";

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

/** Begona (anonim ro'yxatdan o'tgan) klient nomini ko'rsatish uchun: bo'sh joylarni yig'ib, ~60 belgigacha qisqartiradi. */
export function displayClientName(name: string | null | undefined, max = 60): string {
  const clean = (name ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "Nomsiz ilova";
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** "3 daqiqa oldin" ko'rinishida; noma'lum bo'lsa `null`. */
export function registeredAgo(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (!iso) return null;
  const sec = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (Number.isNaN(sec)) return null;
  if (sec < 60) return "hozirgina";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} daqiqa oldin`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} soat oldin`;
  return `${Math.floor(hours / 24)} kun oldin`;
}

/** Faqat o'qish ruxsati so'ralganmi (yozish/chop etish/xavfli guruhlarsiz). */
export function isReadOnlyRequest(groups: readonly { group: string }[]): boolean {
  return groups.every((group) => group.group === "read");
}

// ---------------------------------------------------------------------------------------------
// Ruxsatlarni alohida tanlash (rozilik sahifasi)
// ---------------------------------------------------------------------------------------------

/**
 * Standart tanlov: o'qish (majburiy) va qoralama yozish + rasm yuklash — oldindan belgilangan. Chop etish guruhi (chop etish,
 * kanalga yuborish) va xavfli guruh BELGILANMAGAN: ularni egasi ongli ravishda yoqadi. Faqat so'ralgan ruxsatlar.
 */
export function defaultScopeSelection(requested: readonly string[]): string[] {
  const asked = new Set(requested);
  return MCP_SCOPES.filter((scope) => asked.has(scope.id) && (scope.id === MCP_REQUIRED_SCOPE_ID || scope.group === "write")).map((scope) => scope.id);
}

/** Bitta ruxsatni almashtiradi. Majburiy ruxsat o'chirilmaydi, so'ralmagan ruxsat qo'shilmaydi. Yangi massiv qaytaradi. */
export function toggleScope(selected: readonly string[], scopeId: string, requested: readonly string[]): string[] {
  if (scopeId === MCP_REQUIRED_SCOPE_ID || !requested.includes(scopeId) || !MCP_SCOPES.some((s) => s.id === scopeId)) return [...selected];
  const next = selected.includes(scopeId) ? selected.filter((id) => id !== scopeId) : [...selected, scopeId];
  return MCP_SCOPES.filter((s) => next.includes(s.id) || (s.id === MCP_REQUIRED_SCOPE_ID && requested.includes(s.id))).map((s) => s.id);
}

/** `POST /oauth2/consent` `scope` qatori: `MCP_SCOPES` tartibida tanlanganlar, so'ralgan bo'lsa oxirida `offline_access`. */
export function serializeScopeSelection(selected: readonly string[], requested: readonly string[]): string {
  const ids = MCP_SCOPES.filter((s) => selected.includes(s.id) && requested.includes(s.id)).map((s) => s.id);
  if (requested.includes(MCP_REQUIRED_SCOPE_ID) && !ids.includes(MCP_REQUIRED_SCOPE_ID)) ids.unshift(MCP_REQUIRED_SCOPE_ID);
  if (requested.includes(MCP_OFFLINE_SCOPE)) ids.push(MCP_OFFLINE_SCOPE);
  return ids.join(" ");
}

/** O'qishdan boshqa hech narsa tanlanmagan. */
export function isReadOnlySelection(selected: readonly string[]): boolean {
  return selected.every((id) => id === MCP_REQUIRED_SCOPE_ID);
}

function groupOf(id: string): McpScopeGroup | null {
  return MCP_SCOPES.find((s) => s.id === id)?.group ?? null;
}

/** Tanlanganlar orasida xavfli ruxsat bormi. */
export function hasDangerSelected(selected: readonly string[]): boolean {
  return selected.some((id) => groupOf(id) === "danger");
}

/** Har bir guruh uchun: so'ralgan va tanlangan ruxsatlar soni. */
export function selectionSummary(selected: readonly string[], requested: readonly string[]): Record<McpScopeGroup, { selected: number; total: number }> {
  const out: Record<McpScopeGroup, { selected: number; total: number }> = {
    read: { selected: 0, total: 0 },
    write: { selected: 0, total: 0 },
    publish: { selected: 0, total: 0 },
    danger: { selected: 0, total: 0 },
  };
  for (const scope of MCP_SCOPES) {
    if (!requested.includes(scope.id)) continue;
    out[scope.group].total += 1;
    if (selected.includes(scope.id)) out[scope.group].selected += 1;
  }
  return out;
}

/** "Ulangan ilovalar": berilgan ruxsatlar guruhlar bo'yicha (nomlari bilan) + faqat-o'qish belgisi. */
export function describeConnectionPermissions(scopes: readonly string[]): {
  groups: Array<{ group: McpScopeGroup; labels: string[] }>;
  readOnly: boolean;
  hasDanger: boolean;
  offline: boolean;
} {
  const { groups, offline } = groupRequestedScopes(scopes);
  return {
    groups: groups.map((g) => ({ group: g.group, labels: g.scopes.map((s) => s.label) })),
    readOnly: groups.every((g) => g.group === "read"),
    hasDanger: groups.some((g) => g.group === "danger"),
    offline,
  };
}

/**
 * Serverda yozuv vositalari o'chiq (`writeToolsEnabled === false`) bo'lsa, ulanishdagi yozish/chop etish/xavfli ruxsatlar
 * hozir ishlamaydi (ular saqlanadi, lekin vositalar yo'q). `undefined` (eski API) — o'chiq deb hisoblanmaydi.
 */
export function inactiveConnectionScopes(scopes: readonly string[], writeToolsEnabled: boolean | undefined): string[] {
  if (writeToolsEnabled !== false) return [];
  return MCP_SCOPES.filter((s) => s.group !== "read" && scopes.includes(s.id)).map((s) => s.id);
}
