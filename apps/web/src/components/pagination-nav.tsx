import Link from "next/link";

interface PaginationNavProps {
  /** Joriy sahifa uchun URLSearchParams asosidagi bazaviy query (page'siz). */
  baseQuery: Record<string, string | undefined>;
  basePath: string;
  page: number;
  hasMore: boolean;
}

function buildHref(basePath: string, query: Record<string, string | undefined>, page: number) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value) search.set(key, value);
  }
  if (page > 1) search.set("page", String(page));
  const qs = search.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/** "Yana yuklash" — keyingi sahifaga server-rendered link (JS'siz ishlaydi). */
export function PaginationNav({ baseQuery, basePath, page, hasMore }: PaginationNavProps) {
  if (!hasMore) return null;

  return (
    <div className="flex justify-center pt-2">
      <Link
        href={buildHref(basePath, baseQuery, page + 1)}
        className="rounded-full border border-border px-4 py-1.5 font-mono text-sm text-muted-foreground hover:border-foreground/30 hover:text-foreground"
      >
        Yana yuklash
      </Link>
    </div>
  );
}
