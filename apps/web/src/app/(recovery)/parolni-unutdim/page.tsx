import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/auth-shell";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";

export const metadata: Metadata = {
  title: "Parolni unutdingizmi?",
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  return (
    <AuthShell subtitle="Parolni unutdingizmi?">
      <ForgotPasswordForm />
    </AuthShell>
  );
}
