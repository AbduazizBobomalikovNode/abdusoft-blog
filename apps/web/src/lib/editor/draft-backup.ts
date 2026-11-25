/**
 * Mahalliy qoralama zaxirasi (localStorage). Har bir post uchun alohida kalit;
 * zaxira serverdagi qaysi `updatedAt` asosida yaratilgani bilan saqlanadi.
 * Muvaffaqiyatli saqlashdan keyin zaxira o'chiriladi — shuning uchun qolgan zaxira = saqlanmagan o'zgarishlar.
 */

export interface DraftBackup {
  v: 1;
  postId: string;
  /** Zaxira asoslangan serverdagi `updatedAt`. */
  baseUpdatedAt: string;
  /** Zaxira yozilgan vaqt (ms). */
  savedAt: number;
  title: string;
  contentJson: unknown;
  /**
   * Ixtiyoriy (eski zaxiralarda yo'q): saqlanmagan maydon kalitlari. Yo'q bo'lsa — eskicha: faqat `title` va `contentJson`.
   * Bor bo'lsa, tiklashda FAQAT shu maydonlar qaytariladi.
   */
  dirty?: string[];
  /** Ixtiyoriy: `title`/`contentJson`dan boshqa saqlanmagan maydonlar qiymati (`excerpt`, `tagSlugs`, `coverUrl`, `slug`, `settings`, `pinned`, `channelPlan`). */
  extra?: Record<string, unknown>;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const backupKey = (postId: string) => `blog:draft:${postId}`;

export function saveBackup(storage: StorageLike | null, backup: DraftBackup): boolean {
  if (!storage) return false;
  try {
    storage.setItem(backupKey(backup.postId), JSON.stringify(backup));
    return true;
  } catch {
    return false; // kvota to'lgan yoki taqiqlangan — tahrirlagich ishlashda davom etadi
  }
}

export function loadBackup(storage: StorageLike | null, postId: string): DraftBackup | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(backupKey(postId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const b = parsed as Partial<DraftBackup>;
    if (b.v !== 1 || b.postId !== postId || typeof b.savedAt !== "number" || typeof b.title !== "string" || typeof b.baseUpdatedAt !== "string") return null;
    const backup = b as DraftBackup;
    // Yangi ixtiyoriy maydonlar: noto'g'ri shaklda bo'lsa tashlab yuboriladi (eski zaxira sifatida yuklanadi).
    if (!Array.isArray(backup.dirty) || !backup.dirty.every((k) => typeof k === "string")) delete backup.dirty;
    if (!backup.extra || typeof backup.extra !== "object" || Array.isArray(backup.extra)) delete backup.extra;
    return backup;
  } catch {
    return null;
  }
}

export function clearBackup(storage: StorageLike | null, postId: string): void {
  try {
    storage?.removeItem(backupKey(postId));
  } catch {
    /* e'tiborsiz */
  }
}

export interface ServerCopy {
  updatedAt: string;
  title: string;
  contentJson: unknown;
}

/** Zaxira serverdagi nusxadan yangiroq VA undan farq qilsa — tiklashni taklif qilamiz. */
export function shouldOfferRestore(backup: DraftBackup | null, server: ServerCopy): boolean {
  if (!backup) return false;
  if (backup.savedAt <= Date.parse(server.updatedAt)) return false;
  return backup.title !== server.title || JSON.stringify(backup.contentJson) !== JSON.stringify(server.contentJson);
}

/** Server nusxasi zaxira asosidan keyin ham o'zgargan (boshqa qurilma/tab) — tiklash ustiga yozadi. */
export function serverChangedSinceBackup(backup: DraftBackup, server: ServerCopy): boolean {
  return Date.parse(server.updatedAt) > Date.parse(backup.baseUpdatedAt);
}

export function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Zaxirada qaytarilishi mumkin bo'lgan maydonlar (kalit -> o'zbekcha nom). */
export const BACKUP_FIELD_LABELS: Record<string, string> = {
  title: "Sarlavha",
  contentJson: "Matn",
  slug: "Havola (slug)",
  excerpt: "Qisqa tavsif",
  coverUrl: "Muqova rasmi",
  tagSlugs: "Teglar",
  settings: "Sozlamalar",
  pinned: "Muhim belgisi",
  channelPlan: "Kanal rejasi",
};

/** Zaxira qaytaradigan maydon kalitlari: `dirty` bo'lsa shu, bo'lmasa (eski format) `title` va `contentJson`. */
export function backupFieldKeys(backup: DraftBackup): string[] {
  const keys = backup.dirty ?? ["title", "contentJson"];
  return keys.filter((key) => key in BACKUP_FIELD_LABELS);
}

/** Zaxiradagi maydon qiymati. */
export function backupValue(backup: DraftBackup, key: string): unknown {
  if (key === "title") return backup.title;
  if (key === "contentJson") return backup.contentJson;
  return backup.extra?.[key];
}

function sameValue(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Serverdagi nusxa (to'liq): zaxira maydonlarini solishtirish uchun. */
export interface ServerFields {
  title: string;
  slug: string;
  excerpt: string | null;
  coverUrl: string | null;
  tags: { slug: string }[];
  contentJson: unknown;
  settings: Record<string, unknown>;
  pinned: boolean;
  channelPlan?: unknown;
}

function serverValue(server: ServerFields, key: string): unknown {
  switch (key) {
    case "tagSlugs":
      return server.tags.map((t) => t.slug).sort();
    case "excerpt":
      return server.excerpt ?? "";
    default:
      return (server as unknown as Record<string, unknown>)[key];
  }
}

/** Zaxiradagi qaysi maydonlar serverdagi nusxadan farq qiladi (tiklash taklifida ko'rsatiladi). */
export function backupDiffKeys(backup: DraftBackup, server: ServerFields): string[] {
  return backupFieldKeys(backup).filter((key) => {
    const mine = backupValue(backup, key);
    if (key === "tagSlugs") return !sameValue([...((mine as string[]) ?? [])].sort(), serverValue(server, key));
    if (key === "settings") {
      return Object.entries((mine as Record<string, unknown>) ?? {}).some(([k, v]) => !sameValue(v, server.settings[k]));
    }
    if (key === "excerpt") return (mine ?? "") !== serverValue(server, key);
    return !sameValue(mine, serverValue(server, key));
  });
}

export function backupFieldLabels(keys: string[]): string[] {
  return keys.map((key) => BACKUP_FIELD_LABELS[key] ?? key);
}
