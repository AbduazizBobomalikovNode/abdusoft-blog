import {
  DISTRIBUTION_STATUS_LABELS,
  socialCounterState,
  X_TWEET_LIMIT,
  type XThreadSplit,
  type ChannelCheck,
  type CounterState,
  type DistributionAccountDto,
  type DistributionErrorKindDto,
  type DistributionItemDto,
  type DistributionProviderCapabilitiesDto,
  type DistributionProviderId,
  type DistributionStatus,
} from "@blog/shared";

/**
 * "Tarqatish" (LinkedIn, X, Threads, Instagram, GitHub README) UI mantig'i: holat ranglari, qaysi tugma qachon ruxsat etiladi,
 * jonli uzunlik hisoblagichi, token muddati matni, vaqt kiritish. Sof funksiyalar — testlanadi.
 */

/**
 * Jadvaldan faqat O'Z kalit bo'yicha qiymat oladi (`constructor`, `__proto__`, `toString` kabi prototip kalitlari `fallback` beradi).
 * Kalit tashqaridan (URL, server javobi) kelishi mumkin bo'lgan har bir qidiruv shu orqali o'tadi.
 */
export function own<V, F = V>(map: Readonly<Record<string, V>>, key: string | null | undefined, fallback: F): V | F {
  return typeof key === "string" && Object.hasOwn(map, key) ? (map[key] as V) : fallback;
}

export type Tone = "neutral" | "info" | "warn" | "success" | "danger";

export const STATUS_TONE: Record<DistributionStatus, Tone> = {
  draft: "neutral",
  scheduled: "info",
  sending: "info",
  sent: "success",
  failed: "danger",
  needs_checking: "warn",
  cancelled: "neutral",
};

export const TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  info: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  success: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  danger: "bg-destructive/10 text-destructive",
};

export function statusPill(status: DistributionStatus): { className: string; label: string } {
  return { className: TONE_CLASS[own(STATUS_TONE, status, "neutral")], label: own(DISTRIBUTION_STATUS_LABELS, status, status) };
}

export const ERROR_KIND_TEXT: Record<DistributionErrorKindDto, string> = {
  auth_expired: "Token yaroqsiz yoki muddati tugagan — akkauntni qayta ulang",
  permission_missing: "Platforma ruxsat bermadi — ilova ruxsatlarini tekshiring",
  rate_limited: "Platforma limiti oshdi — keyinroq o'zi qayta uriniladi",
  validation_rejected: "Platforma matn yoki rasmni rad etdi",
  duplicate_content: "Platforma bu matnni dublikat deb rad etdi — matnni o'zgartiring",
  payment_required: "Platformada to'lov yoki kredit kerak",
  transient: "Vaqtinchalik xato",
  outcome_unknown: "Natija noma'lum — post chiqqan bo'lishi mumkin, platformada tekshiring",
  refresh_ambiguous: "Token yangilash natijasi noma'lum — keyingi urinish ham xato bersa, qayta ulang",
  not_supported: "Bu amal platformada qo'llanmaydi",
  plan_invalid: "«Saytga chiqqach» rejasi bajarilmadi — post chop etilganda tekshiruv o'tmadi",
  internal: "Kutilmagan xato",
};

export interface ItemActions {
  /** Matn/rasm tahriri mumkinmi. */
  edit: boolean;
  save: boolean;
  send: boolean;
  schedule: boolean;
  cancel: boolean;
  retry: boolean;
  /** "Tekshirish kerak" ni hal qilish paneli. */
  resolve: boolean;
  remove: boolean;
  /** Yuborilgan postni yana yuborish (dublikat — tasdiq bilan). */
  sendAgain: boolean;
}

/** Qaysi tugma qachon: holat mashinasi serverdagi bilan bir xil (server baribir tekshiradi). */
export function itemActions(item: DistributionItemDto | null, channelReady: boolean, caps: Pick<DistributionProviderCapabilitiesDto, "delete"> | null): ItemActions {
  const status = item?.status ?? null;
  const open = status === null || status === "draft" || status === "failed" || status === "scheduled";
  const base: ItemActions = {
    edit: open,
    save: open,
    send: open && channelReady,
    schedule: open && channelReady,
    cancel: status === "draft" || status === "scheduled" || status === "failed",
    retry: status === "failed" && channelReady,
    resolve: status === "needs_checking",
    remove: status === "sent" && Boolean(caps?.delete) && Boolean(item?.externalId),
    sendAgain: false,
  };
  if (status === "sent" || status === "cancelled") {
    return { ...base, edit: true, save: true, send: false, schedule: false, sendAgain: channelReady };
  }
  return base;
}

