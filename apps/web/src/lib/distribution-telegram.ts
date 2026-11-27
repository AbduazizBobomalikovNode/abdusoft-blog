import { CHANNEL_SEND_AT_MAX_DAYS, isAbsoluteChannelPlan, type AdminPostStatus, type ChannelPlan, type ChannelPublishOutcome, type ChannelSelection, type ChannelStatus, type ResolvedChannelChoice } from "@blog/shared";
import { canPlanForPost, planPhrase } from "./distribution-plan";
import { localInputToIso } from "./distribution-ui";

/** "Tarqatish" dialogidagi Telegram yorlig'i uchun xulosa qatorlari (sof; ma'lumot tahrirlagichda allaqachon bor). */
export interface TelegramTabSummary {
  choice: string;
  plan: string;
  sent: string;
}

export function telegramTabSummary(input: {
  choice: ResolvedChannelChoice | null;
  plan: ChannelPlan | null;
  sent: boolean;
}): TelegramTabSummary {
  const { choice, plan, sent } = input;
  return {
    choice: choice ? `⭐ ${choice.label} · ${choice.visibleLength} / ${choice.limit} · ${choice.passes ? "cheklovlardan o'tadi" : "cheklovlarga mos emas"}` : "belgilanmagan (standart)",
    plan: plan ? (isAbsoluteChannelPlan(plan) ? `kanalga ${formatChannelAt(plan.sendAt)} da` : `saytga ${planPhrase(plan.delayMinutes)}`) : "reja yo'q",
    sent: sent ? "kanalga yuborilgan" : "hali yuborilmagan",
  };
}

/** Belgilangan tanlovdan oldindan ko'rish so'rovi tanlovi (belgi yo'q bo'lsa `null` — ko'rinish so'ralmaydi). */
export function previewSelectionOf(choice: ResolvedChannelChoice | null): ChannelSelection | null {
  if (!choice) return null;
  return choice.choice.kind === "version" ? { versionId: choice.choice.versionId } : { mode: choice.choice.mode, variant: choice.choice.variant };
}

/** Telegram panelining "Tarqatish" dialogidagi rejimi: chop etilgan post — yuborish; aks holda — tayyorlash (belgi + reja). Server qoidalari o'zgarmagan. */
export function telegramPanelMode(postStatus: AdminPostStatus | string): "send" | "prepare" {
  return postStatus === "published" ? "send" : "prepare";
}

/** Telegram rejasi (saytga chiqqach N daq) faqat hali chop etilmagan postga qo'yiladi — chop etilgan postda reja bloki ko'rsatilmaydi. */
export function telegramPlanEditable(postStatus: AdminPostStatus | string): boolean {
  return canPlanForPost(postStatus);
}

/**
 * Reja qayerda saqlanishi haqida bir qatorli izoh: chop etilmagan postda (qoralama / ko'rib chiqishda / rejalashtirilgan) reja avtomatik
 * saqlanadi va post HAR SAFAR chop etilganda (qo'lda ham) o'sha paytdan hisoblanadi; qoralamaga qaytarilsa reja saqlanib qoladi.
 */
export function telegramPlanStorageHint(postStatus: AdminPostStatus | string): string {
  return canPlanForPost(postStatus) ? `Reja avtomatik saqlanadi. ${TELEGRAM_PLAN_NOTE}` : "";
}

/** Reja qachon bajarilishi haqida qisqa tushuntirish (Telegram paneli va "Nashr" kartasi). */
export const TELEGRAM_PLAN_NOTE = "Post har safar chop etilganda (qo'lda ham, rejalashtirilgan ham) kechikish o'sha paytdan hisoblanadi; qoralamaga qaytarilsa reja saqlanib qoladi. Arxivlansa reja o'chadi.";

/** Oldindan ko'rish hech qachon bo'sh qolmasligi uchun: belgi bo'lmasa — standart ko'rinish (rasm bo'lsa 🖼/m, aks holda 📝/m). */
export function telegramDefaultSelection(canUseMedia: boolean | null): ChannelSelection {
  return { mode: canUseMedia === false ? "text" : "media", variant: "m" };
}

