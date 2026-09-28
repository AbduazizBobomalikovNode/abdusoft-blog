import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createAdminPostServer } from "@/lib/api";

export default async function NewPostPage() {
  const headersList = await headers();
  const created = await createAdminPostServer(headersList.get("cookie"));

  if (!created) {
    redirect("/admin/postlar");
  }

  redirect(`/admin/postlar/${created.id}`);
}
