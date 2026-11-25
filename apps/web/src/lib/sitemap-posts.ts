/** API `GET /posts` uchun ruxsat etilgan eng katta sahifa hajmi (`apps/api` `MAX_LIMIT`). */
export const SITEMAP_PAGE_SIZE = 50;

/** Cheksiz aylanishdan himoya: 200 sahifa × 50 = 10 000 post. */
export const SITEMAP_MAX_PAGES = 200;

interface PostsPage<T> {
  items: T[];
  hasMore: boolean;
}

/**
 * Barcha chop etilgan postlarni sahifalab yig'adi. Tartib API qaytargan tartibda
 * saqlanadi (birinchi sahifa avvalgi `limit: 50` natijasi bilan bir xil). Sahifalar
 * orasida post siljib qolsa, takrorlar `getKey` bo'yicha olib tashlanadi. Birinchi
 * sahifa xato bo'lsa — bo'sh ro'yxat (avvalgi xatti-harakat); keyingi sahifa xato
 * bo'lsa — shu paytgacha yig'ilgani qaytariladi.
 */
export async function fetchAllPostPages<T>(
  fetchPage: (page: number, limit: number) => Promise<PostsPage<T> | null>,
  getKey: (item: T) => string,
  options: { pageSize?: number; maxPages?: number } = {},
): Promise<T[]> {
  const pageSize = options.pageSize ?? SITEMAP_PAGE_SIZE;
  const maxPages = options.maxPages ?? SITEMAP_MAX_PAGES;

  const result: T[] = [];
  const seen = new Set<string>();

  for (let page = 1; page <= maxPages; page += 1) {
    const data = await fetchPage(page, pageSize);
    if (!data) break;

    for (const item of data.items) {
      const key = getKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(item);
    }

    if (!data.hasMore || data.items.length === 0) break;
  }

  return result;
}