/** "Nashr" kartasidagi bir qatorli Telegram reja xulosasi. */
export function telegramPlanLine(plan: ChannelPlan | null): string {
  if (plan && isAbsoluteChannelPlan(plan)) return `Telegram · kanalga ${formatChannelAt(plan.sendAt)} da yuboriladi`;
  return plan ? `Telegram · saytga ${planPhrase(plan.delayMinutes)}` : "Telegram rejasi yo'q — post chop etilgach kanalga hech narsa yuborilmaydi.";
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** ISO -> mahalliy "28.11 14:30" (boshqa yil bo'lsa "28.11.2027 14:30"). Noto'g'ri qiymat — "—". */
export function formatChannelAt(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const date = `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}${d.getFullYear() === now.getFullYear() ? "" : `.${d.getFullYear()}`}`;
  return `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** ISO (UTC) -> `<input type="datetime-local">` qiymati (mahalliy vaqt); noto'g'ri bo'lsa bo'sh satr. */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Rejaning kechikish qismi o'zgaradi — aniq vaqt (agar bor edi) olib tashlanadi (ikkalasi bir-birini inkor etadi). */
export function planWithDelay(plan: ChannelPlan, delayMinutes: number): ChannelPlan {
  const { sendAt: _drop, ...rest } = plan;
  void _drop;
  return { ...rest, delayMinutes };
}

/** Rejaga aniq vaqt qo'yadi (kechikish 0). */
export function planWithSendAt(plan: ChannelPlan, sendAt: string): ChannelPlan {
  return { ...plan, delayMinutes: 0, sendAt };
}

/** Rejaning vaqt qismi (tanlov o'zgarganda saqlab qolinadi): `{ delayMinutes }` yoki `{ delayMinutes: 0, sendAt }`. */
export function planTiming(plan: ChannelPlan): { delayMinutes: number; sendAt?: string } {
  return isAbsoluteChannelPlan(plan) ? { delayMinutes: 0, sendAt: plan.sendAt } : { delayMinutes: plan.delayMinutes };
}

/**
 * Aniq vaqtni mijoz tomonida tekshiradi (server baribir tekshiradi): kelajakda, (rejalashtirilgan postda) post chiqishidan oldin emas,
 * eng ko'pi 1 yil. `local` — `datetime-local` qiymati; `notBeforeLocal` — post saytga chiqish vaqti (bo'lsa). Xato matni yoki `null`.
 */
export function absoluteTimeError(local: string, opts: { notBeforeLocal?: string; now?: Date } = {}): string | null {
  const now = opts.now ?? new Date();
  const iso = localInputToIso(local);
  if (!iso) return "Vaqtni tanlang";
  const at = new Date(iso).getTime();
  if (at <= now.getTime()) return "Vaqt kelajakda bo'lishi kerak";
  const notBefore = opts.notBeforeLocal ? localInputToIso(opts.notBeforeLocal) : null;
  if (notBefore && at < new Date(notBefore).getTime()) return "Kanal vaqti post saytga chiqishidan oldin bo'lmasin";
  if (at > now.getTime() + CHANNEL_SEND_AT_MAX_DAYS * 86_400_000) return `Vaqt ${CHANNEL_SEND_AT_MAX_DAYS} kundan uzoq bo'lmasin`;
  return null;
}

/** Tarqatish dialogining Telegram holat qatori (serverdagi `ChannelStatus`dan). */
export function telegramStatusLine(status: ChannelStatus | null, now: Date = new Date()): string {
  if (!status) return "Holat yuklanmoqda…";
  switch (status.state) {
    case "sending":
      return "Kanalga yuborilmoqda…";
    case "planned":
      if (status.sentAt) return `Kanalga yuborilgan · ${formatChannelAt(status.sentAt, now)} (kutayotgan reja qolgan)`;
      if (status.sendAt) return `Kanalga ${formatChannelAt(status.sendAt, now)} da yuboriladi`;
      return status.plan?.kind === "delay" ? `Kanalga saytga ${planPhrase(status.plan.delayMinutes ?? 0)} yuboriladi` : "Kanalga yuborish rejalashtirilgan";
    case "sent":
      return status.sentAt ? `Kanalga yuborilgan · ${formatChannelAt(status.sentAt, now)}` : "Kanalga yuborilgan";
    default:
      return "Kanalga hali yuborilmagan";
  }
}

/** "Aniq vaqt" bloki tahrirlanadimi: yuborilgan (`sentAt`) yoki yuborilayotgan postda — yo'q (server rad etadi). */
export function canEditSendAt(status: ChannelStatus | null): boolean {
  return status !== null && status.state !== "sending" && status.state !== "sent" && status.sentAt === null;
}

/** Oxirgi muvaffaqiyatsiz urinish qatori (xato yo'q — `null`). Xato matni serverda tozalangan; qayta urinish kutilsa shu haqida ham aytiladi. */
export function telegramErrorLine(status: ChannelStatus | null, now: Date = new Date()): string | null {
  const err = status?.lastError;
  if (!status || !err) return null;
  const when = err.at ? ` (${formatChannelAt(err.at, now)})` : "";
  const retry = status.state === "planned" || status.state === "sending" ? " — qayta uriniladi" : "";
  return `Oxirgi urinish muvaffaqiyatsiz${when}: ${err.message}${retry}`;
}

/** Yorliq nuqtasi uchun Telegram holati: `null` — reja ham, yuborish ham yo'q (nuqta avvalgidek). `failed` — oxirgi urinish xato va kutayotgan narsa yo'q. */
export function telegramDotTone(status: ChannelStatus | null): "planned" | "sending" | "sent" | "failed" | null {
  if (!status) return null;
  if (status.state === "none") return status.lastError ? "failed" : null;
  if (status.sentAt && status.state === "planned") return "sent";
  return status.state;
}

/**
 * Chop etishdan keyin saqlangan Telegram rejasi haqida toast matni: navbatga qo'yildi (`info`) yoki tashlandi (`warning`, sababi bilan).
 * Reja bo'lmasa `null`. `now` — faqat vaqtni formatlash uchun.
 */
export function channelPublishNotice(outcome: ChannelPublishOutcome | null | undefined, now: Date = new Date()): { tone: "info" | "warning"; text: string } | null {
  if (!outcome || outcome.state === "none") return null;
  if (outcome.state === "armed") return { tone: "info", text: `Telegram rejasi ishga tushdi: kanalga ${formatChannelAt(outcome.at, now)} da yuboriladi` };
  const why = {
    past_time: "aniq vaqti allaqachon o'tib ketgan",
    already_sent: "post kanalga allaqachon yuborilgan",
    no_permission: "kanalga yuborish ruxsati yo'q",
    invalid: "reja yaroqsiz edi",
  }[outcome.reason];
  return { tone: "warning", text: `Telegram rejasi bekor qilindi (${why}) — kanalga avtomatik yuborilmaydi` };
}

/** Tahrirlagichni saqlatish natijasi: hech narsa o'zgarmagan / saqlandi / saqlanmadi. */
export type FlushOutcome = "clean" | "saved" | "failed";

export const FLUSH_SAVED_HINT = "O'zgarishlar saqlandi — tekshiruvni ko'rib, qayta bosing";

/**
 * Yuborishdan oldingi saqlash qarori: faqat "clean"da yuboriladi. "saved"da matn o'zgargan — ko'rsatilgan tekshiruv/ogohlantirish
 * ESKI matn uchun edi, shuning uchun shu bosishda yuborilmaydi (ko'rinish qayta yuklanib, tekshiruv qayta ishlaydi).
 */
export function sendGate(outcome: FlushOutcome): "send" | "stop-saved" | "stop-failed" {
  return outcome === "clean" ? "send" : outcome === "saved" ? "stop-saved" : "stop-failed";
}

/** Sinxron "jarayonda" qo'riqchisi: ikkinchi bosish (qayta render kutmasdan) rad etiladi. */
export function createInFlightGuard() {
  let busy = false;
  return {
    tryEnter(): boolean {
      if (busy) return false;
      busy = true;
      return true;
    },
    leave(): void {
      busy = false;
    },
  };
}
