import Link from "next/link";
import { headers } from "next/headers";
import type { Metadata } from "next";
import { ScrollText } from "lucide-react";
import { AuditFilters, AuditViaTabs } from "@/components/admin/audit-filters";
import { EmptyState } from "@/components/admin/empty-state";
import { ViaBadge } from "@/components/admin/via-badge";
import { PaginationNav } from "@/components/pagination-nav";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireAdminPage } from "@/lib/admin-guard";
import { actorName, auditActionLabel, isAutomatedVia, VIA_VALUES } from "@/lib/admin-labels";
import { getAdminAudit, getAdminPost, getAdminPosts } from "@/lib/api";
import { auditFieldsText, auditHref, auditTarget, type AuditQueryState } from "@/lib/audit-view";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Jurnal" };

const PAGE_SIZE = 30;

function oneOf(value: string | undefined, allowed: readonly string[]): string | undefined {
  return value && allowed.includes(value) ? value : undefined;
}

function dateOnly(value: string | undefined): string | undefined {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ via?: string; entityType?: string; entityId?: string; action?: string; from?: string; to?: string; page?: string }>;
}) {
  const params = await searchParams;
  const state: AuditQueryState = {
    via: oneOf(params.via, VIA_VALUES),
    entityType: params.entityType?.trim() || undefined,
    entityId: params.entityId?.trim() || undefined,
    action: params.action?.trim() || undefined,
    from: dateOnly(params.from),
    to: dateOnly(params.to),
  };
  const page = Number(params.page) > 0 ? Number(params.page) : 1;

  const headersList = await headers();
  const cookie = headersList.get("cookie");
  await requireAdminPage(cookie);

  const data = await getAdminAudit({ ...state, page, limit: PAGE_SIZE }, cookie);
  const items = data?.items ?? [];

  // Postlarga havola faqat post HALI MAVJUD bo'lsa: ro'yxatdan (bitta so'rov), topilmaganlar alohida tekshiriladi.
  const postIds = [...new Set(items.filter((item) => item.entityType === "post" && item.entityId).map((item) => item.entityId as string))];
  const existing = new Map<string, string>();
  if (postIds.length > 0) {
    const list = await getAdminPosts({ status: "all", limit: 100 }, cookie);
    for (const post of list?.items ?? []) existing.set(post.id, post.title);
    const missing = postIds.filter((id) => !existing.has(id));
    const found = await Promise.all(missing.map((id) => getAdminPost(id, cookie).catch(() => null)));
    found.forEach((post) => {
      if (post) existing.set(post.id, post.title);
    });
  }

  const scopedPostTitle = state.entityType === "post" && state.entityId ? existing.get(state.entityId) : undefined;
  const filtersActive = !!(state.via || state.entityType || state.action || state.from || state.to || state.entityId);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Jurnal</h1>
          <p className="mt-1 text-sm text-muted-foreground">Kim, qayerdan va nima qilgani — barcha o&apos;zgarishlar tarixi.</p>
        </div>
        <AuditFilters state={state} />
      </div>

      <AuditViaTabs state={state} />

      {state.entityId ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm" data-testid="audit-scope">
          <span className="text-muted-foreground">Faqat shu obyekt:</span>
          {scopedPostTitle ? (
            <Link href={`/admin/postlar/${state.entityId}`} className="font-medium hover:underline">
              {scopedPostTitle}
            </Link>
          ) : (
            <span className="font-mono text-xs">{state.entityId}</span>
          )}
          <Link href={auditHref(state, { entityId: undefined, entityType: undefined })} className="ml-auto text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline max-md:min-h-11 max-md:content-center">
            Hammasini ko&apos;rsatish
          </Link>
        </div>
      ) : null}

      {data === null ? (
        <EmptyState icon={ScrollText} message="Jurnalni yuklab bo'lmadi. Keyinroq qayta urinib ko'ring." />
      ) : items.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          message={filtersActive ? "Tanlangan filtrlar bo'yicha yozuv topilmadi." : "Jurnal hali bo'sh. O'zgarishlar shu yerda ko'rinadi."}
          action={
            filtersActive ? (
              <Link href="/admin/jurnal" className="rounded-full border border-border px-4 py-1.5 text-sm text-muted-foreground hover:border-foreground/30 hover:text-foreground max-md:min-h-11 max-md:content-center">
                Filtrlarni tozalash
              </Link>
            ) : undefined
          }
        />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">Jami: {data.total}</p>

          {/* Mobil kartalar */}
          <ul className="flex flex-col gap-2 md:hidden" aria-label="Jurnal yozuvlari">
            {items.map((item) => {
              const target = auditTarget(item, existing);
              const automated = isAutomatedVia(item.via);
              return (
                <li
                  key={item.id}
                  data-testid="audit-row"
                  data-via={item.via}
                  className={cn("flex flex-col gap-1.5 rounded-lg border border-border p-3", automated && "border-l-4 border-l-violet-500/60")}
                >
                  <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                    <span className="text-sm font-medium">{auditActionLabel(item.action)}</span>
                    <ViaBadge via={item.via} />
                  </div>
                  <p className="text-sm break-words">{item.summary}</p>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span>{actorName(item.actor, item.via)}</span>
                    <span aria-hidden>·</span>
                    <time dateTime={item.createdAt}>{formatDateTime(item.createdAt)}</time>
                    <span aria-hidden>·</span>
                    {target.href ? (
                      <Link href={target.href} className="text-foreground hover:underline">
                        {target.kind}: {target.title}
                      </Link>
                    ) : (
                      <span>
                        {target.kind}
                        {target.gone ? " (endi yo'q)" : ""}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          {/* Desktop jadval */}
          <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Vaqt</TableHead>
                  <TableHead>Kim</TableHead>
                  <TableHead>Manba</TableHead>
                  <TableHead>Amal</TableHead>
                  <TableHead>Obyekt</TableHead>
                  <TableHead>Qisqacha</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => {
                  const target = auditTarget(item, existing);
                  const automated = isAutomatedVia(item.via);
                  const fields = auditFieldsText(item.meta);
                  return (
                    <TableRow key={item.id} data-testid="audit-row" data-via={item.via} className={cn(automated && "bg-violet-500/[0.04]")}>
                      <TableCell className={cn("text-xs whitespace-nowrap text-muted-foreground", automated && "shadow-[inset_4px_0_0_0] shadow-violet-500/60")}>
                        <time dateTime={item.createdAt}>{formatDateTime(item.createdAt)}</time>
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap">{actorName(item.actor, item.via)}</TableCell>
                      <TableCell>
                        <ViaBadge via={item.via} />
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap">{auditActionLabel(item.action)}</TableCell>
                      <TableCell className="max-w-48 text-sm">
                        {target.href ? (
                          <Link href={target.href} className="block truncate hover:underline" title={target.title ?? undefined}>
                            <span className="text-muted-foreground">{target.kind}: </span>
                            {target.title}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">
                            {target.kind}
                            {target.gone ? " (endi yo'q)" : ""}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs whitespace-normal text-muted-foreground">
                        <div className="w-72 max-w-72">
                          <span className="line-clamp-2 break-words" title={item.summary}>
                            {item.summary}
                          </span>
                          {fields ? <span className="mt-0.5 block truncate font-mono text-[0.65rem]">{fields}</span> : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      {data ? (
        <PaginationNav
          basePath="/admin/jurnal"
          baseQuery={{ via: state.via, entityType: state.entityType, entityId: state.entityId, action: state.action, from: state.from, to: state.to }}
          page={page}
          hasMore={data.hasMore}
        />
      ) : null}
    </div>
  );
}
