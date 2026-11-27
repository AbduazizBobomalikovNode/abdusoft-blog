import { and, desc, eq, inArray } from "drizzle-orm";
import { ACTIVE_DISTRIBUTION_STATUSES, type DistributionErrorKindDto, type DistributionImageChoice, type DistributionItemDto, type DistributionLinkMode, type DistributionProviderId } from "@blog/shared";
import { db } from "../../../db/index.js";
import { distributions } from "../../../db/schema.js";

export type DistributionRow = typeof distributions.$inferSelect;

export async function getActiveDistribution(postId: string, provider: string): Promise<DistributionRow | null> {
  const [row] = await db
    .select()
    .from(distributions)
    .where(and(eq(distributions.postId, postId), eq(distributions.provider, provider), inArray(distributions.status, [...ACTIVE_DISTRIBUTION_STATUSES])))
    .limit(1);
  return row ?? null;
}

export async function getDistribution(id: string): Promise<DistributionRow | null> {
  const [row] = await db.select().from(distributions).where(eq(distributions.id, id)).limit(1);
  return row ?? null;
}

export async function getLatestSent(postId: string, provider: string): Promise<DistributionRow | null> {
  const [row] = await db
    .select()
    .from(distributions)
    .where(and(eq(distributions.postId, postId), eq(distributions.provider, provider), eq(distributions.status, "sent")))
    .orderBy(desc(distributions.sentAt))
    .limit(1);
  return row ?? null;
}

export async function listForPost(postId: string): Promise<DistributionRow[]> {
  return db.select().from(distributions).where(eq(distributions.postId, postId)).orderBy(desc(distributions.createdAt));
}

export function toItemDto(row: DistributionRow): DistributionItemDto {
  return {
    id: row.id,
    postId: row.postId,
    provider: row.provider as DistributionProviderId,
    status: row.status,
    text: row.text,
    sentText: row.sentText,
    imageChoice: row.imageChoice as DistributionImageChoice,
    linkMode: (row.linkMode as DistributionLinkMode | null) ?? null,
    xThread: row.xThread,
    xThreadNumbering: row.xThreadNumbering,
    threadPosted: row.threadIds?.length ?? 0,
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    attempts: row.attempts,
    lastErrorKind: (row.lastErrorKind as DistributionErrorKindDto | null) ?? null,
    lastErrorMessage: row.lastErrorMessage,
    externalId: row.externalId,
    externalUrl: row.externalUrl,
    step: row.step,
    versionId: row.versionId,
    planDelayMinutes: row.planDelayMinutes,
    planMaterializedAt: row.planMaterializedAt?.toISOString() ?? null,
    canResume: Boolean(row.partial && Object.keys(row.partial).length > 0) || (row.threadIds?.length ?? 0) > 0,
    createdBy: row.createdBy,
    createdVia: row.createdVia,
    sentAt: row.sentAt?.toISOString() ?? null,
    removedAt: row.removedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
