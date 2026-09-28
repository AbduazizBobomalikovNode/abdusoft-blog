import Link from "next/link";
import type { Metadata } from "next";
import { getTags } from "@/lib/api";

export const revalidate = 60;

export const metadata: Metadata = {
  title: "Teglar",
};

export default async function TagsPage() {
  const tags = await getTags();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Teglar</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Mavzu bo&apos;yicha postlarni ko&apos;ring.
        </p>
      </div>

      {tags.length === 0 ? (
        <p className="text-sm text-muted-foreground">Hali birorta teg yaratilmagan.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {tags.map((tag) => (
            <li key={tag.id} className="flex flex-col gap-1 py-3 first:pt-0">
              <Link
                href={`/teglar/${tag.slug}`}
                className="flex items-baseline justify-between gap-2 hover:underline"
              >
                <span className="font-medium">{tag.name}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {tag.postsCount} ta post
                </span>
              </Link>
              {tag.description ? (
                <p className="text-sm text-muted-foreground">{tag.description}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
