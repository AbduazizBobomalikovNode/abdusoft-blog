import { Skeleton } from "@/components/ui/skeleton";

/** Admin ro'yxat sahifalari (`loading.tsx`) uchun umumiy jadval skeleton'i. */
export function AdminListSkeleton({ rows = 8, title }: { rows?: number; title?: string }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {title ? <h1 className="text-xl font-semibold tracking-tight">{title}</h1> : <Skeleton className="h-7 w-32" />}
        <Skeleton className="h-9 w-48" />
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="flex flex-col divide-y divide-border">
          {Array.from({ length: rows }).map((_, index) => (
            <div key={index} className="flex items-center gap-4 px-4 py-3">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-4 w-1/6" />
              <Skeleton className="ml-auto h-4 w-16" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
