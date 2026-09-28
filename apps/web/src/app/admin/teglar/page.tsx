import { headers } from "next/headers";
import type { Metadata } from "next";
import { TagsTable } from "@/components/admin/tags-table";
import { getAdminTags } from "@/lib/api";

export const metadata: Metadata = { title: "Teglar" };

export default async function AdminTagsPage() {
  const headersList = await headers();
  const tags = await getAdminTags(headersList.get("cookie"));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Teglar</h1>
        <p className="mt-1 text-sm text-muted-foreground">Postlarni mavzu bo&apos;yicha guruhlash uchun teglar.</p>
      </div>

      <TagsTable initialTags={tags} />
    </div>
  );
}
