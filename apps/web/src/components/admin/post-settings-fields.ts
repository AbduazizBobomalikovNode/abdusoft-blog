import type { PostSettings } from "@blog/shared";

export interface SettingSwitchDef {
  key: keyof PostSettings;
  label: string;
  hint: string;
}

/** `PostSettings`dagi har bir maydon uchun Uzbek label + qisqa izoh — post tahrirlagich va sayt sozlamalarida qayta ishlatiladi. */
export const SETTING_SWITCHES: SettingSwitchDef[] = [
  { key: "commentsEnabled", label: "Izohlar", hint: "Post ostida izoh qoldirish imkoniyati" },
  { key: "reactionsEnabled", label: "Reaksiyalar", hint: "Layk/dizlayk tugmalari ko'rsatiladi" },
  { key: "showDislike", label: "Dizlaykni ko'rsatish", hint: "Layk bilan birga dizlayk soni ham chiqadi" },
  { key: "showViews", label: "Ko'rishlar soni", hint: "Post ostida ko'rishlar soni ko'rsatiladi" },
  { key: "showToc", label: "Mundarija", hint: "Uzun postlarda mundarija ko'rsatiladi" },
  { key: "telegraphMirror", label: "Telegraph nusxa", hint: "Post Telegraph'ga ham nusxalanadi" },
  { key: "channelAutoPost", label: "Kanalga avtomatik post", hint: "Chop etilganda Telegram kanaliga yuboriladi" },
  { key: "allowAnonymousComments", label: "Anonim izohlar", hint: "Ro'yxatdan o'tmagan foydalanuvchilar izoh qoldira oladi" },
  { key: "commentsRequireApproval", label: "Izohlarni moderatsiya qilish", hint: "Izohlar avval tasdiqlanishi kerak" },
];
