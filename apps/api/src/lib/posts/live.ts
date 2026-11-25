import { and, eq, isNull, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { posts } from "../../db/schema.js";

/** `posts` ustidagi har qanday o'qish shu shartni qo'shadi: chiqindi qutisidagi postlar hech qayerda ko'rinmaydi. */
export function livePosts(): SQL {
  return isNull(posts.deletedAt);
}

/**
 * Post ID ustuni boshqa jadvalda (izoh, ko'rish, reaksiya...) bo'lgan so'rovlar uchun: shu post chiqindi qutisida
 * BO'LMASLIGI sharti (`posts`ga join qilmasdan, count/groupBy so'rovlarini buzmaydi).
 */
export function postNotTrashed(postIdColumn: AnyColumn): SQL {
  return sql`not exists (select 1 from ${posts} as trashed_post where trashed_post.id = ${postIdColumn} and trashed_post.deleted_at is not null)`;
}

/** Ommaviy o'qishlar uchun: chop etilgan VA chiqindi qutisida bo'lmagan post. */
export function publishedLive(): SQL {
  return and(eq(posts.status, "published"), isNull(posts.deletedAt))!;
}
