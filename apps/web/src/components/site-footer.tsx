import { getSite } from "@/lib/api";
import { buildFooterLinks } from "@/lib/footer-links";
import { site } from "@/lib/site";

export async function SiteFooter() {
  const year = new Date().getFullYear();
  const data = await getSite();

  const links = buildFooterLinks(data?.social, site);

  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex w-full max-w-[680px] flex-wrap items-center justify-between gap-2 px-4 py-6 text-sm text-muted-foreground">
        <span>
          &copy; {year} {site.name}. Barcha huquqlar himoyalangan.
        </span>
        {links.length > 0 ? (
          <div className="flex gap-3">
            {links.map((link) =>
              link.href ? (
                <a
                  key={link.label}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-foreground"
                >
                  {link.label}
                </a>
              ) : (
                <span key={link.label}>{link.label}</span>
              ),
            )}
          </div>
        ) : null}
      </div>
    </footer>
  );
}
