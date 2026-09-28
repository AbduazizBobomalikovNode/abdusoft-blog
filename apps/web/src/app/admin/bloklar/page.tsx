import { headers } from "next/headers";
import type { Metadata } from "next";
import { BansTable } from "@/components/admin/bans-table";
import { requireAdminPage } from "@/lib/admin-guard";
import { getAdminBans } from "@/lib/api";

export const metadata: Metadata = { title: "Bloklar" };

export default async function AdminBansPage() {
  const headersList = await headers();
  await requireAdminPage(headersList.get("cookie"));
  const data = await getAdminBans(headersList.get("cookie"));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Bloklar</h1>
        <p className="mt-1 text-sm text-muted-foreground">Fikr bildirishdan bloklangan qurilmalar.</p>
      </div>

      <BansTable initialBans={data?.items ?? []} />
    </div>
  );
}
