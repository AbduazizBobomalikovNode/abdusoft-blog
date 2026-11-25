import { headers } from "next/headers";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ChangePasswordForm } from "@/components/admin/change-password-form";
import { getMe } from "@/lib/api";

export const metadata: Metadata = { title: "Akkaunt" };

/** Admin ham, xodim (staff) ham o'z hisobini shu yerda boshqaradi — rol tekshiruvi kerak emas. */
export default async function AdminAccountPage() {
  const headersList = await headers();
  const me = await getMe(headersList.get("cookie"));
  if (!me) redirect("/login");

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Akkaunt</h1>
        <p className="mt-1 text-sm text-muted-foreground">Sizning hisobingiz va parolingiz.</p>
      </div>

      <ChangePasswordForm email={me.email} />
    </div>
  );
}