export function counterView(provider: DistributionProviderId, text: string, limit: number | null): CounterState & { label: string; className: string } {
  const st = socialCounterState(provider, text, limit);
  const label = limit === null ? `${st.length}` : `${st.length} / ${limit}`;
  const className = st.level === "over" ? "text-destructive" : st.level === "warn" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground";
  return { ...st, label, className };
}

/**
 * Matn ostidagi hisoblagich izohi. Avval faqat birlik nomi ("belgi") chiqardi — yolg'iz so'z bo'lib qolardi.
 * Endi "belgi" birligida qoldiq ("123 belgi qoldi" / "12 belgi ortiqcha"), boshqa birliklarda — hisoblash usuli tavsifi.
 */
export function counterDetail(unit: DistributionProviderCapabilitiesDto["textUnit"], counter: Pick<CounterState, "remaining">): string {
  if (unit === "characters") {
    if (counter.remaining === null) return "";
    return counter.remaining >= 0 ? `${counter.remaining} belgi qoldi` : `${-counter.remaining} belgi ortiqcha`;
  }
  return own(UNIT_LABEL, unit, "");
}

export interface ThreadCounterView {
  label: string;
  className: string;
  level: "ok" | "warn" | "over";
  /** Qisqa tafsilot (ixtiyoriy): eng uzun/oshib ketgan bo'lak. */
  detail: string;
}

