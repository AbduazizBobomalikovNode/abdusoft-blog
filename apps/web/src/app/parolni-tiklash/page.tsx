import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/auth-shell";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";

// Manzilda bir martalik token bo'lishi mumkin: Referer yuborilmaydi (sahifa header'i `src/proxy.ts`da ham qo'yiladi),
// qidiruv tizimlariga yopiq, tashqi resurslar yo'q.
export const metadata: Metadata = {
  title: "Yangi parol o'rnatish",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function ResetPasswordPage() {
  return (
    <AuthShell subtitle="Yangi parol o'rnatish">
      <ResetPasswordForm />
    </AuthShell>
  );
}
