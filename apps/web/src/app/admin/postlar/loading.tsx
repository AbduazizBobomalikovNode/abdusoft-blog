import { AdminListSkeleton } from "@/components/admin/admin-list-skeleton";

export default function Loading() {
  return <AdminListSkeleton title="Postlar" rows={10} />;
}
