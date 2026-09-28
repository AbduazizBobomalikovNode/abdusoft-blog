import { headers } from "next/headers";
import type { Metadata } from "next";
import { MediaGrid } from "@/components/admin/media-grid";
import { getAdminMedia } from "@/lib/api";

export const metadata: Metadata = { title: "Media" };

const PAGE_LIMIT = 60;

export default async function AdminMediaPage() {
  const headersList = await headers();
  const data = await getAdminMedia({ page: 1, limit: PAGE_LIMIT }, headersList.get("cookie"));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Media</h1>
        <p className="mt-1 text-sm text-muted-foreground">Rasmlarni yuklang va boshqaring.</p>
      </div>

      <MediaGrid initialItems={data?.items ?? []} initialHasMore={data?.hasMore ?? false} />
    </div>
  );
}
