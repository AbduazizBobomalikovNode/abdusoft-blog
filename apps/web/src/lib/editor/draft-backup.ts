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
    return b as DraftBackup;
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
