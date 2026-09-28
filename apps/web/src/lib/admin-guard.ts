import { redirect } from "next/navigation";
import { getMe } from "@/lib/api";

/**
 * Faqat admin uchun sahifalar (Fikrlar, Bloklar, Teglar, Sozlamalar,
 * Statistika, Xodimlar) — API bu marshrutlarni allaqachon 403 bilan
 * himoya qiladi, lekin xodim (staff) shu sahifaga bevosita kirsa
 * bo'sh/xato holat ko'rmasin uchun serverda oldindan yo'naltiramiz.
 */
export async function requireAdminPage(cookieHeader: string | null): Promise<void> {
  const me = await getMe(cookieHeader);
  if (me?.role !== "admin") {
    redirect("/admin/postlar");
  }
}
