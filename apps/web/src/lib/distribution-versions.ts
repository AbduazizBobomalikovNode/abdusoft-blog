import { DISTRIBUTION_VERSION_MAX_PER_CHANNEL, type DistributionImageChoice, type DistributionItemDto, type DistributionLinkMode, type DistributionProviderId, type DistributionVersionDto } from "@blog/shared";

/** Kanal paneli: nomli matn versiyalari uchun sof yordamchilar (React'siz, sinovga qulay). */

export type VersionSaveState = "idle" | "saving" | "saved" | "error";

export function versionsOf(all: readonly DistributionVersionDto[], provider: DistributionProviderId): DistributionVersionDto[] {
  return all.filter((v) => v.provider === provider);
}

export function primaryOf(versions: readonly DistributionVersionDto[]): DistributionVersionDto | null {
  return versions.find((v) => v.isPrimary) ?? null;
}

/**
 * Dialog ochilganda qaysi versiya tanlanadi: asosiy bor va qator tahrirlanadigan holatda (qoralama/xato/rejalashtirilgan yoki hali
 * yo'q) bo'lsa — asosiy; aks holda `null` ("Standart": avvalgi xatti-harakat). Yuborilgan/yuborilayotgan qatorlar o'zgarmaydi.
 */
export function initialVersionId(versions: readonly DistributionVersionDto[], item: DistributionItemDto | null, canEdit: boolean): string | null {
  if (!canEdit) return null;
  if (item?.versionId && versions.some((v) => v.id === item.versionId) && item.status !== "sent") return item.versionId;
  return primaryOf(versions)?.id ?? null;
}

export function canAddVersion(versions: readonly DistributionVersionDto[]): boolean {
  return versions.length < DISTRIBUTION_VERSION_MAX_PER_CHANNEL;
}

export function versionLimitText(versions: readonly DistributionVersionDto[]): string {
  return `${versions.length}/${DISTRIBUTION_VERSION_MAX_PER_CHANNEL}`;
}

/** Tahrirlagichdagi qiymatlar saqlangan versiyadan farq qiladimi (autosave kerakmi). */
export function isVersionDirty(version: DistributionVersionDto, editor: { text: string; imageChoice: DistributionImageChoice; linkMode: DistributionLinkMode | null }): boolean {
  return version.text !== editor.text || version.imageChoice !== editor.imageChoice || version.linkMode !== editor.linkMode;
}

export function saveStateLabel(state: VersionSaveState): string {
  if (state === "saving") return "Saqlanmoqda…";
  if (state === "saved") return "Saqlandi";
  if (state === "error") return "Saqlanmadi";
  return "";
}

/** Ro'yxatdagi versiyani yangilangani bilan almashtiradi (asosiy belgisi boshqa versiyalarda saqlanadi). */
export function replaceVersion(list: readonly DistributionVersionDto[], updated: DistributionVersionDto): DistributionVersionDto[] {
  return list.map((v) => (v.id === updated.id ? updated : updated.isPrimary ? { ...v, isPrimary: false } : v));
}

export function markPrimary(list: readonly DistributionVersionDto[], id: string | null): DistributionVersionDto[] {
  return list.map((v) => ({ ...v, isPrimary: v.id === id }));
}

export function removeVersion(list: readonly DistributionVersionDto[], id: string): DistributionVersionDto[] {
  return list.filter((v) => v.id !== id);
}

/** Tahrir paytida "Standart" yozuvidagi (tanlanmagan) holat uchun yorliq. */
export const DEFAULT_ENTRY_LABEL = "Standart";
