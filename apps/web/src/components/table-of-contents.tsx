import type { TocItem } from "@blog/shared";

/**
 * Mobil: sahifa boshida yopiq <details> ("Mundarija"). md..xl: oqimdagi oddiy
 * (sticky emas) blok. xl+ (`rail` yoqilgan bo'lsa): matn ustunidan tashqarida,
 * o'ng tomondagi rail'da sticky — ustun o'rni/kengligi o'zgarmaydi (rail
 * absolute, oqimga ta'sir qilmaydi). `rail` ota `relative` konteyner talab
 * qiladi (post sahifasidagi <article>).
 */
export function TableOfContents({ toc, rail = false }: { toc: TocItem[]; rail?: boolean }) {
  if (toc.length === 0) return null;

  const items = (
    <ol className="flex flex-col gap-1.5">
      {toc.map((item) => (
        <li key={item.id} className={item.level === 3 ? "pl-3" : undefined}>
          <a href={`#${item.id}`} className="text-muted-foreground hover:text-foreground">
            {item.text}
          </a>
        </li>
      ))}
    </ol>
  );

  const heading = (
    <p className="mb-2 font-medium tracking-wide text-foreground uppercase">Mundarija</p>
  );

  return (
    <>
      <details className="rounded-lg border border-border px-3 py-2 font-mono text-xs md:hidden">
        <summary className="cursor-pointer font-medium text-foreground select-none">
          Mundarija
        </summary>
        <div className="mt-2">{items}</div>
      </details>
      <nav
        aria-label="Mundarija"
        className={`hidden rounded-lg border border-border px-3 py-2.5 font-mono text-xs md:block${rail ? " xl:hidden" : ""}`}
      >
        {heading}
        {items}
      </nav>
      {rail ? (
        <div className="absolute top-0 bottom-0 left-full ml-8 hidden w-56 xl:block">
          <nav
            aria-label="Mundarija"
            className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto overscroll-contain rounded-lg border border-border px-3 py-2.5 font-mono text-xs"
          >
            {heading}
            {items}
          </nav>
        </div>
      ) : null}
    </>
  );
}
