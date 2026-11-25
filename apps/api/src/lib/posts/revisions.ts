import { and, asc, desc, eq, sql } from "drizzle-orm";
import { config } from "../../config.js";
import { postRevisions, postTags, tags } from "../../db/schema.js";
import type { Executor, PostRow } from "./shared.js";
import type { Actor } from "./types.js";

export type RevisionReason =
  | "update"
  | "publish"
  | "unpublish"
  | "archive"
  | "schedule"
  | "trash"
  | "restore-revision";

async function tagSlugsOf(executor: Executor, postId: string): Promise<string[]> {
  const rows = await executor
    .select({ slug: tags.slug })
    .from(postTags)
    .innerJoin(tags, eq(postTags.tagId, tags.id))
    .where(eq(postTags.postId, postId))
    .orderBy(asc(tags.slug));
  return rows.map((row) => row.slug);
}

/**
 * Oddiy tahrirdan OLDIN surat kerakmi? Ha, agar: postda hali revision yo'q; oxirgisi `POST_REVISION_INTERVAL_MINUTES`dan
 * eski; yoki oxirgisini BOSHQA aktyor yoki BOSHQA kanal (`via`) yaratgan — shunda AI va inson tahrirlari bir-biriga qo'shilib ketmaydi.
 */
export async function shouldSnapshotForUpdate(executor: Executor, postId: string, actor: Actor, now: Date): Promise<boolean> {
  const [latest] = await executor
    .select({ createdAt: postRevisions.createdAt, createdBy: postRevisions.createdBy, via: postRevisions.via })
    .from(postRevisions)
    .where(eq(postRevisions.postId, postId))
    .orderBy(desc(postRevisions.seq))
    .limit(1);
  if (!latest) return true;
  if ((latest.createdBy ?? null) !== (actor.userId ?? null) || latest.via !== actor.via) return true;
  return now.getTime() - latest.createdAt.getTime() >= config.POST_REVISION_INTERVAL_MINUTES * 60_000;
}

/**
 * Postning JORIY holatini (o'zgartirishdan oldin) revision sifatida saqlaydi va eng eskilarini o'chiradi
 * (`POST_REVISION_MAX_PER_POST`; eng yangisi hech qachon o'chirilmaydi). `actor` — keyingi yozuvni bajaruvchi.
 */
export async function snapshotPost(executor: Executor, post: PostRow, actor: Actor, reason: RevisionReason): Promise<void> {
  await executor.insert(postRevisions).values({
    postId: post.id,
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt,
    contentJson: post.contentJson,
    coverUrl: post.coverUrl,
    tagSlugs: await tagSlugsOf(executor, post.id),
    settings: post.settings ?? {},
    status: post.status,
    createdBy: actor.userId,
    via: actor.via,
    reason,
    createdAt: new Date(),
  });

  const keep = Math.max(1, config.POST_REVISION_MAX_PER_POST);
  await executor.delete(postRevisions).where(
    and(
      eq(postRevisions.postId, post.id),
      sql`${postRevisions.seq} not in (select ${postRevisions.seq} from ${postRevisions} where ${postRevisions.postId} = ${post.id} order by ${postRevisions.seq} desc limit ${keep})`,
    ),
  );
}
