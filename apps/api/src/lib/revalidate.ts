import { config } from "../config.js";

/**
 * Web ilovadagi Next.js cache'ni yangilash uchun `POST /api/revalidate` ga
 * so'rov yuboradi. Fire-and-forget — javobni kutmaydi va xatoliklar postlar
 * bilan bog'liq so'rovlarni to'xtatmasligi kerak, shuning uchun faqat log
 * qilinadi.
 */
export function revalidateWeb(paths: string[]): void {
  if (paths.length === 0) return;

  if (!config.REVALIDATE_SECRET) {
    console.warn("REVALIDATE_SECRET o'rnatilmagan — web cache yangilanmadi:", paths);
    return;
  }

  fetch(`${config.WEB_ORIGIN}/api/revalidate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-revalidate-secret": config.REVALIDATE_SECRET,
    },
    body: JSON.stringify({ paths }),
  })
    .then((res) => {
      if (!res.ok) {
        console.error(`Revalidate so'rovi muvaffaqiyatsiz (${res.status}):`, paths);
      }
    })
    .catch((error: unknown) => {
      console.error("Revalidate so'rovida xatolik:", error);
    });
}

/** Berilgan post/teglar uchun tegishli ommaviy yo'llarni tuzadi. */
export function pathsForPost(slug: string, tagSlugs: string[] = []): string[] {
  const paths = new Set<string>(["/", `/${slug}`]);
  for (const tag of tagSlugs) {
    paths.add(`/teglar/${tag}`);
  }
  paths.add("/teglar");
  paths.add("/rss.xml");
  return [...paths];
}
