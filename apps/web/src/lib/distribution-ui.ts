import {
  socialCounterState,
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
  "Maqola chop etilganda hech narsa AVTOMATIK yuborilmaydi. Post faqat siz «Yuborish» yoki «Rejalashtirish»ni bosganingizdagina (yoki yordamchingiz aniq buyruq berganda) yuboriladi.";

export type EditorState = { text: string; edited: boolean };

/** Matn maydoni: standart matn bilan teng bo'lsa "tahrirlanmagan" (serverga `null` ketadi). */
export function textForSave(text: string, defaultText: string): string | null {
  return text.trim() === "" || text === defaultText ? null : text;
}
