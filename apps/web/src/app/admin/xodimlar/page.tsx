import { headers } from "next/headers";
import type { Metadata } from "next";
import { XodimlarClient } from "@/components/admin/xodimlar-client";
import { requireAdminPage } from "@/lib/admin-guard";
import { getAdminStaff } from "@/lib/api";

export const metadata: Metadata = { title: "Xodimlar" };

export default async function AdminStaffPage() {
  const headersList = await headers();
  const cookie = headersList.get("cookie");
  await requireAdminPage(cookie);

  const data = await getAdminStaff(cookie);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Xodimlar</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Yordamchi xodimlar GitHub orqali kiradi va postlarini siz tasdiqlaganingizdan keyin sayt/kanalga chiqadi.
        </p>
      </div>

      <XodimlarClient initialStaff={data?.staff ?? []} initialInvites={data?.invites ?? []} />
    </div>
  );
}
