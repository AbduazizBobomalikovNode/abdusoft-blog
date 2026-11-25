import { describe, expect, it, vi } from "vitest";
import { SITEMAP_PAGE_SIZE, fetchAllPostPages } from "./sitemap-posts";

interface Item {
  slug: string;
}

/** `total` ta postli soxta API: `page`/`limit` bo'yicha kesadi. */
function fakeApi(total: number, maxLimit = SITEMAP_PAGE_SIZE) {
  const all: Item[] = Array.from({ length: total }, (_, i) => ({ slug: `post-${i + 1}` }));
  return vi.fn(async (page: number, limit: number) => {
    if (limit > maxLimit) throw new Error(`limit ${limit} exceeds API max ${maxLimit}`);
    const start = (page - 1) * limit;
    return { items: all.slice(start, start + limit), hasMore: page * limit < total };
  });
}

const key = (item: Item) => item.slug;

describe("fetchAllPostPages", () => {
  it("pages through every post and keeps the API order", async () => {
    const api = fakeApi(120);
    const items = await fetchAllPostPages(api, key);

    expect(items).toHaveLength(120);
    expect(items.map(key)).toEqual(Array.from({ length: 120 }, (_, i) => `post-${i + 1}`));
    expect(api).toHaveBeenCalledTimes(3);
    expect(api.mock.calls.map(([page, limit]) => [page, limit])).toEqual([
      [1, 50],
      [2, 50],
      [3, 50],
    ]);
  });

  it("makes a single request when everything fits on the first page", async () => {
    const api = fakeApi(7);
    const items = await fetchAllPostPages(api, key);
    expect(items).toHaveLength(7);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("handles an exact multiple of the page size", async () => {
    const api = fakeApi(100);
    expect(await fetchAllPostPages(api, key)).toHaveLength(100);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("returns an empty list when there are no posts or the first page fails", async () => {
    expect(await fetchAllPostPages(fakeApi(0), key)).toEqual([]);
    expect(await fetchAllPostPages(async () => null, key)).toEqual([]);
  });

  it("keeps what it already has when a later page fails", async () => {
    const api = vi.fn(async (page: number) =>
      page === 1
        ? { items: [{ slug: "a" }, { slug: "b" }], hasMore: true }
        : null,
    );
    expect((await fetchAllPostPages(api, key)).map(key)).toEqual(["a", "b"]);
  });

  it("drops duplicates caused by posts shifting between pages", async () => {
    const pages = [
      { items: [{ slug: "a" }, { slug: "b" }], hasMore: true },
      { items: [{ slug: "b" }, { slug: "c" }], hasMore: false },
    ];
    const items = await fetchAllPostPages(async (page) => pages[page - 1] ?? null, key);
    expect(items.map(key)).toEqual(["a", "b", "c"]);
  });

  it("stops at maxPages and on an empty page even if hasMore is true", async () => {
    const endless = vi.fn(async (page: number) => ({ items: [{ slug: `p${page}` }], hasMore: true }));
    expect(await fetchAllPostPages(endless, key, { maxPages: 3 })).toHaveLength(3);

    const empty = vi.fn(async () => ({ items: [] as Item[], hasMore: true }));
    expect(await fetchAllPostPages(empty, key)).toEqual([]);
    expect(empty).toHaveBeenCalledTimes(1);
  });
});
