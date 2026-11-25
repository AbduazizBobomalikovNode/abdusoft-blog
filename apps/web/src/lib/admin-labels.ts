/**
 * Admin panel uchun o'zbekcha yorliqlar: o'zgarish manbai (`via`), revision sababi, jurnal amallari va
 * "kim o'zgartirdi" matni. Noma'lum qiymatlar HECH QACHON xato bermaydi — xom kod ko'rsatiladi
 * (API keyinchalik yangi manba yoki amal qo'shsa ham panel buzilmaydi).
 */

/** `ActorVia` qiymatlari + filtr uchun tartib. */
export const VIA_VALUES = ["web", "mcp", "telegram", "scheduler", "system"] as const;

const VIA_LABELS: Record<string, string> = {
  web: "Veb panel",
  mcp: "Yordamchi ulagich",
  telegram: "Telegram",
  scheduler: "Rejalashtiruvchi",
  system: "Tizim",
};

/** `web` — odam veb panelda; `telegram` — odam, lekin bot orqali; `automated` — odam emas (assistent/scheduler/tizim). */
export type ViaKind = "web" | "telegram" | "automated" | "unknown";

export function viaKind(via: string | null | undefined): ViaKind {
  if (via === "web") return "web";
  if (via === "telegram") return "telegram";
  if (via === "mcp" || via === "scheduler" || via === "system") return "automated";
  return "unknown";
}

/** Odam bo'lmagan manba (assistent, rejalashtiruvchi, tizim) — alohida ajratib ko'rsatiladi. */
export function isAutomatedVia(via: string | null | undefined): boolean {
  return viaKind(via) === "automated";
}

export function viaLabel(via: string | null | undefined): string {
  if (!via) return "Noma'lum manba";
  return VIA_LABELS[via] ?? via;
}

const REVISION_REASON_LABELS: Record<string, string> = {
  update: "Tahrirdan oldingi holat",
  publish: "Chop etishdan oldin",
  unpublish: "Qoralamaga qaytarishdan oldin",
  archive: "Arxivlashdan oldin",
  schedule: "Rejalashtirishdan oldin",
  trash: "Savatga ko'chirishdan oldin",
  "restore-revision": "Versiyaga qaytarishdan oldin",
  overwrite: "Almashtirishdan oldin",
};

export function revisionReasonLabel(reason: string | null | undefined): string {
  if (!reason) return "Saqlangan holat";
  return REVISION_REASON_LABELS[reason] ?? reason;
}

const AUDIT_ACTION_LABELS: Record<string, string> = {
  "post.create": "Post yaratildi",
  "post.update": "Post tahrirlandi",
  "post.submit": "Ko'rib chiqishga yuborildi",
  "post.approve": "Post tasdiqlandi",
  "post.request_changes": "Tuzatish so'raldi",
  "post.publish": "Post chop etildi",
  "post.publish_scheduled": "Rejalashtirilgan post chop etildi",
  "post.unpublish": "Qoralamaga qaytarildi",
  "post.archive": "Post arxivlandi",
  "post.schedule": "Post rejalashtirildi",
  "post.trash": "Savatga ko'chirildi",
  "post.restore_trash": "Savatdan tiklandi",
  "post.purge": "Butunlay o'chirildi",
  "post.restore_revision": "Eski versiyaga qaytarildi",
  "post.channel_send": "Kanalga yuborildi",
  "post.channel_replace": "Kanaldagi post almashtirildi",
  "post.channel_send_failed": "Kanalga yuborish muvaffaqiyatsiz",
  "post.channel_resync": "Kanal sarlavhasi yangilandi",
  "post.channel_choice_set": "Kanal versiyasi belgilandi",
  "post.channel_choice_clear": "Kanal versiyasi belgisi olindi",
  "post.channel_version_create": "Kanal versiyasi yaratildi",
  "post.channel_version_update": "Kanal versiyasi tahrirlandi",
  "post.channel_version_delete": "Kanal versiyasi o'chirildi",
  "comment.status": "Fikr holati o'zgardi",
  "comment.bulk_status": "Fikrlar holati o'zgardi",
  "comment.delete": "Fikr o'chirildi",
  "comment.reply": "Fikrga javob berildi",
  "comment.ban": "Qurilma bloklandi",
  "comment.send_to_telegram": "Fikr Telegramga yuborildi",
  "ban.remove": "Blok olib tashlandi",
  "tag.create": "Teg yaratildi",
  "tag.update": "Teg tahrirlandi",
  "tag.delete": "Teg o'chirildi",
  "media.upload": "Rasm yuklandi",
  "media.update": "Rasm tahrirlandi",
  "media.delete": "Rasm o'chirildi",
  "staff.invite_create": "Xodim taklifi yaratildi",
  "staff.invite_revoke": "Xodim taklifi bekor qilindi",
  "staff.invite_accept": "Xodim taklifi qabul qilindi",
  "staff.remove": "Xodim olib tashlandi",
  "staff.password_link_create": "Xodim uchun parol havolasi yaratildi",
  "auth.password_reset_request": "Parolni tiklash so'ralindi",
  "auth.password_reset_complete": "Parol tiklandi",
  "auth.password_reset_server": "Parol serverda tiklandi",
  "settings.update": "Sozlamalar o'zgardi",
  "site.update": "Sayt ma'lumotlari o'zgardi",
};

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