/** Zanjir hisoblagichi: "3 ta tvit · 2-si 291/280" (oshgan bo'lak) yoki "3 ta tvit · eng uzuni 271/280". */
export function threadCounterView(split: XThreadSplit): ThreadCounterView {
  const limit = X_TWEET_LIMIT;
  if (split.count === 0) return { label: "0 ta tvit", className: "text-muted-foreground", level: "ok", detail: "" };
  const overIdx = split.parts.findIndex((p) => p.over);
  const longest = split.parts.reduce((m, p) => Math.max(m, p.weight), 0);
  const base = `${split.count} ta tvit`;
  if (split.tooMany) return { label: `${base} (ko'pi bilan ${split.maxParts})`, className: "text-destructive", level: "over", detail: "" };
  if (overIdx >= 0) {
    const p = split.parts[overIdx]!;
    return { label: `${base} · ${overIdx + 1}-si ${p.weight}/${limit}`, className: "text-destructive", level: "over", detail: `${overIdx + 1}-tvit ${p.weight - limit} birlikka oshgan` };
  }
  return { label: `${base} · eng uzuni ${longest}/${limit}`, className: longest > limit * 0.95 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground", level: longest > limit * 0.95 ? "warn" : "ok", detail: "" };
}

export const UNIT_LABEL: Record<DistributionProviderCapabilitiesDto["textUnit"], string> = {
  characters: "belgi",
  weighted: "X hisobida (havola = 23, emoji = 2)",
  utf8_bytes: "Threads hisobida (emoji = UTF-8 bayt)",
  none: "",
};

const DAY_MS = 86_400_000;

/** Token holati: rang va qisqa matn ("12 kun qoldi", "muddati tugagan", "qayta ulash kerak"). */
export function tokenLine(account: DistributionAccountDto | null, now: Date = new Date()): { tone: Tone; text: string } {
  if (!account) return { tone: "neutral", text: "Ulanmagan" };
  if (account.status === "reauth_required" || account.tokenState === "expired") return { tone: "danger", text: "Token yaroqsiz — qayta ulash kerak" };
  if (account.neverExpires && account.expiresAt === null) return { tone: "success", text: "Token muddatsiz (tugamaydi)" };
  if (account.expiresAt === null) return { tone: "success", text: account.canRefresh ? "Token o'zi yangilanadi" : "Muddati noma'lum" };
  const left = Math.ceil((new Date(account.expiresAt).getTime() - now.getTime()) / DAY_MS);
  if (account.canRefresh && account.tokenState === "ok") return { tone: "success", text: "Token o'zi yangilanadi" };
  const text = left <= 0 ? "Token bugun tugaydi" : left === 1 ? "Token 1 kundan keyin tugaydi" : `Token ${left} kundan keyin tugaydi`;
  return { tone: account.tokenState === "expiring" ? "warn" : "success", text };
}

export function groupChecks(checks: ChannelCheck[]): { errors: ChannelCheck[]; warnings: ChannelCheck[]; ok: ChannelCheck[] } {
  return {
    errors: checks.filter((c) => c.status === "error"),
    warnings: checks.filter((c) => c.status === "warn"),
    ok: checks.filter((c) => c.status === "ok"),
  };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** `<input type="datetime-local">` qiymati (mahalliy vaqt) -> ISO (UTC). Noto'g'ri bo'lsa `null`. */
export function localInputToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Eng erta tanlanadigan vaqt (hozir + 5 daqiqa), `datetime-local` formatida (mahalliy vaqt). */
export function minScheduleInput(now: Date = new Date()): string {
  const d = new Date(now.getTime() + 5 * 60_000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function isFutureEnough(isoValue: string | null, now: Date = new Date()): boolean {
  return isoValue !== null && new Date(isoValue).getTime() >= now.getTime() + 60_000;
}

/** Qo'lda "yuborilgan" deb belgilash uchun havola tekshiruvi (server ham tekshiradi). */
export function isHttpsUrl(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return u.protocol === "https:" && u.hostname.includes(".") && !u.username && !u.password;
  } catch {
    return false;
  }
}

export const IMAGE_CHOICE_LABEL = { auto: "Avto (muqova, bo'lmasa sayt rasmi)", cover: "Faqat muqova", og: "Saytning OG rasmi", none: "Rasmsiz" } as const;
export const LINK_MODE_LABEL = { article: "Maqola kartasi (rasm bilan)", text: "Matn + havola" } as const;

export const NO_AUTO_POST_NOTICE =
  "Maqola chop etilganda hech narsa o'zi YUBORILMAYDI. Post faqat siz «Yuborish», «Rejalashtirish» yoki «Saytga chiqqach» rejasini qo'ygandagina (yoki yordamchingiz aniq buyruq berganda) yuboriladi.";

export type EditorState = { text: string; edited: boolean };

/** Matn maydoni: standart matn bilan teng bo'lsa "tahrirlanmagan" (serverga `null` ketadi). */
export function textForSave(text: string, defaultText: string): string | null {
  return text.trim() === "" || text === defaultText ? null : text;
}

// ---------------------------------------------------------------------------------------------
// OAuth callback'dan keyingi xabarlar: URL'dagi `reason` faqat QISQA KOD — matn shu yerdagi qat'iy jadvaldan olinadi.
// Noma'lum qiymat hech qachon ekranga chiqarilmaydi (URL'ga yozilgan matn toast'da ko'rinmasin).
// ---------------------------------------------------------------------------------------------

export const CALLBACK_REASON_TEXT: Record<string, string> = {
  state_invalid: "Ulanish so'rovi yaroqsiz yoki allaqachon ishlatilgan — qaytadan boshlang",
  state_expired: "Ulanish so'rovi muddati tugagan (10 daqiqa) — qaytadan boshlang",
  denied: "Platformada ruxsat berilmadi yoki bekor qilindi",
  exchange_failed: "Platforma tokenni bermadi — Client ID/Secret va redirect URL'ni tekshiring",
  forbidden: "Bu so'rov boshqa foydalanuvchi sessiyasi uchun boshlangan",
  not_configured: "Platforma ilovasi sozlanmagan",
  // Instagram (Unified Login):
  no_instagram_account: "Meta konfiguratsiyasiga biriktirilgan Instagram akkaunt topilmadi — loginda akkauntni tanlang va uni Instagram Tester qiling",
  config_invalid: "Config ID noto'g'ri yoki o'chirilgan — Meta ilovasidagi konfiguratsiyani tekshiring",
  login_failed: "Meta login oynasi xato bilan tugadi — Meta App ID, Config ID va Redirect URL'ni tekshiring",
  account_lookup_failed: "Token olindi, lekin Instagram akkauntlarini o'qib bo'lmadi — konfiguratsiyada instagram_basic ruxsatini tekshiring",
  multiple_instagram_accounts: "Meta konfiguratsiyasi bir nechta Instagram akkauntga ruxsat beryapti — login oynasida (yoki konfiguratsiyada) aynan bittasini tanlang va qaytadan ulang",
};

export const CALLBACK_REASON_FALLBACK = "Ulanish muvaffaqiyatsiz";

const PROVIDER_NAMES: Record<string, string> = { linkedin: "LinkedIn", x: "X", threads: "Threads", instagram: "Instagram", github: "GitHub" };

/** `?dist=...&provider=...&reason=...` (callback yo'naltirishi) dan ko'rsatiladigan xabar; `dist` noma'lum bo'lsa `null`. */
export function callbackToast(params: { get(name: string): string | null }): { kind: "success" | "error"; text: string } | null {
  const dist = params.get("dist");
  if (dist === "connected") {
    const name = own(PROVIDER_NAMES, params.get("provider"), "");
    return { kind: "success", text: name ? `${name} ulandi` : "Akkaunt ulandi" };
  }
  if (dist === "error") {
    const reason = params.get("reason") ?? "";
    return { kind: "error", text: own(CALLBACK_REASON_TEXT, reason, CALLBACK_REASON_FALLBACK) };
  }
  return null;
}

/** Kirish sahifasidagi `?notice=` kodi -> qat'iy matn (noma'lum kod e'tiborga olinmaydi). */
export const LOGIN_NOTICE_TEXT: Record<string, string> = {
  dist_session_expired: "Sessiya muddati tugagan. Kiring va tarmoqni ulashni qaytadan boshlang (Sozlamalar → Tarqatish kanallari).",
};

export function loginNotice(search: string): string | null {
  const code = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("notice") ?? "";
  return own(LOGIN_NOTICE_TEXT, code, null);
}

// ---------------------------------------------------------------------------------------------
// Savatdagi post: avval yuborilganlar va kutayotganlar ko'rinadi (faqat o'qish); yangi yuborish/rejalashtirish yo'q.
// ---------------------------------------------------------------------------------------------

export interface TrashedActions {
  /** Rejalashtirilgan yuborishni bekor qilish (savatdagi post baribir yuborilmaydi — qator "xato" bilan tugamasin). */
  cancel: boolean;
  /** "Tekshirish kerak"ni hal qilish: «yuborilgan» deb belgilash yoki «platformada yo'q». Qayta urinish yo'q (post savatda). */
  resolve: boolean;
  remove: boolean;
}

export function trashedItemActions(item: DistributionItemDto, caps: Pick<DistributionProviderCapabilitiesDto, "delete"> | null): TrashedActions {
  return { cancel: item.status === "scheduled", resolve: item.status === "needs_checking", remove: itemActions(item, false, caps).remove };
}

/** Savatdagi post dialogida ko'rsatiladigan qatorlar: faol, yuborilgan va olib tashlanganlar (oddiy bekor qilinganlar yashiriladi). */
export function trashedVisibleItems(items: DistributionItemDto[]): DistributionItemDto[] {
  return items.filter((d) => d.status !== "cancelled" || Boolean(d.removedAt));
}

/** Tarmoq nomi (tablardagi kabi: qavs ichidagi izoh olib tashlanadi). */
export function channelShortName(channels: { id: string; name: string }[], provider: string): string {
  const ch = channels.find((c) => c.id === provider);
  return (ch?.name ?? provider).replace(/ \(.*\)/, "");
}

/**
 * Postni BUTUNLAY o'chirishdan oldingi ogohlantirish: platformaga yuborilgan (va olib tashlanmagan) postlar bo'lsa, o'chirgandan
 * keyin ularni panel orqali olib tashlab bo'lmaydi. Yuborilgani yo'q bo'lsa `null`.
 */
export function purgeDistributionWarning(items: DistributionItemDto[], channels: { id: string; name: string }[]): string | null {
  const providers = [...new Set(items.filter((d) => d.status === "sent" && !d.removedAt).map((d) => d.provider))];
  if (providers.length === 0) return null;
  const names = providers.map((p) => channelShortName(channels, p)).join(", ");
  return `Diqqat: bu post quyidagi tarmoqlarga yuborilgan: ${names}. Butunlay o'chirilgandan keyin bu postlarni panel orqali tarmoqlardan olib tashlab bo'lmaydi (faqat platformaning o'zida qo'lda o'chirish mumkin). Kerak bo'lsa, avval «Tarqatish» orqali olib tashlang.`;
}

export const PURGE_CHECK_FAILED_WARNING = "Bu postning tarmoqlarga yuborilgan-yuborilmaganini tekshirib bo'lmadi. Yuborilgan bo'lsa, butunlay o'chirilgandan keyin uni panel orqali tarmoqdan olib tashlab bo'lmaydi.";
