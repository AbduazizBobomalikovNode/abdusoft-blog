import { headers } from "next/headers";
import type { Metadata } from "next";
import { ConnectionsClient } from "@/components/admin/connections-client";
import { requireAdminPage } from "@/lib/admin-guard";
import { getAdminConnections } from "@/lib/api";

export const metadata: Metadata = { title: "Ulangan ilovalar" };

export default async function AdminConnectionsPage() {
  const headersList = await headers();
  const cookie = headersList.get("cookie");
  await requireAdminPage(cookie);

  const data = await getAdminConnections(cookie);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Ulangan ilovalar</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Blogingizga ulangan Claude va boshqa ilovalar. Istalganini bir bosishda uzishingiz mumkin — u darhol kirish huquqini yo&apos;qotadi.
        </p>
      </div>

      <ConnectionsClient initial={data?.items ?? null} />
    </div>
  );
}