/** Filtr ro'yxati uchun: `[kod, yorliq]`, mavzu bo'yicha tartiblangan. */
export const AUDIT_ACTION_OPTIONS: { value: string; label: string }[] = Object.entries(AUDIT_ACTION_LABELS).map(
  ([value, label]) => ({ value, label }),
);

const ENTITY_LABELS: Record<string, string> = {
  post: "Post",
  comment: "Fikr",
  tag: "Teg",
  media: "Rasm",
  ban: "Blok",
  settings: "Sozlamalar",
  site: "Sayt",
  staff_invite: "Xodim taklifi",
  user: "Foydalanuvchi",
};

export function entityLabel(entityType: string): string {
  return ENTITY_LABELS[entityType] ?? entityType;
}

export const AUDIT_ENTITY_OPTIONS: { value: string; label: string }[] = Object.entries(ENTITY_LABELS).map(
  ([value, label]) => ({ value, label }),
);

/**
 * Amalni bajargan (yoki oxirgi o'zgartirgan) kim: foydalanuvchi nomi bo'lsa — o'sha; aks holda manbaga qarab
 * ("Rejalashtiruvchi" / "Tizim"). Hisob o'chirilgan bo'lsa — neytral matn.
 */
export function actorName(actor: { name: string | null } | null | undefined, via?: string | null): string {
  if (actor?.name) return actor.name;
  if (via === "scheduler") return "Rejalashtiruvchi";
  if (via === "system") return "Tizim";
  return actor ? "Noma'lum foydalanuvchi" : "Foydalanuvchi yo'q";
}

/** "Aziz · Yordamchi ulagich" — manba `web` bo'lsa yoki noma'lum bo'lsa ko'rsatilmaydi (odatiy holat jim). */
export function changedByText(actor: { name: string | null } | null | undefined, via?: string | null): string {
  const name = actorName(actor, via);
  if (!via || via === "web") return name;
  // Foydalanuvchi yo'q (rejalashtiruvchi/tizim yoki ulagich) — "Foydalanuvchi yo'q · X" o'rniga faqat manba.
  if (!actor) return viaLabel(via);
  return `${name} · ${viaLabel(via)}`;
}

/** "Aziz" / "Aziz · Yordamchi ulagich" yoki `null` (kim o'zgartirgani ma'lum emas va manba odatiy) — "Oxirgi o'zgarish" qatori uchun. */
export function lastChangeText(actor: { name: string | null } | null | undefined, via: string | null | undefined): string | null {
  if (!actor && !via) return null;
  if (!actor && via === "web") return null;
  return changedByText(actor, via);
}
