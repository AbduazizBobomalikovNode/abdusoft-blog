import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/admin-shell";
import { getAdminCommentPendingCount, getMe } from "@/lib/api";
import "@/styles/admin-editor.css";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const headersList = await headers();
  const cookie = headersList.get("cookie");
  const me = await getMe(cookie);

  if (!me) {
    redirect("/login");
  }

  const pendingComments = await getAdminCommentPendingCount(cookie);

  return (
    <AdminShell me={me} pendingComments={pendingComments}>
      {children}
    </AdminShell>
  );
}
