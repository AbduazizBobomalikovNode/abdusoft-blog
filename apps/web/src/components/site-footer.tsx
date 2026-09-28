import { getSite } from "@/lib/api";
import { site } from "@/lib/site";

export async function SiteFooter() {
  const year = new Date().getFullYear();
  const data = await getSite();

  const telegramUrl = data?.social.telegram || site.telegramUrl;
  const githubUrl = data?.social.github || site.githubUrl;

  const links = [
    telegramUrl ? { href: telegramUrl, label: "Telegram" } : null,
    githubUrl ? { href: githubUrl, label: "GitHub" } : null,
  ].filter((link) => link !== null);

  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex w-full max-w-[680px] flex-wrap items-center justify-between gap-2 px-4 py-6 text-sm text-muted-foreground">
        <span>
          &copy; {year} {site.name}. Barcha huquqlar himoyalangan.
        </span>
        {links.length > 0 ? (
          <div className="flex gap-3">
            {links.map((link) => (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-foreground"
              >
                {link.label}
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </footer>
  );
}
