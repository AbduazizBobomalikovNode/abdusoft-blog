import type { DistributionLinkMode, DistributionProviderId, XThreadSplit } from "@blog/shared";

/** Barcha preview kartalar uchun umumiy kirish: matn mahalliy (har tugma bosilishida), qolgani serverdan. */
export interface SocialPreviewModel {
  provider: DistributionProviderId;
  /** Hozirgi (tahrirlanayotgan) matn — to'g'ridan-to'g'ri textarea holatidan. */
  text: string;
  /** Platforma chegarasi (`null` — chegara yo'q). */
  limit: number | null;
  authorName: string;
  authorHandle: string | null;
  postUrl: string;
  postTitle: string;
  /** Serverda tanlangan rasm (yo'q yoki xato bo'lsa `null`). */
  imageUrl: string | null;
  linkMode: DistributionLinkMode | null;
  /** Faqat X zanjiri: `splitXThread` natijasi (API yuboradigan bo'laklarning aynan o'zi). Bor bo'lsa X kartasi tvitlar zanjirini chizadi. */
  thread?: XThreadSplit | null;
}
