import type { TocItem } from "@blog/shared";

/**
 * Mobil: sahifa boshida yopiq <details> ("Mundarija"). Desktop: maqola
 * ustunining o'zi ichida sticky joylashgan holat (bitta markazlashgan
 * ustun dizayn talabini buzmaydi).
 */
export function TableOfContents({ toc }: { toc: TocItem[] }) {
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
        className="sticky top-20 hidden rounded-lg border border-border px-3 py-2.5 font-mono text-xs md:block"
      >
        <p className="mb-2 font-medium tracking-wide text-foreground uppercase">Mundarija</p>
        {items}
      </nav>
    </>
  );
}
